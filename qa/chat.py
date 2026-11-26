"""Exercise the real browser, Peri runtime, live canvas MCP, storage and second-device sync."""

import argparse
import io
import json
import re
import time

from PIL import Image, ImageChops
from playwright.sync_api import expect, sync_playwright

from chat_browser import (
    SURFACE,
    board_id,
    configure,
    folio_service,
    open_chat,
    ready,
    send,
    watch_rpc,
)
from chat_provider import (
    CANCEL_PROMPT,
    COLOR,
    CREATED,
    CREATE_PROMPT,
    DENIED,
    DENIED_PROMPT,
    FAIL_PROMPT,
    MODEL,
    READ,
    READ_PROMPT,
    UPDATED,
    UPDATE_PROMPT,
    provider,
)
from draw import OUTPUT, chromium, snapshot, wait_for_durable
from sharing import open_invite
from trusted_devices import pair


def rendered(page):
    return Image.open(io.BytesIO(page.locator(SURFACE).screenshot())).convert("RGB")


def changed_pixels(before, after):
    assert before.size == after.size
    # Ignore antialiasing noise while requiring a substantial visible edit.
    return sum(ImageChops.difference(before, after).convert("L").histogram()[15:])


def holds_key(page, key):
    return page.evaluate(
        """async key => {
        if ([...Object.values(localStorage), ...Object.values(sessionStorage)].some(v => String(v).includes(key))) return true;
        const request = r => new Promise((yes, no) => { r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error); });
        for (const info of await indexedDB.databases()) {
            const db = await request(indexedDB.open(info.name));
            try {
                for (const name of Array.from(db.objectStoreNames)) {
                    const rows = await request(db.transaction(name).objectStore(name).getAll());
                    if (JSON.stringify(rows).includes(key)) return true;
                }
            } finally { db.close(); }
        }
        return false;
    }""",
        key,
    )


def receives(page, response, scenario):
    panel = page.get_by_test_id("chat-panel")
    until = time.monotonic() + 40
    while time.monotonic() < until:
        if panel.get_by_text(response, exact=True).is_visible():
            expect(page.get_by_test_id("chat-stop")).to_be_hidden(timeout=15000)
            return
        error = page.get_by_test_id("chat-error").text_content()
        if error or scenario.errors:
            raise AssertionError((error, scenario.errors, scenario.turns[-2:]))
        page.wait_for_timeout(100)
    raise TimeoutError((panel.inner_text()[-600:], scenario.turns[-2:], scenario.errors))


def one_note(page, text, x, y):
    wait_for_durable(page)
    items = list(snapshot(page)["items"].values())
    assert len(items) == 1
    note = items[0]
    assert note["type"] == "note" and note["props"]["text"] == text
    assert note["x"] == x and note["y"] == y and note["props"]["color"] == COLOR
    return note


