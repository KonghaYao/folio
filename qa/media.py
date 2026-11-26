"""Exercise actual audio/video decoders, PDF attachment opening, files and downloads."""

import argparse
from io import BytesIO
import json
import math
from pathlib import Path
import struct
import tempfile
import time
import wave

from playwright.sync_api import expect, sync_playwright
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

from draw import OUTPUT, chromium


def fixtures():
    tone = BytesIO()
    with wave.open(tone, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(
            b"".join(
                struct.pack("<h", int(1000 * math.sin(i * math.tau * 220 / 8000)))
                for i in range(8000)
            )
        )
    document = BytesIO()
    pdf = PdfWriter()
    for fill in (b"1 0 0", b"0 0 1"):
        page = pdf.add_blank_page(width=200, height=200)
        content = DecodedStreamObject()
        content.set_data(fill + b" rg 20 20 160 160 re f")
        page[NameObject("/Contents")] = pdf._add_object(content)
    pdf.write(document)
    return [
        ("tone.wav", "audio/wav", tone.getvalue()),
        (
            "flight.webm",
            "video/webm",
            (Path(__file__).parent / "fixtures" / "clip.webm").read_bytes(),
        ),
        ("sheet.pdf", "application/pdf", document.getvalue()),
        ("readme.txt", "text/plain", "Canvas attachment.\n".encode()),
    ]


def run(url):
    OUTPUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as folder, sync_playwright() as pw:
        browser = chromium(pw)
        page = browser.new_page(viewport={"width": 1000, "height": 760}, accept_downloads=True)
        page.goto(url)
        expect(page.locator("#app")).to_have_attribute("data-ready", "true")
        files = []
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        for n, (name, mime, data) in enumerate(fixtures(), 1):
            page.locator("[data-action=insert]").click()
            with page.expect_file_chooser() as chooser:
                page.locator("[data-action=attach]").click()
            chooser.value.set_files({"name": name, "mimeType": mime, "buffer": data})
            expect(page.locator("#object-count")).to_have_text(f"{n} 个对象")
            box = page.locator("#board-surface").bounding_box()
            page.mouse.dblclick(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            dialog = page.locator("dialog.folio-asset-dialog")
            expect(dialog.get_by_role("heading")).to_have_text(name)
            result = {"name": name, "type": mime, "bytes": len(data)}
            if mime.startswith(("video", "audio")):
                tag = mime.split("/")[0]
                player = dialog.locator(tag)
                page.wait_for_function(
                    "(tag) => document.querySelector('dialog '+tag)?.readyState>=2", arg=tag
                )
                assert player.get_attribute("controls") is not None
                result["duration"] = player.evaluate("m=>m.duration")
                assert 0.8 < result["duration"] < 1.2
                # Use the browser's native media widget to start playback.
                if tag == "audio":
                    player.click(position={"x": 22, "y": 25})
                else:
                    player.press("Space")
                page.wait_for_function(
                    "(tag) => document.querySelector('dialog '+tag)?.currentTime > 0.05", arg=tag
                )
                result["played"] = True
                if tag == "video":
                    result["dimensions"] = player.evaluate("m=>[m.videoWidth,m.videoHeight]")
                    assert result["dimensions"] == [96, 64]
            elif mime == "application/pdf":
                native = page.evaluate("navigator.pdfViewerEnabled")
                result["browserPdfViewerEnabled"] = native
                if native and not dialog.locator("[data-pdf-page]").count():
                    iframe = dialog.locator("iframe")
                    expect(iframe).to_have_attribute("title", name)
                    page.wait_for_function(
                        "document.querySelector('dialog iframe').src.startsWith('blob:')"
                    )
                    result["previewIframeLoadedDocumentUrl"] = True
                else:
                    preview = dialog.locator("[data-pdf-page]")
                    expect(preview).to_be_visible()

                    def page_color(rgb):
                        deadline = time.monotonic() + 8
                        while time.monotonic() < deadline:
                            image = Image.open(BytesIO(preview.screenshot())).convert("RGB")
                            color = image.getpixel((image.width // 2, image.height // 2))
                            if max(abs(a - b) for a, b in zip(rgb, color)) < 8:
                                return color
                            page.wait_for_timeout(90)
                        raise AssertionError(("PDF page failed to render", rgb, color))

                    color1 = page_color((255, 0, 0))
                    dialog.locator("[data-pdf-next]").click()
                    color2 = page_color((0, 0, 255))
                    dialog.locator("[data-pdf-prev]").click()
                    assert page_color((255, 0, 0)) == color1
                    result["renderedPageCenterRgb"] = [color1, color2]
                    result["pageNavigationRoundTrip"] = True
            with page.expect_download() as download:
                dialog.get_by_role("link", name="下载原文件").click()
            path = Path(folder) / name
            download.value.save_as(path)
            assert path.read_bytes() == data
            result["downloadIdentical"] = True
            files.append(result)
            dialog.get_by_role("button", name="关闭").click()
        page.reload()
        expect(page.locator("#object-count")).to_have_text("4 个对象")
        assert not errors, errors
        result = {
            "browser": browser.version,
            "files": files,
            "reloadedObjects": 4,
            "pageErrors": errors,
        }
        (OUTPUT / "media.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    run(parser.parse_args().url)
