"""Upgrade a populated v1 cache, then reopen a bounded record delta with the server offline."""

import argparse
import json
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from draw import chromium, OUTPUT


def note(key, text):
    return {
        "id": key,
        "typeName": "shape",
        "type": "note",
        "x": 20,
        "y": 30,
        "rot": 0,
        "z": 1,
        "props": {"text": text, "color": "yellow", "size": "m", "font": "sans"},
    }


def run(url, output):
    with sync_playwright() as pw, chromium(pw) as browser:
        ctx = browser.new_context(base_url=url)
        pg = ctx.new_page()
        # Seed the real v1 schema before any application code starts.
        pg.route(
            "**/seed-offline-cache", lambda route: route.fulfill(content_type="text/html", body="")
        )
        pg.goto("/seed-offline-cache")
        board = ctx.request.post("/api/boards", data={"title": "离线增量"}).json()
        path = "/api/boards/" + board["id"]

        def post(rev, puts, removes):
            response = ctx.request.post(
                path + "/ops",
                data={
                    "opId": "offline-delta-" + str(rev),
                    "baseRev": rev,
                    "put": {r["id"]: r for r in puts},
                    "remove": removes,
                },
            )
            assert response.ok, response.text()
            return response.json()["rev"]

        rev = post(board["rev"], [note("a", "即将替换"), note("b", "即将删除")], [])
        board = ctx.request.get(path).json()
        pg.evaluate(
            """async board => {
          const scope=document.cookie.match(/folio_cache=(\\w+)/)[1];
          const req=indexedDB.open('folio.offline.v1',1);
          req.onupgradeneeded=()=>{
            req.result.createObjectStore('boards',{keyPath:['scope','id']});
            req.result.createObjectStore('lists',{keyPath:'scope'});
            req.result.createObjectStore('drafts',{keyPath:['scope','board','lane']}).createIndex('board',['scope','board']);
          };
          const db=await new Promise((r,j)=>{req.onsuccess=()=>r(req.result);req.onerror=()=>j(req.error)});
          const tx=db.transaction('boards','readwrite');
          tx.objectStore('boards').put({scope,id:board.id,value:board});
          await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j}); db.close();
        }""",
            board,
        )
        pg.goto("/?board=" + board["id"])
        expect(pg.locator("#object-count")).to_have_text("2 个对象")
        pg.evaluate("navigator.serviceWorker.ready.then(()=>true)")
        pg.wait_for_function("!!navigator.serviceWorker.controller")
        rev = post(rev, [note("a", "更新保留"), note("c", "新增保留")], ["b"])
        persisted = """async rev => {
          const req=indexedDB.open('folio.offline.v1');
          const db=await new Promise(r=>{req.onsuccess=()=>r(req.result)});
          try {
            const tx=db.transaction(['boards','boardHeaders','boardChanges']);
            const rows=await Promise.all(['boards','boardHeaders','boardChanges'].map(name=>
              new Promise(r=>{const q=tx.objectStore(name).getAll();q.onsuccess=()=>r(q.result)})));
            return db.version===2 && rows[0][0]?.value.rev===rev-1 && rows[1][0]?.value.rev===rev &&
              rows[2].length===3 && rows[2].some(row=>row.id==='b' && row.value===null);
          } finally { db.close(); }
        }"""
        deadline = time.monotonic() + 8
        while not pg.evaluate(persisted, rev):
            if time.monotonic() > deadline:
                raise AssertionError("The peer delta did not commit to the offline cache")
            pg.wait_for_timeout(30)
        ctx.set_offline(True)
        pg.reload()
        expect(pg.locator("#object-count")).to_have_text("2 个对象")
        pg.locator('[data-action="more"]').click()
        pg.locator('[data-action="find"]').click()
        query, hits = pg.get_by_label("查找文本"), pg.get_by_role("search").locator("output")
        for text, expected in [("保留", "1 / 2"), ("即将", "无匹配结果")]:
            query.fill(text)
            expect(hits).to_have_text(expected)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(
                {
                    "browser": browser.version,
                    "legacySchema": 1,
                    "migratedSchema": 2,
                    "originalBaseRevision": board["rev"],
                    "recoveredRevision": rev,
                    "updated": 1,
                    "inserted": 1,
                    "removed": 1,
                    "verifiedThroughOfflineCanvasSearch": True,
                },
                indent=2,
            )
            + "\n"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--output", type=Path, default=OUTPUT / "offline-delta.json")
    options = parser.parse_args()
    run(options.url, options.output)
