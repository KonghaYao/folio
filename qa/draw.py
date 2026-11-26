"""Drive a real Chromium pen through the studio UI, then verify a durable reload.

Run against an available Folio instance. Dependencies listed in requirements.txt.
CHROMIUM_PATH can override Playwright's managed Chromium executable.
"""

import argparse
import hashlib
import json
import math
import os
import time
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageChops
from playwright.sync_api import expect, sync_playwright
from pelican import artwork
from studio import number_input, click_action, choose_tool, set_ink_width

OUTPUT = Path(__file__).resolve().parents[1] / "evidence"


def chromium(p):
    override = os.environ.get("CHROMIUM_PATH")
    return p.chromium.launch(
        executable_path=override, headless=True, args=["--disable-gpu", "--disable-dev-shm-usage"]
    )


def wait_for_durable(page):
    """Wait on the user-visible save indicator and confirm via fresh network read."""
    expect(page.locator("#app")).to_have_attribute("data-ready", "true")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=15000)
    page.wait_for_timeout(300)


class Brush:
    def __init__(self, page, context):
        self.page = page
        self.session = context.new_cdp_session(page)
        self.color = None
        self.width = None
        self.records = []

    def tools(self, color, width):
        page = self.page
        if self.color != color or self.width != width:
            color_control = page.locator("#ink-color")
            if not color_control.is_visible():
                choose_tool(page, "pen")
            if self.color != color:
                color_control.fill(color)
                self.color = color
            if self.width != width:
                set_ink_width(page, width)
                self.width = width

    def draw(self, points, tilt, index, width, color):
        pressure_min = 1
        pressure_max = 0
        twist = index * 7 % 359
        for i, (x, y) in enumerate(points):
            progress = i / max(1, len(points) - 1)
            pressure = 0.76 + 0.13 * math.sin(progress * math.pi) + 0.015 * math.sin(i * 0.9)
            tx = round(tilt * (0.8 + 0.2 * math.sin(progress * 2 * math.pi)))
            ty = round(-tilt * 0.6)
            self.session.send(
                "Input.dispatchMouseEvent",
                dict(
                    type="mousePressed" if i == 0 else "mouseMoved",
                    x=round(x, 2),
                    y=round(y, 2),
                    button="left",
                    buttons=1,
                    clickCount=int(i == 0),
                    pointerType="pen",
                    force=round(pressure, 3),
                    tiltX=tx,
                    tiltY=ty,
                    twist=twist,
                ),
            )
            pressure_min = min(pressure, pressure_min)
            pressure_max = max(pressure, pressure_max)
        self.session.send(
            "Input.dispatchMouseEvent",
            dict(
                type="mouseReleased",
                x=round(x, 2),
                y=round(y, 2),
                pointerType="pen",
                button="left",
                buttons=0,
                force=0,
                clickCount=1,
            ),
        )
        self.records.append(
            {
                "gesture": index,
                "samplesSent": len(points),
                "widthSetting": width,
                "color": color,
                "tiltXPeak": tilt,
                "tiltY": ty,
                "twist": twist,
                "pressureRange": [round(pressure_min, 3), round(pressure_max, 3)],
            }
        )


def snapshot(page):
    # Read-only corroboration of the UI. Every art mutation is performed as pen input.
    board_id = parse_qs(urlparse(page.url).query)["board"][0]
    return page.request.get("/api/boards/" + board_id).json()


def ink_items(doc):
    return [
        v
        for v in doc["items"].values()
        if isinstance(v, dict) and isinstance(v.get("props"), dict) and "ink" in v["props"]
    ]


