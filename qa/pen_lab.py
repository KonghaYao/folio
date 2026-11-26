"""Measure pressure, tilt direction and erasing through Chromium's actual input path."""

import argparse
import io
import json
import statistics

from PIL import Image
from playwright.sync_api import expect, sync_playwright
from draw import OUTPUT, chromium, ink_items, snapshot, wait_for_durable
from studio import click_action, choose_tool, set_ink_width


def gesture(cdp, x, top, bottom, pressure, tilt_x=0, tilt_y=0, barrel=0):
    for i in range(16):
        y = top + (bottom - top) * i / 15
        cdp.send(
            "Input.dispatchMouseEvent",
            {
                "type": "mousePressed" if i == 0 else "mouseMoved",
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 1,
                "pointerType": "pen",
                "clickCount": int(i == 0),
                "force": pressure,
                "tiltX": tilt_x,
                "tiltY": tilt_y,
                "twist": 15,
                "tangentialPressure": barrel,
            },
        )
    cdp.send(
        "Input.dispatchMouseEvent",
        {
            "type": "mouseReleased",
            "x": x,
            "y": bottom,
            "button": "left",
            "buttons": 0,
            "pointerType": "pen",
            "clickCount": 1,
            "force": 0,
        },
    )


def check_palm_and_pinch(page, cdp):
    def touch(kind, coords):
        points = [
            dict(id=i + 1, x=x, y=y, radiusX=14, radiusY=10) for i, (x, y) in enumerate(coords)
        ]
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})

    def pen(kind, x, y):
        down = kind != "mouseReleased"
        cdp.send(
            "Input.dispatchMouseEvent",
            dict(
                type=kind,
                x=x,
                y=y,
                pointerType="pen",
                button="left",
                buttons=int(down),
                clickCount=int(kind != "mouseMoved"),
                force=0.8 if down else 0,
                tiltX=15,
                tiltY=8,
            ),
        )

    choose_tool(page,"pen")
    zoom = page.locator("#zoom-value")
    initial = zoom.inner_text()
    previous_ids = set(snapshot(page)["items"])
    pen("mousePressed", 350, 260)
    pen("mouseMoved", 410, 260)
    touch("touchStart", [(565, 490), (610, 510)])
    touch("touchMove", [(535, 480), (640, 520)])
    pen("mouseMoved", 470, 260)
    touch("touchEnd", [])
    pen("mouseMoved", 540, 260)
    pen("mouseReleased", 540, 260)
    wait_for_durable(page)
    items = snapshot(page)["items"]
    new_ids = set(items) - previous_ids
    assert len(new_ids) == 1, "Palm added a second object or interrupted the stylus"
    samples = items[new_ids.pop()]["props"]["ink"]["samples"]
    assert max(row[0] for row in samples) >= 185 and max(abs(row[1]) for row in samples) < 1
    assert zoom.inner_text() == initial, "Resting fingers changed the camera while the pen was down"
    touch("touchStart", [(500, 400), (690, 400)])
    touch("touchMove", [(470, 400), (720, 400)])
    touch("touchMove", [(440, 400), (750, 400)])
    touch("touchEnd", [])
    expect(zoom).not_to_have_text(initial)
    final = zoom.inner_text()
    assert int(final.strip("%")) > int(initial.strip("%")) + 30
    wait_for_durable(page)
    assert items == snapshot(page)["items"], "Touch zoom changed drawing content"
    return {
        "zoomBefore": initial,
        "zoomAfter": final,
        "palmAddedInk": False,
        "simultaneousStylusPreserved": True,
        "pinchChangedInk": False,
    }


def run_lab(url):
    OUTPUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = chromium(p)
        ctx = browser.new_context(
            base_url=url,
            viewport={"width": 1280, "height": 820},
            device_scale_factor=1,
            has_touch=True,
        )
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda error: errors.append(str(error)))
        pg.goto(url)
        expect(pg.locator("[data-testid=board-surface]")).to_be_visible()
        expect(pg.locator("#board-title")).not_to_have_text("正在打开画板")
        choose_tool(pg, "pencil")
        pg.locator("#ink-color").fill("#263e36")
        set_ink_width(pg, 18)
        cdp = ctx.new_cdp_session(pg)
        variants = [
            ("light", 0.12, 0, 0, 0),
            ("heavy", 0.9, 0, 0, 0),
            ("side-x", 0.9, 65, 0, 0.4),
            ("side-y", 0.9, 0, 65, 0.4),
        ]
        widths = {}
        for i, (label, force, tx, ty, barrel) in enumerate(variants):
            gesture(cdp, 420 + i * 135, 315, 515, force, tx, ty, barrel)
        pg.mouse.move(10, 10)
        wait_for_durable(pg)
        image_bytes = pg.screenshot(path=OUTPUT / "pressure-tilt.png")
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        for i, (label, *_) in enumerate(variants):
            x = 420 + i * 135
            widths[label] = statistics.median(
                sum(max(image.getpixel((sample_x, y))) < 175 for sample_x in range(x - 64, x + 65))
                for y in range(365, 466)
            )
        doc = snapshot(pg)
        ink = ink_items(doc)
        assert len(ink) == 4, [len(ink), doc]
        assert widths["heavy"] > widths["light"] * 1.8, widths
        assert widths["side-x"] > widths["side-y"] * 1.7, widths
        assert max(s[3] for r in ink for s in r["props"]["ink"]["samples"]) == 65
        assert max(s[4] for r in ink for s in r["props"]["ink"]["samples"]) == 65
        samples = [sample for item in ink for sample in item["props"]["ink"]["samples"]]
        barrel_max = max(sample[6] for sample in samples)
        assert abs(barrel_max - 0.4) < 0.001, "Tangential pressure lost in saved samples"
        # Erase a single ink object, undo, redo and check persistence at each stage.
        choose_tool(pg, "eraser")
        pg.mouse.move(405, 405)
        pg.mouse.down()
        pg.mouse.move(435, 405, steps=8)
        pg.mouse.up()
        wait_for_durable(pg)
        assert len(ink_items(snapshot(pg))) == 3, "Eraser"
        click_action(pg, "undo")
        wait_for_durable(pg)
        assert len(ink_items(snapshot(pg))) == 4, "Undo"
        click_action(pg, "redo")
        wait_for_durable(pg)
        assert len(ink_items(snapshot(pg))) == 3, "Redo"
        result = {
            "browser": browser.version,
            "brush": "pencil",
            "widthSetting": 18,
            "rasterWidthCssPixels": widths,
            "inputVariants": [
                dict(zip(["name", "force", "tiltX", "tiltY", "tangentialPressure"], v))
                for v in variants
            ],
            "persistedPencilObjectsBeforeErase": 4,
            "tangentialPressureMaximum": round(barrel_max, 4),
            "eraserUndoRedoCounts": [3, 4, 3],
            "touchAndPalm": check_palm_and_pinch(pg, cdp),
            "uncaughtBrowserErrors": errors,
        }
        (OUTPUT / "pressure-tilt.json").write_text(json.dumps(result, indent=2))
        assert not errors, errors
        print(json.dumps(result, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("url", nargs="?", default="http://127.0.0.1:3000")
    run_lab(args.parse_args().url)
