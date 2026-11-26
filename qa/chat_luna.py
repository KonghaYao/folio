"""Record a real Luna agent painting via Peri in the browser.

Run with an independent, live Luna responder watching <bridge>/requests.
For each 0001.json request it writes an atomic <bridge>/responses/0001.json
containing {text?: string, tool_calls?: [{name: string, arguments: object}]}.
There is deliberately no default completion or artwork on the QA side.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import time

from playwright.sync_api import expect, sync_playwright

from chat_browser import ROOT, configure, folio_service, open_chat, ready, send, watch_rpc
from chat_endpoint import completion_endpoint
from draw import OUTPUT, chromium, ink_items, snapshot, wait_for_durable
from studio import click_action

PROMPT = "画一只骑单车的鹈鹕，保留可编辑笔迹。"
MODEL = "gpt-6-luna"


def atomic_json(path, value):
    temp = path.with_suffix(".writing")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


class LiveModel:
    def __init__(self, directory):
        self.directory = directory
        for name in ("requests", "responses"):
            path = directory / name
            path.mkdir(parents=True, exist_ok=True)
            if list(path.glob("*.json")):
                raise ValueError(
                    f"Refusing to replay earlier model traffic in {path}. Use a fresh bridge directory."
                )
        self.lock = threading.Lock()
        self.calls = []
        self.finished = threading.Event()
        self.errors = []
        self.key = secrets.token_urlsafe(30)
        self.final_text = None

    def answer(self, incoming):
        with self.lock:
            number = len(self.calls) + 1
            tag = f"{number:04}.json"
            request = {
                k: incoming[k] for k in ("messages", "model", "tools", "stream") if k in incoming
            }
            assert self.key not in json.dumps(request), "Transport credential found in model input"
            path = self.directory / "requests" / tag
            atomic_json(path, request)
            print("Waiting for live Luna:", path, flush=True)
            responding = self.directory / "responses" / tag
            deadline = time.monotonic() + 280
            while not responding.exists():
                if time.monotonic() > deadline:
                    raise TimeoutError(f"Live model response {tag} did not arrive")
                time.sleep(0.15)
            reply = json.loads(responding.read_text())
            calls = reply.get("tool_calls") or []
            if not calls and not reply.get("text"):
                raise ValueError("Empty model response")
            for call in calls:
                if not isinstance(call["name"], str) or not isinstance(call["arguments"], dict):
                    raise ValueError("Invalid model tool call")
            self.calls.append(
                {
                    "number": number,
                    "requestSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "responseSha256": hashlib.sha256(responding.read_bytes()).hexdigest(),
                    "toolNames": [call["name"] for call in calls],
                    "previousToolResults": sum(
                        m.get("role") == "tool" for m in request["messages"]
                    ),
                }
            )
            if not calls:
                self.final_text = reply["text"]
                self.finished.set()
            return reply


def model_traffic(directory):
    """Verify hashes and expose the actual canvas tool and outcome without publishing session IDs."""
    report = []
    requests = sorted((directory / "requests").glob("*.json"))
    for i, path in enumerate(requests):
        answer = directory / "responses" / path.name
        request = json.loads(path.read_text())
        response = json.loads(answer.read_text())
        calls = response.get("tool_calls", [])
        entry = {
            "number": i + 1,
            "requestSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "responseSha256": hashlib.sha256(answer.read_bytes()).hexdigest(),
            "toolNames": [c["name"] for c in calls],
            "canvasToolNames": [
                call["arguments"]["tool_name"]
                for call in calls
                if call["name"] == "ExecuteExtraTool"
            ],
            "previousToolResults": sum(m.get("role") == "tool" for m in request["messages"]),
        }
        if calls and i + 1 < len(requests):
            next_messages = json.loads(requests[i + 1].read_text())["messages"]
            results = [m["content"] for m in next_messages if m.get("role") == "tool"]
            if results:
                latest = results[-1]
                try:
                    data = json.loads(latest)
                    entry["result"] = {
                        k: len(data[k]) for k in ("created", "updated", "deleted") if k in data
                    }
                    if "matched" in data:
                        entry["result"]["matched"] = data["matched"]
                    if "sync" in data:
                        entry["result"]["sync"] = data["sync"]
                except (ValueError, TypeError):
                    entry["toolReply"] = str(latest)[:300]
        report.append(entry)
    return report


class Screencast:
    """Real-time Chromium frames. Variable frame durations preserve model thinking time."""

    def __init__(self, page, directory):
        self.page = page
        self.directory = directory
        self.session = page.context.new_cdp_session(page)
        self.frames = []
        self.start = time.monotonic()
        page.mouse.move(20, 20)
        self.save(page.screenshot(type="jpeg", quality=85), self.start)
        self.session.on("Page.screencastFrame", self.frame)
        self.session.send(
            "Page.startScreencast", {"format": "jpeg", "quality": 85, "everyNthFrame": 1}
        )

    def save(self, data, stamp):
        name = f"frame-{len(self.frames):06}.jpg"
        (self.directory / name).write_bytes(data)
        self.frames.append((name, stamp))

    def frame(self, event):
        self.session.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]})
        now = time.monotonic()
        if now - self.frames[-1][1] >= 0.2:
            self.save(base64.b64decode(event["data"]), now)

    def finish(self, target):
        self.session.send("Page.stopScreencast")
        self.save(self.page.screenshot(type="jpeg", quality=90), time.monotonic())
        manifest = self.directory / "frames.txt"
        lines = []
        for (name, stamp), (_, following) in zip(self.frames, self.frames[1:]):
            lines.extend([f"file '{name}'", f"duration {max(.04, following - stamp):.4f}"])
        final_name = self.frames[-1][0]
        lines.extend([f"file '{final_name}'", "duration 3.0", f"file '{final_name}'"])
        manifest.write_text("\n".join(lines) + "\n")
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(manifest),
                "-vf",
                "fps=12",
                "-c:v",
                "libx264",
                "-threads",
                "2",
                "-crf",
                "21",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(target),
            ],
            check=True,
        )
        return round(self.frames[-1][1] - self.frames[0][1] + 3, 2)


def duration_seconds(path):
    value = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        text=True,
    )
    return round(float(value), 3)


def make_preview(full_video):
    """Keep frames from the original live recording and shorten unchanged model waits."""
    preview = full_video.with_name("chat-luna-preview.mp4")
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            str(full_video),
            "-vf",
            "fps=4,mpdecimate=hi=128:lo=64:frac=0.005,setpts=N/(2.25*TB),fps=12,tpad=stop_mode=clone:stop_duration=4",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(preview),
        ],
        check=True,
    )
    return preview


def run(directory, bun):
    live = LiveModel(directory)
    OUTPUT.mkdir(exist_ok=True)
    with completion_endpoint(MODEL, live.key, live.answer, live.errors) as origin, folio_service(
        origin, bun
    ) as (url, _), sync_playwright() as playwright, tempfile.TemporaryDirectory(
        prefix="folio-luna-capture-"
    ) as frames:
        browser = chromium(playwright)
        context = browser.new_context(
            base_url=url, viewport={"width": 1536, "height": 960}, device_scale_factor=1
        )
        page = context.new_page()
        page_errors, rpc = [], []
        page.on("pageerror", lambda err: page_errors.append(str(err)[:260]))
        watch_rpc(page, rpc)
        page.goto(url)
        ready(page)
        assert not snapshot(page)["items"], "The recording requires an initially empty whiteboard"
        panel = open_chat(page)
        configure(page, origin, MODEL, live.key)
        video = Screencast(page, Path(frames))
        send(page, PROMPT)
        deadline = time.monotonic() + 1200
        while not live.finished.is_set():
            if live.errors or page_errors or page.get_by_test_id("chat-error").text_content():
                raise RuntimeError((live.errors, page_errors, panel.inner_text()[-800:]))
            if time.monotonic() > deadline:
                raise TimeoutError("The live drawing turn did not finish")
            page.wait_for_timeout(250)
        expect(panel.get_by_text(live.final_text, exact=False).last).to_be_visible(timeout=30000)
        wait_for_durable(page)
        doc = snapshot(page)
        pens = ink_items(doc)
        assert pens, "Expected editable pressure/tilt stroke records"
        assert any(
            c["previousToolResults"] for c in live.calls
        ), "No genuine canvas tool result returned to Luna"
        assert not page_errors and not live.errors, (page_errors, live.errors)
        click_action(page, "fit")
        page.wait_for_timeout(350)
        page.mouse.move(22, 15)
        page.screenshot(path=OUTPUT / "chat-luna-pelican.png")
        full_video = OUTPUT / "chat-luna-pelican.mp4"
        seconds = video.finish(full_video)
        preview = make_preview(full_video)
        atomic_json(OUTPUT / "chat-luna-board.json", doc)
        page.reload()
        ready(page)
        assert snapshot(page)["items"] == doc["items"], "The Luna artwork changed on reload"
        page.locator("[data-action=more]").click()
        page.locator("[data-action=export]").click()
        with page.expect_download() as download:
            page.locator("[data-action=export-archive]").click()
        archive = OUTPUT / "chat-luna-pelican.folio.json"
        download.value.save_as(archive)
        assert json.loads(archive.read_text())["items"] == doc["items"]
        page.keyboard.press("Escape")
        original_url = page.url
        page.locator("[data-action=more]").click()
        page.locator("[data-action=import]").click()
        page.locator("[data-action=import-file]").set_input_files(archive)
        page.locator("[data-action=import-submit]").click()
        expect(page.locator("#board-title")).to_contain_text("副本")
        assert page.url != original_url
        ready(page)
        assert (
            snapshot(page)["items"] == doc["items"]
        ), "Portable export changed after importing the archive"
        receipt = {
            "prompt": PROMPT,
            "runtime": "@peri-code/sdk",
            "liveModel": MODEL,
            "modelBoundary": "A separate live GPT-6 Luna agent read real provider requests and returned tool calls and assistant text via an isolated completion transport. No commercial provider credential was used.",
            "chromium": browser.version,
            "providerRequests": model_traffic(directory),
            "rpcReplies": rpc,
            "objects": len(doc["items"]),
            "editableInkStrokes": len(pens),
            "reloadedIdentically": True,
            "portableExportReimported": True,
            "archive": archive.name,
            "browserErrors": page_errors,
            "providerErrors": live.errors,
            "reply": live.final_text,
            "captureSeconds": seconds,
            "videoDurationSeconds": duration_seconds(full_video),
            "previewDurationSeconds": duration_seconds(preview),
            "preview": preview.name,
            "video": "chat-luna-pelican.mp4",
            "image": "chat-luna-pelican.png",
            "board": "chat-luna-board.json",
        }
        atomic_json(OUTPUT / "chat-luna.json", receipt)
        print(
            f"Live Luna drawing completed with {len(pens)} editable strokes and {len(live.calls)} model requests.",
            flush=True,
        )
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--bun")
    args = parser.parse_args()
    run(args.bridge, args.bun)
