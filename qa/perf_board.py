"""Measure the production application on real Chromium using its normal board, input and sync paths."""

import argparse
import hashlib
from importlib.metadata import version
import io
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import numpy as np
import time

from PIL import Image
from playwright.sync_api import expect, sync_playwright

from draw import chromium
from pen_lab import gesture
from perf_fixture import Device, compact, seed, service
from studio import choose_tool, click_action

WATCH = """(() => {
    const q = window.folioPerf = {ready:0,frames:[],phase:false,penPaint:0,wheels:0,inputPaint:[]};
    function ready() {
      if (!document.querySelector('#app[data-ready="true"] canvas') || q.pending) return;
      q.pending=true; observer.disconnect();
      requestAnimationFrame(()=>requestAnimationFrame(()=>q.ready=performance.now()));
    }
    const observer = new MutationObserver(ready);
    observer.observe(document, {subtree:true,childList:true,attributes:true,attributeFilter:['data-ready']});
    q.zooms=[];
    window.addEventListener('wheel', e=>{
      if (!q.phase)return;
      q.wheels++;
      const start=e.timeStamp;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        q.inputPaint.push(performance.now()-start);
        if(e.ctrlKey)q.zooms.push(document.getElementById('zoom-value')?.textContent);
      }));
    },true);
    window.addEventListener('pointerdown', e=>{
      if(e.pointerType==='pen')q.penDownEpoch=performance.timeOrigin+e.timeStamp;
    },true);
    const timing=new PerformanceObserver(list=>{
      for(const entry of list.getEntries())
        if (entry.name.endsWith('/ops')) q.opsEpoch=performance.timeOrigin+entry.responseEnd;
    });
    timing.observe({type:'resource',buffered:true});
    q.watchCount = count => {
      const label=document.getElementById('object-count');
      const watcher=new MutationObserver(()=>{
        if(label.textContent===count+' 个对象') {
          q.countEpoch=performance.timeOrigin+performance.now();
          watcher.disconnect();
        }
      });
      watcher.observe(label,{subtree:true,characterData:true,childList:true});
    };
    window.addEventListener('pointermove', e=>{
      if(e.pointerType==='pen' && e.buttons && !q.penStart){
        q.penStart=performance.now();
        requestAnimationFrame(()=>requestAnimationFrame(()=>q.penPaint=performance.now()-q.penStart));
      }
    },true);
    let prev=0;
    function frame(t) {
      if (q.phase && prev && t>prev) q.frames.push(t-prev);
      prev=q.phase?t:0;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})()"""


def now():
    return time.perf_counter()


def ms(since):
    return round(1000 * (now() - since), 2)


def quantile(values, pct):
    return round(sorted(values)[min(len(values) - 1, math.ceil(pct * len(values)) - 1)], 2)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_digest(root):
    digest = hashlib.sha256()
    for group in ("dist", "service"):
        for path in sorted((root / group).rglob("*")):
            if not path.is_file():
                continue
            key = path.relative_to(root).as_posix().encode()
            digest.update(len(key).to_bytes(4, "big"))
            digest.update(key)
            digest.update(bytes.fromhex(sha(path)))
    return digest.hexdigest()


def atomic(path, value):
    temp = path.with_suffix(".writing")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temp.replace(path)


def image_stats(page):
    bounds = page.get_by_test_id("drawing-surface").bounding_box()
    x = int(bounds["x"] + 140)
    y = int(bounds["y"] + 100)
    data = page.screenshot(
        clip=dict(x=x, y=y, width=int(bounds["width"]) - 210, height=int(bounds["height"]) - 180)
    )
    image = Image.open(io.BytesIO(data)).convert("RGB")
    rgb = np.asarray(image)
    chromatic = int(np.count_nonzero(rgb.max(2) - rgb.min(2) > 16))
    thumb = image.resize((96, 64))
    return dict(
        chromaticPixels=chromatic,
        sampledPixels=image.width * image.height,
        rgbSha256=hashlib.sha256(thumb.tobytes()).hexdigest(),
    )


