"""Use real canvas pixels to verify one imported image survives an offline cold start."""

import argparse
from io import BytesIO
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time

from PIL import Image, ImageChops, ImageDraw
from playwright.sync_api import expect, sync_playwright

from draw import OUTPUT
from studio import click_action, number_input


def stamp():
    image = Image.new("RGB", (180, 120), (238, 45, 60))
    ImageDraw.Draw(image).rectangle((90, 0, 179, 119), (32, 74, 216))
    data = BytesIO()
    image.save(data, "PNG")
    return data.getvalue()


def measure(image):
    image = image.convert("RGB")
    colors = dict((pixel, n) for n, pixel in image.getcolors(maxcolors=image.width * image.height))
    blue = (32, 74, 216)
    delta = ImageChops.difference(image, Image.new("RGB", image.size, blue))
    r, g, b = delta.split()
    mask = ImageChops.lighter(ImageChops.lighter(r, g), b).point(
        lambda level: 255 if level == 0 else 0
    )
    box = mask.getbbox()
    fill = colors.get(blue, 0) / ((box[2] - box[0]) * (box[3] - box[1])) if box else 0
    return {
        "red": colors.get((238, 45, 60), 0),
        "blue": colors.get(blue, 0),
        "blueFillRatio": round(fill, 5),
    }


def verify_pixels(page, cropped=False):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        surface = page.locator("#board-surface .qd-canvas")
        observed = measure(Image.open(BytesIO(surface.screenshot())))
        if cropped:
            if (
                observed["red"] == 0
                and observed["blue"] > 1500
                and 0.76 < observed["blueFillRatio"] < 0.81
            ):
                return observed
        elif min(observed["red"], observed["blue"]) > 1500:
            return observed
        page.wait_for_timeout(80)
    raise AssertionError("Unexpected two-color or cropped image pixels: " + str(observed))


def run(url):
    OUTPUT.mkdir(exist_ok=True)
    with TemporaryDirectory(
        prefix="folio-image-profile-"
    ) as profile, TemporaryDirectory() as copies, sync_playwright() as pw:

        def launch():
            return pw.chromium.launch_persistent_context(
                profile,
                headless=True,
                executable_path=os.getenv("CHROMIUM_PATH"),
                viewport={"width": 1050, "height": 780},
                device_scale_factor=1,
                accept_downloads=True,
                args=["--disable-dev-shm-usage"],
            )

        ctx = launch()
        page = ctx.pages[0]
        page.goto(url)
        expect(page.locator("#app")).to_have_attribute("data-ready", "true")
        page.wait_for_function("!!navigator.serviceWorker.controller")

        def command(which):
            return page.locator("[data-action=" + which + "]:visible")

        command("insert").click()
        with page.expect_file_chooser() as choosing:
            command("attach").click()
        choosing.value.set_files(
            dict(name="board-swatch.png", mimeType="image/png", buffer=stamp())
        )
        expect(page.locator("#object-count")).to_have_text("1 个对象")
        online_before = verify_pixels(page)
        command("inspect").click()
        page.get_by_role("button", name="裁剪图片", exact=True).click()
        crop = page.get_by_role("dialog", name="裁剪图片")
        number_input(crop.get_by_role("slider", name="左边界"), 55)
        crop.get_by_role("checkbox", name="椭圆蒙版").check()
        crop.get_by_role("button", name="应用裁剪").click()
        cropped = verify_pixels(page, True)
        click_action(page, "undo")
        assert verify_pixels(page) == online_before
        click_action(page, "redo")
        assert verify_pixels(page, True) == cropped
        page.mouse.click(865, 220)
        command("more").click()
        command("export").click()
        with page.expect_download() as ready:
            command("export-archive").click()
        with page.expect_download() as png:
            command("export-png").click()
        exported = Path(copies) / "crop.png"
        png.value.save_as(exported)
        exported_pixels = measure(Image.open(exported))
        assert (
            exported_pixels["red"] == 0 and 0.76 < exported_pixels["blueFillRatio"] < 0.81
        ), exported_pixels
        archive = Path(copies) / "roundtrip.folio.json"
        ready.value.save_as(archive)
        page.get_by_role("button", name="关闭", exact=True).click()
        command("more").click()
        command("import").click()
        command("import-file").set_input_files(archive)
        command("import-submit").click()
        expect(page.locator("#board-title")).to_contain_text("副本")
        imported = page.url
        online_after = verify_pixels(page, True)
        page.reload()
        expect(page.locator("#app")).to_have_attribute("data-ready", "true")
        online_reloaded = verify_pixels(page, True)
        ctx.close()

        # This browser starts with an empty renderer and cannot read the HTTP asset.
        ctx = launch()
        ctx.set_offline(True)
        page = ctx.pages[0]
        page.goto(imported)
        expect(page.locator("#app")).to_have_attribute("data-ready", "true")
        expect(page.locator("#board-title")).to_contain_text("副本")
        expect(page.locator("#object-count")).to_have_text("1 个对象")
        offline = verify_pixels(page, True)
        assert online_reloaded == offline, (online_reloaded, offline)
        page.screenshot(path=OUTPUT / "offline-image.png")
        evidence = {
            "browser": ctx.browser.version,
            "originalCanvasPixels": online_before,
            "importedCanvasPixels": online_after,
            "afterOnlineReload": online_reloaded,
            "crop": {
                "leftPercent": 55,
                "ellipseMask": True,
                "undoRestoredBothColors": True,
                "redoRestoredBlueEllipse": True,
                "exportPng": exported_pixels,
            },
            "afterOfflineColdStart": offline,
            "colorsIdenticalAcrossColdStart": True,
        }
        ctx.close()
    (OUTPUT / "offline-images.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    run(parser.parse_args().url)
