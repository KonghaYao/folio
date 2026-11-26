"""Isolate canvas CPU costs on identical synthetic boards; cold opens and rAF belong to the HTTP benchmark."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

from playwright.sync_api import sync_playwright


def main():
    scenario = (Path(__file__).parent / "fixtures/renderer-scale.js").read_text()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sizes", nargs="+", type=int, default=[1000, 10000, 50000])
    parser.add_argument("--chromium", default=os.getenv("CHROMIUM_PATH"))
    parser.add_argument("--iterations", type=int, default=30)
    args = parser.parse_args()
    root = args.project.resolve()
    digest = hashlib.sha256()
    for source in sorted((root / "client" / "canvas").glob("*.ts")):
        if source.name.endswith(".test.ts"):
            continue
        digest.update(source.name.encode() + b"\0" + source.read_bytes() + b"\0")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    # Vite serves the actual project modules. The test document has no app-level
    # network, sync or storage listeners, so these metrics isolate the editor.
    proc = subprocess.Popen(
        [root / "node_modules/.bin/vite", "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError("Vite exited")
            try:
                with urllib.request.urlopen(url + "/@vite/client", timeout=1):
                    break
            except OSError:
                time.sleep(.12)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=args.chromium, args=["--no-sandbox"])
            results = {
                "chromium": browser.version,
                "viewport": [800, 600],
                "dpr": 1,
                "iterations": args.iterations,
                "rendererSourceSHA256": digest.hexdigest(),
                "warmupMs": 650,
                "units": "synchronous browser-main-thread milliseconds; painting measures Canvas2D command submission",
                "dataset": "100-unit square grid of editable rectangles, ellipses, polylines and highlighter strokes",
                "cases": [],
            }
            for size in args.sizes:
                page = browser.new_page(viewport={"width": 800, "height": 600}, device_scale_factor=1)
                page.route(
                    "**/renderer-scale.html",
                    lambda route: route.fulfill(
                        content_type="text/html",
                        body="<body style='margin:0'><div id='surface' style='width:800px;height:600px;position:relative'></div>",
                    ),
                )
                page.goto(url + "/renderer-scale.html")
                data = page.evaluate(scenario, [size, args.iterations])
                results["cases"].append(data)
                print(json.dumps(data), flush=True)
                page.close()
            browser.close()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(results, indent=2) + "\n")
    finally:
        proc.terminate()
        proc.wait(timeout=10)



if __name__ == "__main__":
    main()
