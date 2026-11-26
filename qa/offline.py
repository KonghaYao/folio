"""Reopen a closed persistent profile offline, recover two tabs and sync the strokes exactly once."""
import argparse
import json
import os
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import expect, sync_playwright


def run(url, output, immediate=False):
    with tempfile.TemporaryDirectory(prefix="folio-offline-profile-") as profile, sync_playwright() as runner:
        def launch():
            return runner.chromium.launch_persistent_context(
                profile, executable_path=os.environ.get("CHROMIUM_PATH"), headless=True,
                viewport={"width": 1060, "height": 730}, args=["--disable-dev-shm-usage"],
            )
        ctx = launch()
        page = ctx.pages[0]
        page.goto(url)
        page.wait_for_selector('#app[data-ready="true"]')
        board_url = page.url
        board_id = parse_qs(urlparse(board_url).query)["board"][0]
        page.evaluate("navigator.serviceWorker.ready.then(() => true)")
        page.wait_for_function("!!navigator.serviceWorker.controller")
        second = ctx.new_page()
        second.goto(board_url)
        second.wait_for_selector('#app[data-ready="true"]')
        ctx.set_offline(True)
        drafts = """() => new Promise((ok,no) => {
          const req = indexedDB.open('folio.offline.v1')
          req.onerror = () => no(req.error)
          req.onsuccess = () => {
            const db=req.result
            const rows = db.transaction('drafts').objectStore('drafts').getAll()
            rows.onsuccess=()=>{db.close();ok(rows.result.length)}
          }
        })"""
        for n, tab in enumerate([page,second]):
            tab.get_by_role('button',name='钢笔',exact=True).click()
            tab.mouse.move(250,260+n*75)
            tab.mouse.down()
            tab.mouse.move(340,295+n*75,steps=10)
            tab.mouse.up()
            if not immediate:
                expect(tab.locator("#object-count")).to_contain_text("1")
        if not immediate:
            expires=time.monotonic()+8
            while page.evaluate(drafts)!=2 and time.monotonic()<expires:
                page.wait_for_timeout(40)
            assert page.evaluate(drafts)==2, "each active tab must have a committed private journal"
        ctx.close()

        ctx=launch()
        ctx.set_offline(True)
        restored=ctx.pages[0]
        restored.goto(board_url)
        restored.wait_for_selector('#app[data-ready="true"]')
        expect(restored.locator("#object-count")).to_contain_text("2")
        expect(restored.locator("#board-title")).not_to_have_text("正在打开画板")
        cache_urls = restored.evaluate("""async () => (await Promise.all((await caches.keys()).map(async key =>
          (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)))).flat()""")
        assert "/index.html" in cache_urls and not any(path.startswith("/api/") for path in cache_urls)
        ctx.set_offline(False)
        expect(restored.locator('#save-state')).to_have_attribute('data-state','saved',timeout=20000)
        def board():
            return ctx.request.get(url.rstrip('/')+'/api/boards/'+board_id).json()
        expires=time.monotonic()+20
        committed=board()
        while len(committed['items'])!=2 and time.monotonic()<expires:
            restored.wait_for_timeout(100)
            committed=board()
        assert len(committed['items']) == 2
        restored.reload()
        restored.wait_for_selector('#app[data-ready="true"]')
        expect(restored.locator("#object-count")).to_contain_text("2")
        assert board()['rev'] == committed['rev']
        report={'browser':ctx.browser.version if ctx.browser else 'Chromium','offlineTabs':2,'shutdown':'immediately after pen release' if immediate else 'after two confirmed journal commits',
            'strokesVisibleAfterOfflineRestart':2,'strokesOnServerAfterReconnect':2,
            'serverRevisionAfterReload':committed['rev'],'authenticatedApiEntriesInShellCache':0}
        ctx.close()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n")


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--url',default='http://127.0.0.1:3000')
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'evidence/offline-restart.json')
    parser.add_argument('--immediate',action='store_true',help='close directly after the second stroke, before waiting for persistence')
    args=parser.parse_args()
    run(args.url,args.output,args.immediate)