def new_page(browser, device):
    context = browser.new_context(
        base_url=device.origin, viewport={"width": 1280, "height": 800}, device_scale_factor=1
    )
    context.add_cookies(device.cookies())
    context.add_init_script(WATCH)
    page = context.new_page()
    page.set_default_timeout(45000)
    return page


def open_view(page, url, count):
    page.goto(url, wait_until="commit", timeout=90000)
    page.wait_for_function("window.folioPerf?.ready > 0", timeout=90000)
    elapsed = round(page.evaluate("folioPerf.ready"), 2)
    expect(page.locator("#object-count")).to_have_text(str(count) + " 个对象", timeout=30000)
    return elapsed


def wheel_test(page, client, zoom, count=36, native=False):
    page.evaluate("Object.assign(folioPerf,{frames:[],inputPaint:[],zooms:[],wheels:0,phase:true})")
    start = now()
    if native:
        for direction in (1, -1):
            client.send(
                "Input.synthesizeScrollGesture",
                dict(
                    x=635,
                    y=390,
                    xDistance=direction * 420,
                    yDistance=direction * 100,
                    speed=650,
                    gestureSourceType="mouse",
                    preventFling=True,
                ),
            )
    else:
        for i in range(count):
            sign = 1 if i < count // 2 else -1
            client.send(
                "Input.dispatchMouseEvent",
                dict(
                    type="mouseWheel",
                    x=635,
                    y=390,
                    deltaX=0 if zoom else 11 * sign,
                    deltaY=2 * sign if zoom else 3 * sign,
                    modifiers=2 if zoom else 0,
                ),
            )
    page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    duration = ms(start)
    state = page.evaluate(
        "() => {folioPerf.phase=false;return {frames:folioPerf.frames,wheels:folioPerf.wheels,paint:folioPerf.inputPaint,zooms:folioPerf.zooms}}"
    )
    # Include a distinct tail measurement for redraws deferred until a gesture ends.
    tail = page.evaluate("""() => new Promise(resolve=>{
      const samples=[]; const start=performance.now(); let prior=start;
      function tick(t){if(t>prior)samples.push(t-prior);prior=t;
        if(t-start<500)requestAnimationFrame(tick);else resolve(samples);}
      requestAnimationFrame(tick);
    })""")
    samples = state["frames"]
    assert samples and state["wheels"] > 0, "Input or animation frames not received"
    if zoom:
        assert len(set(state["zooms"])) > 1, "Native viewport zoom did not change"
    missed = sum(max(0, round(v / (1000 / 60)) - 1) for v in samples)
    return {
        "driver": "Chromium synthesizeScrollGesture" if native else "Chromium wheel",
        "gesturesSent": 2 if native else count,
        "inputToSecondFrameP50Ms": quantile(state["paint"], 0.5),
        "inputToSecondFrameP95Ms": quantile(state["paint"], 0.95),
        "inputToSecondFrameMs": [round(v, 2) for v in state["paint"]],
        "wheelEventsReceived": state["wheels"],
        "observedZooms": sorted(set(state["zooms"])),
        "wallMs": duration,
        "frameMs": [round(v, 2) for v in samples],
        "settlingFrameMs": [round(v, 2) for v in tail],
        "settlingFrameMaxMs": round(max(tail), 2),
        "medianMs": quantile(samples, 0.5),
        "p95Ms": quantile(samples, 0.95),
        "maxMs": round(max(samples), 2),
        "missed60HzFrames": missed,
        "missedFramePct": round(100 * missed / (len(samples) + missed), 2),
    }


