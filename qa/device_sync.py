"""Drive two isolated web clients, lose network, close/reopen the tab, kill and restart Bun."""
import argparse
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from studio import choose_tool
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def port_number():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def run(bun, executable):
    port = port_number()
    base = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory() as folder:
        directory = Path(folder)
        env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', FOLIO_DB=str(directory/'boards.db'))
        def launch():
            proc = subprocess.Popen([bun, 'server/index.ts'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL)
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/api/health',timeout=1) as r:
                        if r.status==200:return proc
                except OSError: time.sleep(.04)
            raise RuntimeError('Bun health endpoint did not start')
        service=launch()
        checks=[]
        errors=[]
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(headless=True,executable_path=executable,args=['--disable-dev-shm-usage'])
                a=browser.new_context(viewport={'width':1200,'height':800})
                b=browser.new_context(viewport={'width':834,'height':1112},has_touch=True,device_scale_factor=1)
                def tab(context):
                    page=context.new_page()
                    page.set_default_timeout(9500)
                    page.on('pageerror',lambda e: errors.append(str(e)))
                    return page
                p,q=tab(a),tab(b)
                def ready(page):
                    expect(page.locator('#app')).to_have_attribute('data-ready','true',timeout=12000)
                def count(page,n):
                    expect(page.locator('#object-count')).to_have_text(f'{n} 个对象',timeout=15000)
                def action(page,name):
                    page.locator('[data-action="'+name+'"]:visible').first.click()
                def line(page,x,y):
                    choose_tool(page,'pen')
                    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+70,y+25,steps=10);page.mouse.up()
                def library(page):
                    page.get_by_role('button',name='画板库',exact=True).click()
                    return page.get_by_role('dialog',name='画板库')
                def snap(page,id_):
                    return page.request.get(base+'/api/boards/'+id_).json()
                p.goto(base);ready(p)
                q.goto(base);ready(q)
                initial_q=q.url
                url=p.url
                from urllib.parse import parse_qs,urlparse
                board=parse_qs(urlparse(url).query)['board'][0]
                line(p,380,340);count(p,1)
                action(p,'board-menu');action(p,'devices')
                p.get_by_role('button',name='生成一次性配对链接').click()
                link=p.get_by_label('一次性设备配对链接').input_value()
                p.get_by_role('dialog').get_by_role('button',name='关闭',exact=True).click()
                q.goto(link);q.get_by_role('button',name='连接此设备').click()
                ready(q);count(q,1)
                assert parse_qs(urlparse(q.url).query)['board'][0]==board
                checks.append('Independent desktop and tablet cookie jars paired into the same personal workspace')
                # Alternate in both directions through the visible pen tool.
                line(q,390,440);count(p,2)
                line(p,420,420);count(q,3)
                assert snap(p,board)['items']==snap(q,board)['items']
                checks.append('Bidirectional object sync converged with identical persisted records')
                lp=library(p)
                lp.get_by_role('button',name='新建文件夹').click()
                lp.get_by_role('textbox',name='文件夹名称').fill('跨设备画册')
                lp.get_by_role('button',name='保存',exact=True).click()
                expect(lp.get_by_role('heading',name='跨设备画册')).to_be_visible()
                lq=library(q);expect(lq.get_by_role('button',name='跨设备画册',exact=True)).to_be_visible()
                lp.get_by_role('button',name='关闭画板库').click();lq.get_by_role('button',name='关闭画板库').click()
                checks.append('Folder created on desktop visible in paired tablet library')
                q.evaluate('navigator.serviceWorker.ready.then(()=>true)')
                q.reload();ready(q)
                q.wait_for_function('Boolean(navigator.serviceWorker.controller)')
                b.set_offline(True)
                line(q,350,550);count(q,4)
                # Allow the visible app to journal the stroke, then close this tab entirely.
                q.wait_for_timeout(800)
                q.close()
                line(p,550,390);count(p,4)
                q=tab(b)
                q.goto(base);ready(q);count(q,4)
                assert q.url==url
                checks.append('With networking disabled, a newly opened tab restored the cached shell, board and unacknowledged stroke')
                line(q,430,640);count(q,5)
                b.set_offline(False);count(q,6);count(p,6)
                expect(q.locator('#save-state')).to_have_attribute('data-state','saved')
                before=snap(q,board)
                assert len(before['items'])==6 and snap(p,board)['items']==before['items']
                checks.append('Two offline strokes and a concurrent online stroke converged exactly once')
                service.kill();service.wait(timeout=5);service=launch()
                p.reload();q.reload();ready(p);ready(q);count(p,6);count(q,6)
                after=snap(p,board)
                assert after['rev']==before['rev'] and after['items']==before['items']
                line(q,450,680);count(p,7)
                checks.append('SIGKILL and cold start recovered identical SQLite revision and records; paired devices resumed editing')
                # The original tablet workspace remained accessible and isolated.
                action(q,'board-menu');action(q,'devices')
                q.get_by_role('button',name='切换工作区',exact=False).click()
                expect(q).to_have_url(initial_q, timeout=10000)
                ready(q);count(q,0)
                checks.append('Switching back restores the tablet’s original workspace without overwriting it')
                assert not errors,errors
                return {'browser':browser.version,'deviceProfiles':['desktop 1200x800','touch tablet 834x1112'],
                        'beforeCrashRevision':before['rev'],'restoredRevision':after['rev'],'checks':checks,'pageErrors':errors}
        finally:
            service.kill();service.wait(timeout=5)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--bun',default=shutil.which('bun'))
    parser.add_argument('--chromium',default=os.getenv('CHROMIUM_PATH'))
    args=parser.parse_args();result=run(args.bun,args.chromium)
    out=ROOT/'evidence/device-sync.json';out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(out.read_text())
