"""Real UI object editing and divergent edits on separate browsers."""
import argparse
import json
from pathlib import Path

from studio import choose_tool
from playwright.sync_api import expect,sync_playwright
from draw import chromium
ROOT=Path(__file__).resolve().parents[1]

def verify(url):
    checks=[]
    with sync_playwright() as runner:
        browser=chromium(runner)
        a=browser.new_context(viewport={'width':1200,'height':820})
        b=browser.new_context(viewport={'width':1200,'height':820})
        owner=a.new_page();peer=b.new_page();errors=[]
        for pg in (owner,peer):pg.on('pageerror',lambda err:errors.append(str(err)))
        def action(pg,name):pg.locator('[data-action="'+name+'"]:visible').first.click()
        def ready(pg):expect(pg.locator('#app')).to_have_attribute('data-ready','true',timeout=12000)
        def count(pg,n):expect(pg.locator('#object-count')).to_have_text(f'{n} 个对象',timeout=15000)
        def cells(pg):return pg.get_by_role('dialog').get_by_label('第2行第1列')
        owner.goto(url);ready(owner)
        action(owner,'insert');action(owner,'table')
        cells(owner).fill('初稿')
        owner.get_by_role('button',name='保存表格').click();count(owner,1)
        action(owner,'board-menu');action(owner,'devices')
        owner.get_by_role('button',name='生成一次性配对链接').click()
        link=owner.get_by_label('一次性设备配对链接').input_value()
        owner.get_by_role('dialog').get_by_role('button',name='关闭',exact=True).click()
        peer.goto(link);peer.get_by_role('button',name='连接此设备').click();ready(peer);count(peer,1)
        # Both browsers begin with the same table object, centered at initial zoom.
        def center_table(pg):
            choose_tool(pg,"select")
            box=pg.locator('#board-surface').bounding_box()
            pg.mouse.dblclick(box['x']+box['width']/2,box['y']+box['height']/2)
            expect(cells(pg)).to_have_value('初稿')
        center_table(peer);b.set_offline(True)
        cells(peer).fill('平板离线修改');peer.get_by_role('button',name='保存表格').click()
        center_table(owner)
        cells(owner).fill('桌面在线修改');owner.get_by_role('button',name='保存表格').click()
        expect(owner.locator('#save-state')).to_have_attribute('data-state','saved')
        owner.wait_for_timeout(350);b.set_offline(False)
        count(peer,2);count(owner,2)
        board=owner.url.split('board=')[1];doc=owner.request.get(url+'/api/boards/'+board).json()
        assert sorted(x['props']['cells'][1][0] for x in doc['items'].values())==sorted(['平板离线修改','桌面在线修改'])
        assert sum('conflictOf' in x['props'] for x in doc['items'].values())==1
        checks.append('Concurrent edits to the same table cell recovered both authors’ values on both devices')
        action(owner,'insert');action(owner,'diagram')
        owner.get_by_role('dialog').get_by_role('textbox').fill('申请\n审批\n完成')
        owner.get_by_role('dialog').get_by_role('button',name='插入流程图').click()
        count(peer,7)
        action(owner,'inspect')
        owner.get_by_role('dialog').get_by_label('对象描述').fill('业务入口')
        owner.get_by_role('dialog').get_by_label('锁定位置与内容').check()
        owner.get_by_role('button',name='应用').click()
        owner.keyboard.press('Delete')
        count(owner,7)
        expect(owner.locator('#save-state')).to_have_attribute('data-state','saved')
        owner.wait_for_timeout(350)
        final=peer.request.get(url+'/api/boards/'+board).json()['items']
        links=[s for s in final.values() if s['type']=='arrow']
        assert len(links)==2 and all('bindings' in s['props'] for s in links)
        assert any(s['props'].get('description')=='业务入口' and s['props']['locked'] for s in final.values())
        checks.extend(['Three labeled diagram nodes and two bound arrows replicated','Object description and lock survived Delete and synchronized'])
        assert not errors,errors
        result={'browser':browser.version,'checks':checks,'pageErrors':errors}
        out=ROOT/'evidence/objects-sync.json';out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--url',default='http://127.0.0.1:3000')
    print(verify(parser.parse_args().url.rstrip('/')))
