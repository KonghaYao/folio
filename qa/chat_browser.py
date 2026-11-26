"""Browser and isolated Folio process shared by the agent integration tests."""

from contextlib import contextmanager
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect
from draw import OUTPUT, wait_for_durable

ROOT = OUTPUT.parent
SURFACE = '[data-testid="board-surface"]'


@contextmanager
def folio_service(provider_origin, bun=None):
    bun = bun or os.environ.get("BUN_PATH") or shutil.which("bun")
    if not bun:
        raise RuntimeError("Install Bun or set BUN_PATH")
    with tempfile.TemporaryDirectory(prefix="folio-chat-qa-") as folder:
        work = Path(folder)
        env = dict(
            os.environ,
            HOST="127.0.0.1",
            PORT="0",
            FOLIO_DB=str(work / "board.sqlite"),
            FOLIO_AI_ALLOWED_ORIGINS=provider_origin,
        )
        with (work / "server.stderr").open("wb") as stderr:
            process = subprocess.Popen(
                [bun, os.environ.get("FOLIO_QA_ENTRY", "server/index.ts")],
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=stderr,
                text=True,
            )
            try:
                if not select.select([process.stdout], [], [], 20)[0]:
                    raise TimeoutError("No local Folio startup message")
                url = (
                    process.stdout.readline()
                    .strip()
                    .removeprefix("Folio listening at ")
                    .rstrip("/")
                )
                if not url.startswith("http://127.0.0.1:"):
                    raise RuntimeError(
                        "Folio did not start. " + (work / "server.stderr").read_text()[:3000]
                    )
                yield url, work
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def board_id(page):
    return parse_qs(urlparse(page.url).query)["board"][0]


def open_chat(page):
    panel = page.get_by_test_id("chat-panel")
    if not panel.is_visible():
        page.get_by_test_id("chat-open").click()
    expect(panel).to_be_visible()
    return panel


def configure(page, origin, model, key):
    open_chat(page)
    page.get_by_test_id("chat-settings").click()
    page.get_by_test_id("chat-provider").select_option("openai")
    page.get_by_test_id("chat-model").fill(model)
    page.get_by_test_id("chat-url").fill(origin + "/v1")
    secret = page.get_by_test_id("chat-key")
    expect(secret).to_have_attribute("type", "password")
    secret.fill(key)
    page.get_by_test_id("chat-save").click()
    expect(secret).to_have_count(0)


def send(page, prompt):
    page.get_by_test_id("chat-input").fill(prompt)
    page.get_by_test_id("chat-send").click()


def watch_rpc(page, records):
    def record(request):
        if not request.url.endswith("/chat/rpc") or request.method != "POST":
            return

        def visit(value):
            if isinstance(value, dict):
                method = value.get("method")
                if method in ("tools/list", "tools/call", "initialize"):
                    records.append(method)
                if value.get("jsonrpc") == "2.0" and ("result" in value or "error" in value):
                    records.append("error" if "error" in value else "result")
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        visit(request.post_data_json)

    page.on("request", record)


def ready(page):
    expect(page.locator("#app")).to_have_attribute("data-ready", "true", timeout=15000)
    wait_for_durable(page)
