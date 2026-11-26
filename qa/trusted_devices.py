"""Disconnect paired and original browsers with active canvases, retaining both workspaces."""
import argparse
import json
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

from draw import OUTPUT, chromium, wait_for_durable


def board_id(page):
    return parse_qs(urlparse(page.url).query)['board'][0]


def open_devices(page):
    page.locator('[data-action=board-menu]').click()
    page.get_by_role('button', name='同步我的设备', exact=True).click()
    return page.get_by_role('dialog', name='同步我的设备')


def pair(source, target):
    dialog = open_devices(source)
    dialog.get_by_role('button', name='生成一次性配对链接').click()
    url = dialog.get_by_label('一次性设备配对链接').input_value()
    dialog.get_by_role('button', name='关闭', exact=True).click()
    target.goto(url)
    target.get_by_role('button', name='连接此设备').click()
    expect(target.locator('#app')).to_have_attribute('data-ready', 'true')
    assert board_id(target) == board_id(source)


def disconnect(manager, lost, origin):
    old = board_id(lost)
    dialog = open_devices(manager)
    rows = dialog.locator('.trusted-device')
    expect(rows).to_have_count(2)
    expect(dialog.locator('.trusted-device[data-current=true] button')).to_have_count(0)
    remote = dialog.locator('.trusted-device[data-current=false]')
    remote.get_by_role('button', name='断开设备').click()
    remote.get_by_role('button', name='确认断开').click()
    expect(rows).to_have_count(1)
    dialog.get_by_role('button', name='关闭', exact=True).click()
    forbidden = lost.get_by_role('dialog', name='无法继续访问画板')
    expect(forbidden).to_be_visible(timeout=16000)
    expect(lost.locator('#board-surface canvas')).to_have_count(0)
    forbidden.get_by_role('button', name='返回我的画板').click()
    expect(lost.locator('#app')).to_have_attribute('data-ready', 'true')
    assert lost.request.get(origin+'/api/boards/'+old).status in (403,404)
    assert old not in [x['id'] for x in lost.request.get(origin+'/api/boards').json()['boards']]
    assert manager.request.get(origin+'/api/boards/'+old).ok


def draw(page, x):
    page.locator('[data-tool=pen]').click()
    page.mouse.move(x,260)
    page.mouse.down()
    page.mouse.move(x+75,330,steps=10)
    page.mouse.up()
    expect(page.locator('#object-count')).to_have_text('1 个对象')
    wait_for_durable(page)


def run(url):
    origin = url.rstrip('/')
    errors = []
    with sync_playwright() as pw:
        browser = chromium(pw)
        def fresh():
            page = browser.new_context(base_url=origin).new_page()
            page.on('pageerror',lambda error: errors.append(str(error)))
            page.goto(origin)
            expect(page.locator('#app')).to_have_attribute('data-ready','true')
            return page
        owner, tablet = fresh(),fresh()
        owner_board, tablet_board = board_id(owner), board_id(tablet)
        draw(owner,310)
        draw(tablet,420)
        original_items = owner.request.get(origin+'/api/boards/'+owner_board).json()['items']
        tablet_items = tablet.request.get(origin+'/api/boards/'+tablet_board).json()['items']
        pair(owner,tablet)
        disconnect(owner,tablet,origin)
        assert board_id(tablet)==tablet_board
        assert tablet.request.get(origin+'/api/boards/'+tablet_board).json()['items']==tablet_items
        # The paired device can also remove a lost original browser. Its session
        # cookie must never silently regain the old cookie-derived principal.
        pair(owner,tablet)
        disconnect(tablet,owner,origin)
        assert board_id(owner) not in (owner_board,tablet_board)
        expect(owner.locator('#object-count')).to_have_text('0 个对象')
        owner.reload()
        expect(owner.locator('#app')).to_have_attribute('data-ready','true')
        assert owner.request.get(origin+'/api/boards/'+owner_board).status in (403,404)
        assert tablet.request.get(origin+'/api/boards/'+owner_board).json()['items']==original_items
        dialog = open_devices(tablet)
        dialog.get_by_role('button',name='切换工作区',exact=False).click()
        expect(tablet).to_have_url(origin+'/?board='+tablet_board)
        expect(tablet.locator('#app')).to_have_attribute('data-ready','true')
        assert tablet.request.get(origin+'/api/boards/'+tablet_board).json()['items']==tablet_items
        assert not errors, errors
        result = {'browser':browser.version,
                  'pairedBrowserRemovedFromOpenBoard':True,'pairedBrowserOriginalDataIntact':True,
                  'revokedOriginalBrowserReloadStayedIsolated':True,'sharedBoardInkIntact':True,
                  'originalAndPairedSessionsIndependent':True, 'pageErrors':errors}
        browser.close()
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT/'trusted-devices.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))


if __name__=='__main__':
    args=argparse.ArgumentParser(description=__doc__)
    args.add_argument('url')
    run(args.parse_args().url)
