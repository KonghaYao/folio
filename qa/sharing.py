"""Independent cookie jars exercise editor and viewer invite links through the UI."""

import argparse
import json

from playwright.sync_api import expect, sync_playwright
from draw import OUTPUT, chromium, ink_items, snapshot, wait_for_durable
from pen_lab import gesture
from studio import choose_tool


def open_invite(owner, role, browser, origin):
    owner.locator("[data-action=share]").click()
    dialog = owner.get_by_role("dialog")
    dialog.get_by_label("访问权限").select_option(role)
    dialog.get_by_role("button", name="生成邀请链接").click()
    link = dialog.get_by_label("邀请链接", exact=True)
    expect(link).to_be_visible()
    url = link.input_value()
    owner.keyboard.press("Escape")
    context = browser.new_context(base_url=origin, viewport={"width": 1280, "height": 820})
    page = context.new_page()
    page.goto(url)
    expect(page.locator("#app")).to_have_attribute("data-ready", "true")
    return page


def run_sharing(url):
    OUTPUT.mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = chromium(playwright)
        context = browser.new_context(base_url=url, viewport={"width": 1280, "height": 820})
        owner = context.new_page()
        owner.goto(url)
        expect(owner.locator("#app")).to_have_attribute("data-ready", "true")
        editor = open_invite(owner, "editor", browser, url)
        viewer = open_invite(owner, "viewer", browser, url)
        expect(viewer.locator("[data-tool=pen]")).to_be_disabled()
        expect(viewer.locator("#access-state")).to_have_text("仅查看")
        expect(editor.locator("[data-tool=pen]")).to_be_enabled()
        expect(editor.locator("[data-action=share]")).to_be_disabled()
        choose_tool(editor,"marker")
        gesture(editor.context.new_cdp_session(editor), 440, 280, 410, 0.75, 15, 8)
        for page in (owner, editor, viewer):
            expect(page.locator("#object-count")).to_have_text("1 个对象", timeout=10000)
        choose_tool(owner,"pencil")
        gesture(context.new_cdp_session(owner), 600, 300, 425, 0.6, -15, 5)
        for page in (owner, editor, viewer):
            expect(page.locator("#object-count")).to_have_text("2 个对象", timeout=10000)
            wait_for_durable(page)
        snapshots = [snapshot(page) for page in [owner, editor, viewer]]
        assert [board["role"] for board in snapshots] == ["owner", "editor", "viewer"]
        assert snapshots[0]["items"] == snapshots[1]["items"] == snapshots[2]["items"]
        assert sorted(record["props"]["ink"]["brush"] for record in ink_items(snapshots[0])) == [
            "marker",
            "pencil",
        ]
        count_before = len(ink_items(snapshots[0]))
        viewer.keyboard.press("p")
        gesture(viewer.context.new_cdp_session(viewer), 750, 350, 480, 0.8)
        wait_for_durable(viewer)
        assert len(ink_items(snapshot(viewer))) == count_before
        viewer.screenshot(path=OUTPUT / "viewer-sync.png")
        result = {
            "browser": browser.version,
            "independentContexts": 3,
            "observedRoles": [s["role"] for s in snapshots],
            "ownerMarkerAndPencilCount": count_before,
            "serverRecordsIdentical": True,
            "viewerPenDisabled": True,
            "viewerKeyboardAttemptChangedBoard": False,
            "editsPropagatedInBothDirections": True,
        }
        (OUTPUT / "collaboration.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?", default="http://127.0.0.1:3000")
    run_sharing(parser.parse_args().url)