def run(args):
    root = Path(args.app).resolve()
    raw = Path(args.out).resolve()
    raw.parent.mkdir(parents=True, exist_ok=True)
    result = {
        "label": args.label,
        "objects": args.count,
        "spacing": args.spacing,
        "seedVersion": 1,
        "fixtureGeneratorSha256": sha(Path(__file__).with_name("perf_fixture.py")),
        "benchmarkSha256": sha(Path(__file__)),
        "playwright": version("playwright"),
        "headless": True,
        "hardwareAccelerationDisabled": True,
        "serverTopology": "Loopback; one Bun process, new SQLite DB, separate browser cookie jars",
        "hardware": platform.machine(),
        "cpuCount": os.cpu_count(),
        "viewport": [1280, 800],
        "dpr": 1,
        "build": {
            "index": sha(root / "dist/index.html"),
            "service": sha(root / "service/index.js"),
            "distAndServiceTreeSha256": build_digest(root),
        },
        "run": args.run,
        "phase": "starting",
        "passed": False,
    }

    def mark(phase):
        result["phase"] = phase
        atomic(raw, result)
        print(args.label, args.count, phase, flush=True)

    try:
        with service(root) as origin, sync_playwright() as p:
            writer, spectator = Device(origin), Device(origin)
            mark("seed")
            start = now()
            prefix, rev, digest = seed(writer, args.count, args.spacing)
            result["seedMs"] = ms(start)
            result["fixtureSha256"] = digest
            token = writer.api(prefix + "/share", {"role": "viewer"})["token"]
            spectator.api("/api/join", {"token": token})
            url = origin + "/?board=" + prefix.rsplit("/", 1)[1]
            mark("fresh open")
            browser = chromium(p)
            result["chromium"] = browser.version
            result["bun"] = subprocess.check_output(
                [os.getenv("BUN_PATH") or "bun", "--version"], text=True
            ).strip()
            result["platform"] = platform.platform()
            result["qualityGate"] = (
                "All seeded objects preserved by SHA-256, both authenticated devices saw the same new pen stroke"
            )
            owner = new_page(browser, writer)
            errors = []
            owner.on("pageerror", lambda e: errors.append(str(e)))
            result["openReadyPaintMs"] = open_view(owner, url, args.count)
            result["openingZoom"] = owner.locator("#zoom-value").inner_text()
            result["openingPixels"] = image_stats(owner)
            assert result["openingPixels"]["chromaticPixels"] > 100
            result["firstVerifiedVisibleMs"] = round(owner.evaluate("performance.now()"), 2)
            result["coldBoardResources"] = owner.evaluate(
                """path=>performance.getEntriesByType('resource')
                  .filter(e=>new URL(e.name).pathname===path)
                  .map(e=>({startMs:e.startTime,responseStartMs:e.responseStart,responseEndMs:e.responseEnd,
                            transferBytes:e.transferSize,encodedBytes:e.encodedBodySize,decodedBytes:e.decodedBodySize}))""",
                prefix,
            )
            mark("fitted overview pan")
            client = owner.context.new_cdp_session(owner)
            result["overviewPan"] = wheel_test(owner, client, False, native=True)
            mark("local view")
            click_action(owner, "zoom-reset")
            expect(owner.locator("#zoom-value")).to_have_text("100%")
            owner.wait_for_timeout(250)
            result["localPixels"] = image_stats(owner)
            assert result["localPixels"]["chromaticPixels"] > 100
            client = owner.context.new_cdp_session(owner)
            mark("pan")
            result["pan"] = wheel_test(owner, client, False, native=True)
            mark("zoom")
            result["zoom"] = wheel_test(owner, client, True)
            # Prove the UI changed the real camera. Run this outside all timed gestures.
            owner.wait_for_timeout(300)
            read_view = """() => {
                const key=Object.keys(localStorage).find(k=>k.startsWith('folio.viewport.1:'));
                return key ? JSON.parse(localStorage[key]) : null;
            }"""
            before = owner.evaluate(read_view)
            before_pan = image_stats(owner)
            client.send(
                "Input.dispatchMouseEvent",
                dict(type="mouseWheel", x=635, y=390, deltaX=93, deltaY=0),
            )
            owner.wait_for_function(
                "before => {const key=Object.keys(localStorage).find(k=>k.startsWith('folio.viewport.1:'));"
                "return key && Math.abs(JSON.parse(localStorage[key]).centerX-before)>25;}",
                arg=before["centerX"],
                timeout=10000,
            )
            after = owner.evaluate(read_view)
            after_pan = image_stats(owner)
            assert (
                before_pan["rgbSha256"] != after_pan["rgbSha256"]
                and after_pan["chromaticPixels"] > 100
            ), "Rendered contents did not pan"
            result["pannedPixels"] = after_pan
            result["verifiedCameraTravelWorldUnits"] = round(
                abs(after["centerX"] - before["centerX"]), 2
            )
            mark("second device open")
            peer = new_page(browser, spectator)
            peer.on("pageerror", lambda e: errors.append(str(e)))
            open_view(peer, url, args.count)
            owner.bring_to_front()
            choose_tool(owner, "pen")
            peer.evaluate("count=>folioPerf.watchCount(count)", args.count + 1)
            ink_clip = dict(x=611, y=333, width=28, height=111)
            ink_before = np.asarray(
                Image.open(io.BytesIO(owner.screenshot(clip=ink_clip))).convert("RGB"),
                dtype=np.int16,
            )
            mark("pen and sync")
            start = now()
            gesture(client, 625, 320, 460, 0.73, 24, -16)
            result["penDispatchMs"] = ms(start)
            expect(owner.locator("#object-count")).to_have_text(
                f"{args.count+1} 个对象", timeout=45000
            )
            expect(peer.locator("#object-count")).to_have_text(
                f"{args.count+1} 个对象", timeout=45000
            )
            down = owner.evaluate("folioPerf.penDownEpoch")
            received = peer.evaluate("folioPerf.countEpoch")
            assert received and down and received >= down
            result["peerVisibleMsFromPenDown"] = round(received - down, 2)
            change = writer.api(prefix + "/changes?since=" + str(rev))
            assert len(change["put"]) == 1
            stroke = next(iter(change["put"].values()))
            samples = stroke["props"]["ink"]["samples"]
            assert len(samples) >= 2 and any(
                s[2] > 0.7 and s[3] == 24 and s[4] == -16 for s in samples
            )
            result["penMoveToPaintBoundMs"] = round(owner.evaluate("folioPerf.penPaint"), 2)
            assert result["penMoveToPaintBoundMs"] > 0
            result["persistedSamples"] = len(samples)
            owner.wait_for_function("folioPerf.opsEpoch > folioPerf.penDownEpoch", timeout=30000)
            result["serverAckMsFromPenDown"] = round(
                owner.evaluate("folioPerf.opsEpoch-folioPerf.penDownEpoch"), 2
            )
            assert spectator.api(prefix + "/changes?since=" + str(rev))["put"] == change["put"]
            ink_after = np.asarray(
                Image.open(io.BytesIO(owner.screenshot(clip=ink_clip))).convert("RGB"),
                dtype=np.int16,
            )
            changed = int(np.count_nonzero(np.max(np.abs(ink_after - ink_before), axis=2) > 12))
            assert changed > 40, "No painted pen stroke visible at the trusted pointer location"
            result["visiblePenPixelsChanged"] = changed
            mark("reload and integrity")
            result["reloadReadyPaintMs"] = open_view(owner, url, args.count + 1)
            doc = writer.api(prefix)
            assert doc["items"].pop(stroke["id"]) == stroke
            loaded = hashlib.sha256()
            for key in sorted(doc["items"]):
                loaded.update(compact(doc["items"][key]) + b"\n")
            assert len(doc["items"]) == args.count and loaded.hexdigest() == digest
            result["pageErrors"] = errors
            assert not errors, errors
            result["passed"] = True
            mark("complete")
            browser.close()
    except Exception as e:
        result["error"] = type(e).__name__ + ": " + str(e)[:800]
        atomic(raw, result)
        print(args.count, "FAILED", result["phase"], repr(e)[:350], flush=True)
        return 1
    return 0


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--app", type=Path, required=True)
    cli.add_argument("--count", type=int, required=True)
    cli.add_argument("--out", type=Path, required=True)
    cli.add_argument("--run", type=int, default=1)
    cli.add_argument("--spacing", type=int, default=90)
    cli.add_argument("--label", default="probe")
    raise SystemExit(run(cli.parse_args()))
