"""Opt-in Chromium limit probe for a quarter-million independently editable rectangles."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

import numpy as np
from PIL import Image
from io import BytesIO
from playwright.sync_api import expect, sync_playwright

from draw import chromium
from pen_lab import gesture
from perf_board import (
    atomic,
    build_digest,
    image_stats,
    new_page,
    open_view,
    wheel_test,
)
from perf_fixture import Device, compact, service
from perf_matrix import process_tree
from studio import choose_tool, click_action

COUNT = 250_000
COLUMNS = 625
ROOT = Path(__file__).resolve().parents[1]


def shape(index):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    value = index
    key = ""
    for _ in range(4):
        value, remainder = divmod(value, 36)
        key = digits[remainder] + key
    col, row = index % COLUMNS, index // COLUMNS
    return {
        "id": "g" + key,
        "typeName": "shape",
        "type": "geo",
        "x": col * 32 + col % 3,
        "y": row * 32 + row % 3,
        "z": 0,
        "rot": 0,
        "props": {
            "w": 22,
            "h": 22,
            "color": "blue" if (col + 2 * row) % 3 else "red",
            "fill": "solid",
        },
    }


def seed_board(owner):
    board = owner.api("/api/boards", {"title": "250,000 editable rectangles"})
    path = "/api/boards/" + board["id"]
    rev = board["rev"]
    total = 0
    checksum = hashlib.sha256()
    for first in range(0, COUNT, 2000):
        put = {}
        for i in range(first, min(first + 2000, COUNT)):
            item = shape(i)
            raw = compact(item)
            total += len(raw)
            checksum.update(raw + b"\n")
            put[item["id"]] = item
        rev = owner.api(
            path + "/ops", {"opId": f"seed-{first}", "baseRev": rev, "put": put}
        )["rev"]
    assert total < 32 * 1048576 - 8192
    return path, rev, total, checksum.hexdigest()


def ink_pixels(page):
    raw = page.screenshot(clip={"x": 611, "y": 333, "width": 28, "height": 111})
    return np.asarray(Image.open(BytesIO(raw)).convert("RGB"), dtype=np.int16)


def probe(args):
    result = {
        "records": COUNT,
        "columns": COLUMNS,
        "rows": COUNT // COLUMNS,
        "spacing": 32,
        "rectangleWidth": 22,
        "fixture": "compact colored geometry",
        "artifactSha256": build_digest(args.app),
        "passed": False,
    }

    def mark(phase):
        result["phase"] = phase
        atomic(args.out, result)

    try:
        mark("seed")
        with service(args.app) as origin, sync_playwright() as playwright:
            owner = Device(origin)
            viewer = Device(origin)
            start = time.perf_counter()
            path, rev, total, digest = seed_board(owner)
            result.update(
                seedSeconds=round(time.perf_counter() - start, 2),
                itemBytes=total,
                initialSha256=digest,
            )
            token = owner.api(path + "/share", {"role": "viewer"})["token"]
            assert viewer.api("/api/join", {"token": token})["role"] == "viewer"
            link = origin + "/?board=" + path.rsplit("/", 1)[1]
            browser = chromium(playwright)
            result["chromium"] = browser.version
            errors = []
            mark("owner cold open")
            page = new_page(browser, owner)
            page.on("pageerror", lambda error: errors.append(str(error)[:180]))
            result["ownerColdReadyPaintMs"] = open_view(page, link, COUNT)
            result["fitZoom"] = page.locator("#zoom-value").inner_text()
            result["fitPixels"] = image_stats(page)
            assert result["fitPixels"]["chromaticPixels"] > 1000
            client = page.context.new_cdp_session(page)
            mark("fit pan")
            result["fitPan"] = wheel_test(page, client, False, native=True)
            mark("local pan")
            click_action(page, "zoom-reset")
            expect(page.locator("#zoom-value")).to_have_text("100%")
            result["localPixels"] = image_stats(page)
            assert result["localPixels"]["chromaticPixels"] > 1000
            result["localPan"] = wheel_test(page, client, False, native=True)
            before_pan = image_stats(page)
            view = """() => {const key=Object.keys(localStorage).find(k=>k.startsWith('folio.viewport.1:'));
                              return key && JSON.parse(localStorage[key]).centerX;}"""
            page.wait_for_function(view)
            previous_center = page.evaluate(view)
            client.send(
                "Input.dispatchMouseEvent",
                dict(type="mouseWheel", x=630, y=380, deltaX=93, deltaY=0),
            )
            page.wait_for_function(
                """previous => {const key = Object.keys(localStorage).find(k=>k.startsWith('folio.viewport.1:'));
                     return key && Math.abs(JSON.parse(localStorage[key]).centerX-previous)>25;}""",
                arg=previous_center,
            )
            after_pan = image_stats(page)
            assert (
                before_pan["rgbSha256"] != after_pan["rgbSha256"]
                and after_pan["chromaticPixels"] > 1000
            )
            result["verifiedPanWorldUnits"] = round(
                abs(page.evaluate(view) - previous_center), 2
            )
            mark("native pressure pen")
            choose_tool(page, "pen")
            before = ink_pixels(page)
            gesture(client, 625, 320, 460, 0.73, 24, -16)
            expect(page.locator("#object-count")).to_have_text(
                f"{COUNT+1} 个对象", timeout=30000
            )
            page.wait_for_function(
                "folioPerf.opsEpoch>folioPerf.penDownEpoch", timeout=30000
            )
            changed = owner.api(path + "/changes?since=" + str(rev))
            assert len(changed["put"]) == 1
            stroke = next(iter(changed["put"].values()))
            samples = stroke["props"]["ink"]["samples"]
            assert any(s[2] > 0.7 and s[3] == 24 and s[4] == -16 for s in samples)
            pixels = int(
                np.count_nonzero(np.max(np.abs(ink_pixels(page) - before), axis=2) > 12)
            )
            assert pixels > 40
            result["pen"] = {
                "samples": len(samples),
                "changedPixels": pixels,
                "ackMs": round(
                    page.evaluate("folioPerf.opsEpoch-folioPerf.penDownEpoch"), 2
                ),
                "moveToPaintUpperBoundMs": round(
                    page.evaluate("folioPerf.penPaint"), 2
                ),
            }
            page.screenshot(path=args.out.with_suffix(".png"))
            # Deliberately close the owner before the new device joins; this upper-limit
            # probe measures one active renderer plus replay of independently saved data.
            page.context.close()
            mark("independent viewer")
            peer = new_page(browser, viewer)
            peer.on("pageerror", lambda error: errors.append(str(error)[:180]))
            result["viewerColdReadyPaintMs"] = open_view(peer, link, COUNT + 1)
            mark("independent viewer reload")
            result["viewerReloadReadyPaintMs"] = open_view(peer, link, COUNT + 1)
            result["viewerPixels"] = image_stats(peer)
            assert result["viewerPixels"]["chromaticPixels"] > 1000
            browser.close()
            assert (
                viewer.api(path + "/changes?since=" + str(rev))["put"] == changed["put"]
            )
            mark("verify persisted corpus")
            doc = viewer.api(path)
            assert (
                doc["items"].pop(stroke["id"]) == stroke and len(doc["items"]) == COUNT
            )
            loaded = hashlib.sha256()
            for key in sorted(doc["items"]):
                loaded.update(compact(doc["items"][key]) + b"\n")
            assert digest == loaded.hexdigest()
            result.update(
                strokeAndAllOriginalsAfterViewerReload=True,
                finalRevision=doc["rev"],
                pageErrors=errors,
            )
            assert not errors, errors
        result["passed"] = True
        mark("complete")
        return 0
    except Exception as exc:
        result["error"] = type(exc).__name__ + ": " + str(exc)[:550]
        atomic(args.out, result)
        return 1


def bounded(args):
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.unlink(missing_ok=True)
    start = time.monotonic()
    peak = 0
    reason = None
    with tempfile.TemporaryDirectory(prefix="folio-compact-browser-") as temp:
        command = [
            sys.executable,
            __file__,
            "--worker",
            "--app",
            str(args.app),
            "--out",
            str(args.out),
        ]
        with subprocess.Popen(
            command, start_new_session=True, env={**os.environ, "TMPDIR": temp}
        ) as worker:
            while worker.poll() is None:
                descendants, rss = process_tree(worker.pid)
                peak = max(peak, rss or 0)
                if time.monotonic() - start > args.timeout:
                    reason = "case_time_limit"
                elif rss and rss > args.max_rss_mib:
                    reason = "process_tree_rss_limit"
                if reason:
                    for pid in reversed(descendants):
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    if worker.poll() is None:
                        os.killpg(worker.pid, signal.SIGKILL)
                    worker.wait()
                    break
                time.sleep(0.25)
    result = (
        json.loads(args.out.read_text())
        if args.out.is_file()
        else {"phase": "startup", "passed": False}
    )
    result.update(
        peakProcessTreeRssMiB=peak,
        elapsedSeconds=round(time.monotonic() - start, 2),
        timeoutSeconds=args.timeout,
        memoryLimitMiB=args.max_rss_mib,
        exitCode=worker.returncode,
    )
    if reason:
        result.update(passed=False, error=reason)
    if worker.returncode and "error" not in result:
        result.update(passed=False, error="worker_exit")
    atomic(args.out, result)
    print(
        json.dumps(
            {
                k: result.get(k)
                for k in (
                    "records",
                    "phase",
                    "passed",
                    "error",
                    "elapsedSeconds",
                    "peakProcessTreeRssMiB",
                )
            }
        ),
        flush=True,
    )
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=ROOT)
    parser.add_argument(
        "--out", type=Path, default=ROOT / "evidence/compact-browser-250000.json"
    )
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--max-rss-mib", type=int, default=3584)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    opts = parser.parse_args()
    opts.app = opts.app.resolve()
    opts.out = opts.out.resolve()
    raise SystemExit(probe(opts) if opts.worker else bounded(opts))
