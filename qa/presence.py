"""Follow a second browser's cursor, zoom and pan through live UI controls."""
import argparse
import json

from playwright.sync_api import expect, sync_playwright
from draw import OUTPUT, chromium, snapshot
from sharing import open_invite
from studio import click_action, choose_tool


def run(url):
    OUTPUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = chromium(p)
        leader = browser.new_context(base_url=url, viewport={"width": 1280, "height": 820}).new_page()
        leader.goto(url)
        expect(leader.locator("#app")).to_have_attribute("data-ready", "true")
        follower = open_invite(leader, "viewer", browser, url)
        initial = snapshot(leader)["rev"]
        peers = follower.locator("[data-action=participants]")
        expect(peers).to_be_visible(timeout=12000)
        expect(peers).to_have_attribute("aria-label", "协作者 1")
        leader.mouse.move(510, 370)
        marker = follower.locator(".peer-cursor")
        expect(marker).to_be_visible()
        follower.wait_for_timeout(350)
        first = marker.bounding_box()
        leader.mouse.move(790, 440)
        follower.wait_for_function("() => document.querySelector('.peer-cursor')?.getBoundingClientRect().x > 730")
        second = marker.bounding_box()
        assert second["x"] - first["x"] > 180

        peers.click()
        follower.locator("[data-follow]").click()
        expect(peers).to_contain_text("跟随中")
        for _ in range(3):
            click_action(leader, 'zoom-in')
        choose_tool(leader, 'hand')
        leader.mouse.move(580, 460)
        leader.mouse.down()
        leader.mouse.move(720, 520, steps=10)
        leader.mouse.up()
        leader.mouse.move(750, 510)
        zoom = leader.locator("#zoom-value").inner_text()
        expect(follower.locator("#zoom-value")).to_have_text(zoom, timeout=6000)
        follower.wait_for_timeout(400)
        position = follower.locator(".peer-cursor").bounding_box()
        assert abs(position["x"] - 750) < 5, position
        assert abs(position["y"] - 510) < 5, position
        follower.screenshot(path=str(OUTPUT/"presence-follow.png"))
        follower.mouse.move(780, 520)
        follower.mouse.wheel(0, -90)
        expect(peers).not_to_contain_text("跟随中")
        assert snapshot(follower)["rev"] == initial
        leader.close()
        expect(peers).to_be_hidden(timeout=30000)
        result = {"browser": browser.version, "independentContexts": 2, "roles": ["owner", "viewer"],
                  "cursorDeltaPixels": round(second["x"]-first["x"]), "followZoom": zoom,
                  "pannedCursorScreenErrorPixels": [round(abs(position["x"]-750),2), round(abs(position["y"]-510),2)],
                  "manualNavigationExitedFollow": True, "departedPeerDisappeared": True, "documentRevisionUnchanged": True}
        (OUTPUT/"presence-follow.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
        browser.close()


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("url", nargs="?", default="http://127.0.0.1:3000")
    run(args.parse_args().url)