def paint(url):
    OUTPUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = chromium(p)
        context = browser.new_context(
            base_url=url,
            viewport={"width": 1440, "height": 940},
            device_scale_factor=1,
            accept_downloads=True,
        )
        page = context.new_page()
        if os.environ.get("QA_TRACE"):
            context.tracing.start(screenshots=True, snapshots=False)
        page.set_default_timeout(6000)
        failures = []
        page.on("pageerror", lambda e: failures.append(str(e)))
        page.goto(url)
        surface = page.locator('[data-testid="board-surface"]')
        expect(surface).to_be_visible(timeout=15000)
        expect(page.locator("#board-title")).not_to_have_text("正在打开画板")
        page.locator("[data-action=board-menu]").click()
        page.get_by_role("button", name="重命名", exact=False).click()
        title_form = page.get_by_role("dialog")
        title_form.get_by_role("textbox").fill("海岸骑行 · 鹈鹕")
        title_form.get_by_role("textbox").press("Enter")
        expect(page.locator("#board-title")).to_have_text("海岸骑行 · 鹈鹕")
        choose_tool(page, "pen")
        bounds = surface.bounding_box()
        scale = min(1.65, (bounds["width"] - 380) / 530, (bounds["height"] - 205) / 398)
        left = bounds["x"] + bounds["width"] * 0.525 - 350 * scale
        top = bounds["y"] + bounds["height"] * 0.50 - 250 * scale
        brush = Brush(page, context)
        started = time.monotonic()
        gestures = artwork()
        frame_dir = tempfile.TemporaryDirectory()
        frames = Path(frame_dir.name)

        def frame(index):
            page.screenshot(path=frames / f"{index:04d}.jpg", quality=80, animations="disabled")

        capture = bool(shutil.which("ffmpeg"))
        if capture:
            frame(0)
        frame_index = 0
        for index, stroke in enumerate(gestures, 1):
            width = round(max(1, stroke.width * scale), 1)
            brush.tools(stroke.color, width)
            points = [(left + x * scale, top + y * scale) for x, y in stroke.points]
            brush.draw(points, stroke.tilt, index, width, stroke.color)
            if capture and index % 6 == 0:
                frame_index += 1
                frame(frame_index)
            if index % 25 == 0:
                print("Real pen gestures", index, "of", len(gestures), flush=True)
        choose_tool(page, "select")
        page.mouse.move(20, 20)
        wait_for_durable(page)
        doc = snapshot(page)
        before = ink_items(doc)
        assert len(before) >= len(gestures), (
            len(before),
            len(gestures),
            list(doc["items"].values())[:1],
        )
        # Use the same viewport command before and after reload; opening a board
        # automatically fits its bounds, while the drawing starts at 100%.
        click_action(page, "fit")
        page.mouse.move(20, 20)
        page.wait_for_timeout(450)
        page.screenshot(path=OUTPUT / "pelican-studio.png", animations="disabled")
        if capture:
            frame_index += 1
            frame(frame_index)
            subprocess.run(
                [
                    "ffmpeg",
                    "-loglevel",
                    "error",
                    "-y",
                    "-framerate",
                    "4",
                    "-i",
                    str(frames / "%04d.jpg"),
                    "-vf",
                    "tpad=stop_mode=clone:stop_duration=2,fps=24",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    str(OUTPUT / "drawing-timelapse.mp4"),
                ],
                check=True,
            )
        frame_dir.cleanup()
        raw = OUTPUT / "pelican-board.json"
        raw.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
        page.reload()
        expect(surface).to_be_visible()
        wait_for_durable(page)
        after = snapshot(page)
        assert doc["items"] == after["items"], "Reload changed the saved artwork"
        click_action(page, "fit")
        page.mouse.move(20, 20)
        page.wait_for_timeout(450)
        page.screenshot(path=OUTPUT / "pelican-reloaded.png", animations="disabled")
        crop = (
            int(left + 75 * scale),
            int(top + 41 * scale),
            int(left + 628 * scale),
            int(top + 452 * scale),
        )
        original = Image.open(OUTPUT / "pelican-studio.png").convert("RGB").crop(crop)
        loaded = Image.open(OUTPUT / "pelican-reloaded.png").convert("RGB").crop(crop)
        delta = ImageChops.difference(original, loaded)
        mean_difference = sum(
            sum(i * h for i, h in enumerate(ch.histogram())) for ch in delta.split()
        ) / (3 * delta.width * delta.height)
        # Export the editable drawing with the same menu a user clicks.
        page.locator("[data-action=more]").click()
        page.locator("[data-action=export]").click()
        with page.expect_download() as image_download:
            page.locator("[data-action=export-png]").click()
        image_download.value.save_as(OUTPUT / "pelican.png")
        with page.expect_download() as download:
            page.locator("[data-action=export-archive]").click()
        export = OUTPUT / "pelican.folio.json"
        download.value.save_as(export)
        recovered = json.loads(export.read_text())
        assert recovered["items"] == doc["items"], "Export lost or changed ink"
        samples = [row for shape in before for row in shape["props"]["ink"]["samples"]]
        evidence = {
            "browser": "Chromium " + browser.version,
            "mode": "headless",
            "transport": "CDP Input.dispatchMouseEvent / pen",
            "boardId": doc["id"],
            "title": doc.get("title"),
            "screenshot": "pelican-studio.png",
            "gestures": len(brush.records),
            "persistedInkObjects": len(before),
            "persistedInputSamples": len(samples),
            "recordedPressureRange": [
                min(row[2] for row in samples),
                max(row[2] for row in samples),
            ],
            "recordedTiltXRange": [min(row[3] for row in samples), max(row[3] for row in samples)],
            "recordedTiltYRange": [min(row[4] for row in samples), max(row[4] for row in samples)],
            "originalAndReloadedItemsEqual": True,
            "reloadCropMeanAbsolutePixelDifference": round(mean_difference, 5),
            "boardSha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
            "elapsedSeconds": round(time.monotonic() - started, 2),
            "uncaughtBrowserErrors": failures,
            "penLog": brush.records,
        }
        (OUTPUT / "pen-evidence.json").write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2)
        )
        print(json.dumps({k: v for k, v in evidence.items() if k != "penLog"}, ensure_ascii=False))
        if os.environ.get("QA_TRACE"):
            context.tracing.stop(path=OUTPUT / "pen-trace.zip")
        assert not failures, failures
        assert mean_difference < 2, "Artwork changed visibly on reload"
        assert evidence["recordedPressureRange"][0] < evidence["recordedPressureRange"][1]
        assert evidence["recordedTiltXRange"][1] > 0 and evidence["recordedTiltYRange"][0] < 0
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?", default="http://127.0.0.1:3000")
    paint(parser.parse_args().url)