def run(bun):
    OUTPUT.mkdir(exist_ok=True)
    with provider() as (scenario, origin), folio_service(origin, bun) as (
        url,
        work,
    ), sync_playwright() as playwright:
        browser = chromium(playwright)
        owner_context = browser.new_context(base_url=url, viewport={"width": 1440, "height": 900})
        owner = owner_context.new_page()
        owner.goto(url)
        ready(owner)
        viewer = open_invite(owner, "viewer", browser, url)
        ready(viewer)
        assert snapshot(viewer)["role"] == "viewer"
        errors, rpc = [], []
        for page in (owner, viewer):
            page.on("pageerror", lambda error: errors.append(str(error)[:260]))
            watch_rpc(page, rpc)
        before_width = owner.locator(SURFACE).bounding_box()["width"]
        panel = open_chat(owner)
        configure(owner, origin, MODEL, scenario.key)
        canvas = owner.locator(SURFACE).bounding_box()
        side = panel.bounding_box()
        assert canvas["width"] < before_width and side["x"] >= canvas["x"] + canvas["width"] - 2, (
            canvas,
            side,
        )
        owner_before, viewer_before = rendered(owner), rendered(viewer)
        send(owner, CREATE_PROMPT)
        receives(owner, CREATED, scenario)
        expect(viewer.locator("#object-count")).to_have_text("1 个对象", timeout=15000)
        first = one_note(owner, "设备同步检查", 285, 218)
        assert one_note(viewer, "设备同步检查", 285, 218) == first
        pixels = [
            changed_pixels(owner_before, rendered(owner)),
            changed_pixels(viewer_before, rendered(viewer)),
        ]
        assert min(pixels) > 1000, pixels
        send(owner, UPDATE_PROMPT)
        receives(owner, UPDATED, scenario)
        latest = one_note(owner, "同步验证完成", 310, 235)
        assert latest["id"] == first["id"] == scenario.read_ids[-1]
        assert one_note(viewer, "同步验证完成", 310, 235) == latest
        owner.screenshot(path=OUTPUT / "chat-canvas.png")
        assert scenario.create_acks and scenario.update_acks
        assert any(turn["historyPresent"] for turn in scenario.turns if turn["scenario"] == 1)

        # Pair a third, mobile-sized browser through the normal device invitation.
        phone = browser.new_context(
            base_url=url,
            viewport={"width": 430, "height": 850},
            is_mobile=True,
            has_touch=True,
            device_scale_factor=1,
        ).new_page()
        phone.on("pageerror", lambda error: errors.append(str(error)[:260]))
        phone.goto(url)
        ready(phone)
        pair(owner, phone)
        phone_panel = open_chat(phone)
        expect(phone_panel.get_by_text(UPDATED, exact=True)).to_be_visible(timeout=10000)
        expect(phone.get_by_test_id("chat-settings")).to_be_in_viewport()
        phone.get_by_test_id("chat-settings").click()
        expect(phone.get_by_test_id("chat-key")).to_have_value("")
        phone.keyboard.press("Escape")
        phone.get_by_test_id("chat-close").click()
        expect(phone_panel).to_be_hidden()
        assert one_note(phone, "同步验证完成", 310, 235) == latest

        # Verify that a viewer can read the shared canvas but has a private transcript.
        viewer_panel = open_chat(viewer)
        expect(viewer_panel.get_by_text(CREATED, exact=True)).to_have_count(0)
        configure(viewer, origin, MODEL, scenario.key)
        send(viewer, READ_PROMPT)
        receives(viewer, READ, scenario)
        send(viewer, DENIED_PROMPT)
        receives(viewer, DENIED, scenario)
        assert scenario.denial_acks and scenario.read_acks
        assert one_note(viewer, "同步验证完成", 310, 235) == latest

        # Stop a real blocked provider stream. Subsequent use must recover.
        send(owner, CANCEL_PROMPT)
        wait = time.monotonic() + 20
        while not scenario.cancel_started.is_set() and time.monotonic() < wait:
            owner.wait_for_timeout(80)
        assert scenario.cancel_started.is_set()
        owner.get_by_test_id("chat-stop").click()
        expect(owner.get_by_test_id("chat-stop")).to_be_hidden(timeout=15000)
        scenario.release.set()
        expect(owner.get_by_test_id("chat-status")).to_contain_text("停止")
        send(owner, FAIL_PROMPT)
        expect(owner.get_by_test_id("chat-error")).to_have_text(re.compile(".+"), timeout=30000)
        expect(owner.get_by_test_id("chat-stop")).to_be_hidden(timeout=10000)
        assert scenario.failed_requests >= 1
        send(owner, READ_PROMPT)
        receives(owner, READ, scenario)
        expect(panel.get_by_text("延迟测试结束。", exact=True)).to_have_count(0)
        assert one_note(owner, "同步验证完成", 310, 235) == latest

        # The same principal can reopen completed messages; its credential must be reentered.
        owner.reload()
        ready(owner)
        open_chat(owner)
        expect(panel.get_by_text(UPDATED, exact=True)).to_be_visible()
        owner.get_by_test_id("chat-settings").click()
        expect(owner.get_by_test_id("chat-model")).to_have_value(MODEL)
        expect(owner.get_by_test_id("chat-url")).to_have_value(origin + "/v1")
        expect(owner.get_by_test_id("chat-key")).to_have_value("")
        owner.keyboard.press("Escape")
        assert not holds_key(owner, scenario.key) and not holds_key(viewer, scenario.key)
        assert all(
            scenario.key.encode() not in path.read_bytes()
            for path in work.iterdir()
            if path.is_file()
        )

        stranger = browser.new_context(base_url=url).new_page()
        stranger.goto(url)
        ready(stranger)
        forbidden = stranger.request.get("/api/boards/" + board_id(owner) + "/chat").status
        assert forbidden in (403, 404)
        assert rpc.count("result") >= 6, rpc
        assert not errors and not scenario.errors, (errors, scenario.errors)
        result = {
            "runtime": "@peri-code/sdk",
            "provider": "Local scripted OpenAI Chat Completions regression fixture",
            "chromium": browser.version,
            "configuredModel": MODEL,
            "modelCalls": len(scenario.turns),
            "privateHistoryReturnedToModel": True,
            "reverseMcpReplies": len(rpc),
            "modelReadThenUpdatedActualObjectId": True,
            "persistedNote": {k: latest[k] for k in ("id", "type", "x", "y")},
            "renderedChangedPixelsOwnerViewer": pixels,
            "secondBrowserSawSameNote": True,
            "pairedMobileHistorySyncedWithoutCredential": True,
            "readOnlyViewerRead": True,
            "readOnlyViewerWriteDenied": True,
            "privateHistoryForEachPrincipal": True,
            "unjoinedHistoryStatus": forbidden,
            "cancelledInFlight": True,
            "providerHttp401Reported": True,
            "subsequentTurnSucceeded": True,
            "historyReturnedAfterReload": True,
            "credentialMissingAfterReload": True,
            "credentialAbsentFromLocalStorageSessionStorageIndexedDBServerFiles": True,
            "pageErrors": errors,
            "providerFixtureErrors": scenario.errors,
        }
        (OUTPUT / "chat.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        browser.close()
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", help="Bun executable for the isolated Folio service")
    run(parser.parse_args().bun)
