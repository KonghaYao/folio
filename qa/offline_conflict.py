"""Edit one table cell in two disconnected tabs, close Chromium and recover both histories."""
import argparse
import json
import os
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from studio import choose_tool
from playwright.sync_api import expect,sync_playwright


def run(url, output):
    with tempfile.TemporaryDirectory(prefix='folio-offline-conflict-') as profile, sync_playwright() as runner:
        def launch():
            return runner.chromium.launch_persistent_context(profile,headless=True,
                executable_path=os.getenv('CHROMIUM_PATH'), viewport={'width':1200,'height':820},
                args=['--disable-dev-shm-usage'])
        ctx=launch()
        one=ctx.pages[0]
        one.goto(url)
        one.wait_for_selector('#app[data-ready="true"]')
        board_url=one.url
        board_id=parse_qs(urlparse(board_url).query)['board'][0]
        one.locator('[data-action="insert"]').click()
        one.locator('[data-action="table"]').click()
        def cell(tab):
            return tab.get_by_role('dialog').get_by_label('第2行第1列')
        cell(one).fill('共同初稿')
        one.get_by_role('button',name='保存表格').click()
        expect(one.locator('#save-state')).to_have_attribute('data-state','saved')
        two=ctx.new_page()
        two.goto(board_url)
        expect(two.locator('#object-count')).to_have_text('1 个对象')
        one.evaluate('navigator.serviceWorker.ready.then(()=>true)')
        one.wait_for_function('!!navigator.serviceWorker.controller')
        two.wait_for_timeout(400)
        ctx.set_offline(True)
        values=['左页的修改','右页的修改']
        for tab,value in zip([one,two],values):
            choose_tool(tab,"select")
            box=tab.locator('#board-surface').bounding_box()
            tab.mouse.dblclick(box['x']+box['width']/2,box['y']+box['height']/2)
            expect(cell(tab)).to_have_value('共同初稿')
            cell(tab).fill(value)
            tab.get_by_role('button',name='保存表格').click()
        drafts="""async () => {
          let db=await new Promise((r,j)=>{let o=indexedDB.open('folio.offline.v1');o.onsuccess=()=>r(o.result);o.onerror=()=>j(o.error)})
          const rows=await new Promise(r=>{let o=db.transaction('drafts').objectStore('drafts').getAll();o.onsuccess=()=>r(o.result)})
          db.close()
          return rows.map(r=>r.value.active?.opId).filter(Boolean)
        }"""
        deadline=time.monotonic()+8
        op_ids=one.evaluate(drafts)
        while len(op_ids)!=2 and time.monotonic()<deadline:
            one.wait_for_timeout(40)
            op_ids=one.evaluate(drafts)
        assert len(set(op_ids))==2,op_ids
        ctx.close()
        ctx=launch()
        ctx.set_offline(True)
        restored=ctx.pages[0]
        restored.goto(board_url)
        expect(restored.locator('#object-count')).to_have_text('2 个对象')
        attempts={}
        def record(response):
            req=response.request
            if req.method=='POST' and req.url.endswith('/ops'):
                attempts[req.post_data_json['opId']]=response.status
        restored.on('response',record)
        ctx.set_offline(False)
        expect(restored.locator('#save-state')).to_have_attribute('data-state','saved',timeout=20000)
        def rows():
            board=ctx.request.get(url.rstrip('/')+'/api/boards/'+board_id).json()
            return board['rev'],list(board['items'].values())
        deadline=time.monotonic()+15
        rev,items=rows()
        while len(items)!=2 and time.monotonic()<deadline:
            restored.wait_for_timeout(70)
            rev,items=rows()
        assert sorted(item['props']['cells'][1][0] for item in items)==sorted(values),items
        assert sum('conflictOf' in item['props'] for item in items)==1,items
        assert sorted(attempts.get(op) for op in op_ids)==[200,409],attempts
        restored.reload()
        expect(restored.locator('#object-count')).to_have_text('2 个对象')
        assert rows()[0]==rev
        report={'engine':ctx.browser.version,'independentOfflineTabs':2,'originalRequestsReplayed':2,
            'originalRequestStatuses':[200,409],'restoredCellValues':values,'conflictCopies':1,'revisionAfterReload':rev}
        ctx.close()
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--url',default='http://127.0.0.1:3000')
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'evidence/offline-conflict.json')
    args=parser.parse_args()
    run(args.url,args.output)
