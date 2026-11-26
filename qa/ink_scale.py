"""Reproduce the pressure/tilt-heavy canvas benchmark against an existing build.

All seeding uses authorized HTTP operations. Measured strokes use Chromium CDP
pen input. Use --app for either an archived baseline or the candidate build.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import io
from contextlib import contextmanager
import hashlib
import http.cookiejar
import json
import math
import os
from pathlib import Path
import platform
import select
import shutil
import sqlite3
import statistics
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from PIL import Image
from playwright.sync_api import expect, sync_playwright
from studio import choose_tool, set_ink_width

ROOT = Path(__file__).resolve().parents[1]
SIZES = (32, 64, 96, 128)
PROBE_PREFIX = "#b12f"
WIDTH, HEIGHT = 1280, 800
DENSE_COUNT, SPARSE_COUNT = 1000, 16


def pack(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()


def record(i, dense_count):
    n = SIZES[i % len(SIZES)]
    if i < SPARSE_COUNT:
        x, y = 205 + i % 8 * 105, 185 + i // 8 * 80
    elif i < SPARSE_COUNT + dense_count:
        k = i - SPARSE_COUNT
        cols = math.ceil(40 * math.sqrt(dense_count / 1000))
        rows = math.ceil(dense_count / cols)
        x, y = 6020 + k % cols * max(1, 1040 // cols), 80 + k // cols * max(1, 625 // rows)
    else:
        k = i - SPARSE_COUNT - dense_count
        x, y = 13000 + k % 120 * 78, 4000 + k // 120 * 60
    phase = i % 13 * 0.24
    rows = []
    for j in range(n):
        t = j / (n - 1)
        rows.append(
            [
                round(39 * t + 2 * math.sin(21 * t + phase), 1),
                round(14 * math.sin(10 * t + phase) * (0.75 + 0.25 * math.cos(8 * t)), 1),
                round(0.15 + 0.75 * math.sin(math.pi * t) ** 1.3, 2),
                round(47 * math.cos(4 * t + phase)),
                round(55 * math.sin(2 * t + phase)),
                (i + j) % 360,
                round(0.35 * math.sin(6 * t + phase), 2),
            ]
        )
    ident = "ink-%06d" % i
    brush = ("pencil", "pen", "pen", "pencil")[i % 4]
    return {
        "typeName": "shape",
        "type": "draw",
        "id": ident,
        "x": x,
        "y": y,
        "z": i,
        "rot": 0,
        "props": {
            "size": "m",
            "color": "#275c74",
            "isPen": True,
            "done": True,
            "pts": [v for row in rows for v in row[:3]],
            "ink": {
                "version": 1,
                "brush": brush,
                "width": 2.8,
                "color": "#275c74",
                "samples": rows,
            },
        },
    }


class Client:
    def __init__(self, url):
        self.url = url
        self.jar = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar)
        )

    def request(self, path, data=None):
        request = urllib.request.Request(
            self.url + path,
            data=None if data is None else pack(data),
            headers={"Content-Type": "application/json"},
        )
        try:
            with self.http.open(request, timeout=60) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)


def new_board(client, name):
    status, board = client.request("/api/boards", {"title": name})
    assert status == 201, (status, board)
    return board["id"]


def submit(client, board, records, start, rev):
    return client.request(
        "/api/boards/" + board + "/ops",
        {
            "opId": f"ink-{start}-{len(records)}-{rev}",
            "baseRev": rev,
            "put": {r["id"]: r for r in records},
        },
    )


def seed(client, total, dense_count=DENSE_COUNT, quota=False):
    board = new_board(client, "Inclined graphite pressure corpus")
    start, rev, points, digest = 0, 0, 0, hashlib.sha256()
    while start < total:
        batch = [record(i, dense_count) for i in range(start, min(start + 160, total))]
        status, reply = submit(client, board, batch, start, rev)
        if status == 413 and quota:
            assert reply["error"] == "board_size_limit", reply
            # Find the first rejected individual stroke, keeping accepted progress.
            for r in batch:
                st, result = submit(client, board, [r], start, rev)
                if st == 413:
                    assert result["error"] == "board_size_limit"
                    return board, start, points, digest.hexdigest(), True
                assert st == 200, result
                rev = result["rev"]
                start += 1
                points += len(r["props"]["ink"]["samples"])
                digest.update(pack(r))
            raise AssertionError("Rejected full batch unexpectedly fitted individually")
        assert status == 200, (status, reply)
        rev = reply["rev"]
        for r in batch:
            points += len(r["props"]["ink"]["samples"])
            digest.update(pack(r))
        start += len(batch)
    return board, start, points, digest.hexdigest(), False


@contextmanager
def service(root, bun):
    with tempfile.TemporaryDirectory(prefix="folio-ink-scale-") as work:
        db = Path(work) / "ink.sqlite"
        env = dict(os.environ, HOST="127.0.0.1", PORT="0", FOLIO_DB=str(db))
        with (Path(work) / "server.log").open("w") as errors:
            process = subprocess.Popen(
                [bun, "service/index.js"],
                cwd=root,
                env=env,
                stdout=subprocess.PIPE,
                stderr=errors,
                text=True,
            )
            try:
                assert select.select([process.stdout], [], [], 15)[0], "Server did not start"
                url = (
                    process.stdout.readline()
                    .strip()
                    .removeprefix("Folio listening at ")
                    .rstrip("/")
                )
                assert url.startswith("http://127.0.0.1:"), url
                yield Client(url), db
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


INSTRUMENT = """(() => {
 const latest = {pending: null, fills: [], frames: [], intervals: [], cycle:0, touches:0};
 window.inkPerf = latest;
 let last=0;
 function frame(t) { if(latest.cycle && last) latest.intervals.push(t-last); last=t; requestAnimationFrame(frame); }
 requestAnimationFrame(frame);
 for (const type of ['pointerdown','pointermove']) addEventListener(type, e=>{
   if (latest.cycle && e.pointerType==='pen' && e.buttons) {
     latest.touches++; latest.pending=e.timeStamp;
   }
 },true);
 const original = CanvasRenderingContext2D.prototype.fill;
 CanvasRenderingContext2D.prototype.fill = function(...args) {
   const probe = latest.pending!==null && this.fillStyle===latest.probeColor;
   const result = original.apply(this,args);
   if(probe) {
     const event = latest.pending; latest.pending=null;
     latest.fills.push(performance.now()-event);
     requestAnimationFrame(()=>latest.frames.push(performance.now()-event));
   }
   return result;
 };
})();"""


def metric(xs):
    if not xs:
        return {"n": 0}
    a = sorted(xs)
    return {
        "n": len(a),
        "medianMs": round(statistics.median(a), 2),
        "p95Ms": round(a[math.ceil(0.95 * len(a)) - 1], 2),
        "maxMs": round(a[-1], 2),
    }


def get_heap(cdp):
    return round(cdp.send("Runtime.getHeapUsage")["usedSize"] / 2**20, 2)


def await_commit(dbpath, board, expected, release):
    # Poll from another thread so CDP dispatch, UI frames, and a busy renderer
    # cannot inflate the release-to-server-transaction timing.
    with sqlite3.connect(f"file:{dbpath}?mode=ro", uri=True) as conn:
        deadline = release + 45
        while time.perf_counter() < deadline:
            got = conn.execute(
                "SELECT count(*) FROM items WHERE board_id=? AND body IS NOT NULL AND id NOT LIKE 'ink-%'",
                (board,),
            ).fetchone()[0]
            if got == expected:
                return (time.perf_counter() - release) * 1000
            time.sleep(0.008)
    raise TimeoutError("Released stroke did not reach SQLite")


def verify_marker_layer(page, cdp, client, db, board, existing, center, raster_dir):
    """An opaque ordinary shape must occlude both preview and committed marker."""
    import numpy as np

    rect = {
        "id": "layer-fixture",
        "typeName": "shape",
        "type": "geo",
        "z": 5_000_000,
        "x": center + 60,
        "y": 485,
        "rot": 0,
        "props": {
            "geo": "rectangle",
            "w": 55,
            "h": 42,
            "color": "#1cc95f",
            "faceColor": "#1cc95f",
            "fill": "solid",
            "size": "s",
        },
    }

    def rev():
        return db.execute("SELECT rev FROM boards WHERE id=?", (board,)).fetchone()[0]

    status, reply = client.request(
        "/api/boards/" + board + "/ops",
        {"opId": "marker-layer-control", "baseRev": rev(), "put": {rect["id"]: rect}},
    )
    assert status == 200, reply
    expect(page.locator("#object-count")).to_have_text(f"{existing+1} 个对象", timeout=15000)
    choose_tool(page, "marker")
    page.locator("#ink-color").fill("#ffdd21")
    set_ink_width(page, 22)

    def frames():
        page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def shot():
        return Image.open(io.BytesIO(page.screenshot())).convert("RGB")

    frames()
    beforeImage = shot()
    before = np.asarray(beforeImage)
    centralColor = np.array([28, 201, 95])
    ys, xs = np.nonzero(np.max(np.abs(before.astype(np.int16) - centralColor), axis=2) < 3)
    assert len(xs) > 400, "Could not find front-layer control shape"
    cx = int(np.median(xs))
    cy = int(np.median(ys))
    left = cx - 66
    right = cx + 66
    crop = (left - 5, cy - 20, right + 5, cy + 20)
    old = np.asarray(beforeImage.crop(crop), dtype=np.int16)
    green = np.max(np.abs(old - centralColor), axis=2) < 3
    assert green.sum() > 300

    def event(kind, x):
        cdp.send(
            "Input.dispatchMouseEvent",
            {
                "type": kind,
                "x": x,
                "y": cy,
                "button": "left",
                "buttons": 0 if kind == "mouseReleased" else 1,
                "pointerType": "pen",
                "clickCount": int(kind != "mouseMoved"),
                "force": 0 if kind == "mouseReleased" else 0.8,
                "tiltX": 36,
                "tiltY": 19,
                "twist": 15,
                "tangentialPressure": 0.25,
            },
        )

    event("mousePressed", left)
    for n in range(1, 13):
        event("mouseMoved", left + (right - left) * n / 12)
    frames()
    held = shot().crop(crop)
    event("mouseReleased", right)
    expect(page.locator("#object-count")).to_have_text(f"{existing+2} 个对象", timeout=15000)
    frames()
    released = shot().crop(crop)
    # Wait for server persistence before re-opening in the same viewport.
    deadline = time.monotonic() + 12
    marker = None
    while not marker and time.monotonic() < deadline:
        marker = db.execute(
            "SELECT id FROM items WHERE board_id=? AND body LIKE '%#ffdd21%'", (board,)
        ).fetchone()
        if not marker:
            time.sleep(0.02)
    assert marker
    page.reload(wait_until="domcontentloaded", timeout=90000)
    expect(page.locator("#app")).to_have_attribute("data-ready", "true", timeout=90000)
    frames()
    after = shot().crop(crop)
    output = {}
    for label, img in [("preview", held), ("committed", released), ("reloaded", after)]:
        rgb = np.asarray(img, dtype=np.int16)
        delta = np.max(np.abs(rgb - old), axis=2)
        changed = int(((delta > 10) & ~green).sum())
        affected = int(((delta > 3) & green).sum())
        # Hotspot is well outside the foreground rectangle; no cursor can cover it.
        assert affected == 0, (label, affected)
        assert changed > 150, (label, changed)
        if raster_dir:
            img.save(raster_dir / f"marker-layer-{label}.png")
        output[label] = {
            "upperSurfaceChangedPixels": affected,
            "visibleMarkerPixels": changed,
            "rgbSha256": hashlib.sha256(img.tobytes()).hexdigest(),
        }
    output["foregroundPixelCount"] = int(green.sum())
    output["controlId"] = rect["id"]
    status, reply = client.request(
        "/api/boards/" + board + "/ops",
        {"opId": "marker-layer-cleanup", "baseRev": rev(), "remove": [rect["id"], marker[0]]},
    )
    assert status == 200, reply
    return output


def probe_region(
    browser, client, dbpath, board, count, region, repeated, raster_dir, brush, layer_check
):
    context = browser.new_context(
        viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1
    )
    context.add_cookies([{"name": c.name, "value": c.value, "url": client.url} for c in client.jar])
    center = 640 if region == "sparse" else 6580
    context.add_init_script(script=f"""(() => {{
      const s=document.cookie.match(/(?:^|; )folio_cache=([^;]+)/)?.[1];
      if(s) localStorage.setItem('folio.viewport.1:'+s+':{board}',
          JSON.stringify({{centerX:{center},centerY:400,zoom:1}}));
    }})();""")
    context.add_init_script(script=INSTRUMENT)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    cdp = context.new_cdp_session(page)
    db = sqlite3.connect(f"file:{dbpath}?mode=ro", uri=True)
    try:
        existing = db.execute(
            "SELECT count(*) FROM items WHERE board_id=? AND body IS NOT NULL", (board,)
        ).fetchone()[0]
        started = time.perf_counter()
        page.goto(client.url + "/?board=" + board, wait_until="domcontentloaded", timeout=90000)
        expect(page.locator("#app")).to_have_attribute("data-ready", "true", timeout=90000)
        page.evaluate("() => new Promise(r=> requestAnimationFrame(()=>requestAnimationFrame(r)))")
        ready_ms = round((time.perf_counter() - started) * 1000, 1)
        expect(page.locator("#zoom-value")).to_have_text("100%")
        expect(page.locator("#object-count")).to_have_text(f"{existing} 个对象")
        # Verify actual virtual viewport restoration using raster colors at probe time.
        # Stable interior rectangle excludes the toolbar, pointer and save indicator.
        screenshot = page.screenshot(clip={"x": 180, "y": 150, "width": 875, "height": 460})
        if raster_dir:
            raster_dir.mkdir(parents=True, exist_ok=True)
            (raster_dir / (region + ".png")).write_bytes(screenshot)
        image = Image.open(io.BytesIO(screenshot)).convert("RGB")
        rgb = image.tobytes()
        raster_digest = hashlib.sha256(rgb).hexdigest()
        channels = zip(rgb[::3], rgb[1::3], rgb[2::3])
        blue = sum(1 for r, g, b in channels if b - r > 24 and g - r > 12 and r < 190)
        assert blue > 150, (region, blue)
        choose_tool(page, brush)
        # Separate loading, raster validation and browser initialization from warm interaction.
        page.wait_for_timeout(450)
        warm_heap = get_heap(cdp)
        durable = []
        rowids = []
        for run in range(repeated):
            probe_color = PROBE_PREFIX + f"{(0 if region=='sparse' else 128)+run:02x}"
            page.locator("#ink-color").fill(probe_color)
            page.evaluate(
                "color => {inkPerf.pending=null;inkPerf.probeColor=color;inkPerf.cycle=1}",
                probe_color,
            )
            x0, y0 = 290 + run * 20, 380 + run * 32
            for j in range(17):
                f = j / 16
                cdp.send(
                    "Input.dispatchMouseEvent",
                    {
                        "type": "mousePressed" if j == 0 else "mouseMoved",
                        "x": x0 + j * 7,
                        "y": y0 + 6 * math.sin(7 * f),
                        "button": "left",
                        "buttons": 1,
                        "pointerType": "pen",
                        "clickCount": int(j == 0),
                        "force": round(0.18 + 0.75 * math.sin(math.pi * f), 2),
                        "tiltX": round(62 * math.sin(f * 4)),
                        "tiltY": round(44 * math.cos(f * 3)),
                        "twist": round(20 + 90 * f),
                        "tangentialPressure": round(0.4 * math.sin(5 * f), 2),
                    },
                )
            release = time.perf_counter()
            with ThreadPoolExecutor(max_workers=1) as watcher:
                persisted = watcher.submit(
                    await_commit, dbpath, board, existing - count + run + 1, release
                )
                cdp.send(
                    "Input.dispatchMouseEvent",
                    {
                        "type": "mouseReleased",
                        "x": x0 + 112,
                        "y": y0 + 6 * math.sin(7),
                        "button": "left",
                        "buttons": 0,
                        "pointerType": "pen",
                        "clickCount": 1,
                        "force": 0,
                    },
                )
                page.evaluate(
                    "() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"
                )
                page.evaluate("inkPerf.cycle=0")
                durable.append(persisted.result())
            rows = db.execute(
                "SELECT id,body FROM items WHERE board_id=? AND id NOT LIKE 'ink-%' AND body IS NOT NULL",
                (board,),
            ).fetchall()
            docs = {key: json.loads(body) for key, body in rows}
            owned = [
                d["props"]["ink"]
                for d in docs.values()
                if d["props"]["ink"]["color"] == probe_color
            ]
            assert len(owned) == 1
            assert owned[0]["brush"] == brush, owned[0]["brush"]
            s = owned[0]["samples"]
            assert any(abs(p[3]) > 25 and p[2] > 0.25 and abs(p[6]) > 0.15 for p in s), s
            rowids = sorted(docs)
        measurement = page.evaluate("""() => ({fill:inkPerf.fills, nextFrame:inkPerf.frames,
                            raf:inkPerf.intervals, captured:inkPerf.touches})""")
        assert measurement["fill"], "Failed to observe real sampled input through Canvas 2D fill"
        page.reload(wait_until="domcontentloaded", timeout=90000)
        expect(page.locator("#app")).to_have_attribute("data-ready", "true", timeout=90000)
        expect(page.locator("#object-count")).to_have_text(f"{existing+repeated} 个对象")
        composition = None
        if layer_check and region == "dense":
            composition = verify_marker_layer(
                page, cdp, client, db, board, existing + repeated, center, raster_dir
            )
        assert not errors, errors
        return {
            "markerCompositing": composition,
            "region": region,
            "readyAndTwoRafMs": ready_ms,
            "coloredInteriorPixels": blue,
            "interiorRgbSha256": raster_digest,
            "warmJsHeapMiB": warm_heap,
            "pointerEventsCaptured": measurement["captured"],
            "pointerToInkFill": metric(measurement["fill"]),
            "pointerToFollowingRaf": metric(measurement["nextFrame"]),
            "rAFIntervalsDuringWriting": metric(measurement["raf"]),
            "penReleaseToDurableObserved": metric(durable),
            "rawMs": {**measurement, "releaseToDurable": durable},
            "persistedRealStrokesAfterReload": len(rowids),
            "browserErrors": errors,
        }
    finally:
        context.close()
        db.close()


def build_hash(root):
    digest = hashlib.sha256()
    for f in sorted((root / "dist").rglob("*")):
        if f.is_file():
            digest.update(str(f.relative_to(root)).encode())
            digest.update(hashlib.sha256(f.read_bytes()).digest())
    digest.update(hashlib.sha256((root / "service" / "index.js").read_bytes()).digest())
    return digest.hexdigest()


def run(args):
    root = args.app.resolve()
    with service(root, args.bun) as (client, db), sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            executable_path=os.getenv("CHROMIUM_PATH"),
            args=["--disable-gpu", "--disable-dev-shm-usage"],
        )
        receipt = {
            "label": args.label,
            "buildSha256": build_hash(root),
            "platform": platform.machine(),
            "chromium": browser.version,
            "viewport": [WIDTH, HEIGHT],
            "dpr": 1,
            "flags": ["--disable-gpu", "--disable-dev-shm-usage"],
            "lap": args.lap,
            "strokeLengths": list(SIZES),
            "inputBrush": args.brush,
            "corpusStrokesInViewport": {"sparse": SPARSE_COUNT, "dense": args.dense_visible},
            "regionsOrder": args.region,
            "results": [],
        }
        start = time.monotonic()
        board, count, points, digest, _ = seed(client, args.count, args.dense_visible)
        with sqlite3.connect(db) as inspect:
            row = inspect.execute(
                "SELECT item_bytes,rev FROM boards WHERE id=?", (board,)
            ).fetchone()
        receipt["corpus"] = {
            "strokes": count,
            "points": points,
            "contentSha256": digest,
            "boardBytes": row[0],
            "seededRevision": row[1],
            "seedSeconds": round(time.monotonic() - start, 2),
        }
        print(receipt["corpus"], flush=True)
        for region in args.region:
            item = probe_region(
                browser,
                client,
                db,
                board,
                count,
                region,
                args.repeats,
                args.raster_dir,
                args.brush,
                args.layer_check,
            )
            receipt["results"].append(item)
            print(
                region,
                item["pointerToInkFill"],
                item["rAFIntervalsDuringWriting"],
                item["penReleaseToDurableObserved"],
                flush=True,
            )
        if args.quota:
            board, n, samples, sha, hit = seed(client, 12500, quota=True)
            with sqlite3.connect(db) as inspect:
                stored = inspect.execute(
                    "SELECT item_bytes FROM boards WHERE id=?", (board,)
                ).fetchone()[0]
                actual = inspect.execute(
                    "SELECT count(*) FROM items WHERE board_id=?", (board,)
                ).fetchone()[0]
            assert actual == n
            receipt["quota"] = {
                "attemptedTargetPoints": 1000000,
                "reached32MiBLimit": hit,
                "strokes": n,
                "acceptedSamples": samples,
                "acceptedBytes": stored,
                "rejectedBatchRolledBack": hit,
                "contentSha256": sha,
            }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(receipt, indent=2) + "\n")
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=ROOT)
    parser.add_argument("--bun", default=os.getenv("BUN_PATH") or shutil.which("bun"))
    parser.add_argument("--count", type=int, default=4096)
    parser.add_argument("--dense-visible", type=int, default=DENSE_COUNT)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--brush", choices=["pen", "pencil", "marker"], default="pen")
    parser.add_argument(
        "--region", nargs="+", choices=["sparse", "dense"], default=["sparse", "dense"]
    )
    parser.add_argument("--quota", action="store_true")
    parser.add_argument(
        "--layer-check",
        action="store_true",
        help="Check upper-layer occlusion during, after, and on reloading a marker stroke.",
    )
    parser.add_argument(
        "--raster-dir", type=Path, help="Save fixed interior crops for cross-build pixel checks."
    )
    parser.add_argument("--label", required=True)
    parser.add_argument("--lap", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.bun:
        parser.error("Install Bun, set BUN_PATH, or pass --bun.")
    if args.dense_visible < 1 or args.count < SPARSE_COUNT + args.dense_visible:
        parser.error("Count must accommodate the requested dense cohort plus 16 sparse strokes")
    run(args)
