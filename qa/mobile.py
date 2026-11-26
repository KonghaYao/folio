"""Exercise touch-only editor controls on phone and tablet Chromium layouts."""
import argparse
import json

from playwright.sync_api import expect, sync_playwright

from draw import OUTPUT, chromium, snapshot, wait_for_durable


def gesture(cdp, points):
    """Send one finger through Chromium's actual touch input path."""
    for index, (x, y) in enumerate(points):
        cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart" if index == 0 else "touchMove",
            "touchPoints": [{"x": x, "y": y, "radiusX": 2, "radiusY": 2, "force": 0.65}],
        })
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def exercise(browser, url, name, width, height):
    context = browser.new_context(
        base_url=url, viewport={"width": width, "height": height}, is_mobile=True, has_touch=True,
        device_scale_factor=2, locale="zh-CN",
    )
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    expect(page.locator("#app")).to_have_attribute("data-ready", "true")
    assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
    page.locator('[data-tool="pen"]').tap()
    page.get_by_role('button',name='蓝色',exact=True).tap()
    gesture(context.new_cdp_session(page), [
        (int(width * .30) + i * 4, int(height * .30) + i * 2) for i in range(18)
    ])
    expect(page.locator('#object-count')).to_have_text('1 个对象')
    page.locator('[data-action="undo"]:visible').first.tap()
    expect(page.locator('#object-count')).to_have_text('0 个对象')
    page.locator('[data-action="redo"]').tap()
    expect(page.locator('#object-count')).to_have_text('1 个对象')
    page.locator('[data-tool="shape"]').tap()
    page.locator('[data-fill="solid"]').tap()
    page.locator('[data-kind="ellipse"]').tap()
    gesture(context.new_cdp_session(page), [
        (int(width * .42) + i * 3, int(height * .45) + i * 2) for i in range(20)
    ])
    expect(page.locator('#object-count')).to_have_text('2 个对象')
    page.locator('[data-tool="select"]').tap()
    page.touchscreen.tap(int(width * .42) + 28, int(height * .45) + 19)
    page.get_by_label('更多选区操作').tap()
    page.get_by_role('button', name='格式', exact=True).tap()
    formatting = page.get_by_role('dialog', name='选区格式')
    formatting.get_by_label('颜色').fill('#ad563e')
    formatting.get_by_label('线型').select_option('dashed')
    formatting.get_by_role('button', name='应用格式').tap()
    page.get_by_label('更多选区操作').tap()
    page.get_by_role('button', name='置于底层', exact=True).tap()
    wait_for_durable(page)
    records = snapshot(page)['items'].values()
    ellipse = next(item for item in records if item.get('type') == 'geo')
    pen = next(item for item in records if item.get('type') == 'draw')
    assert ellipse['props']['color'] == '#ad563e' and ellipse['props']['dash'] == 'dashed'
    assert ellipse['z'] < pen['z']
    page.locator('[data-action="insert"]').tap()
    page.locator('[data-action="table"]').tap()
    table = page.get_by_role('dialog', name='插入表格')
    table.get_by_label('第1行第1列').fill('测试')
    table.get_by_text('保存表格', exact=True).tap()
    expect(page.locator('#object-count')).to_have_text('3 个对象')
    page.locator('[data-action="share"]').tap()
    share = page.get_by_role('dialog')
    share.get_by_text('生成邀请链接', exact=True).tap()
    expect(share.get_by_label('邀请链接',exact=True)).to_be_visible()
    share.get_by_role('button', name='关闭',exact=True).tap()
    page.locator('[data-action="library"]').tap()
    library = page.get_by_role('dialog', name='画板库')
    expect(library.get_by_text('未命名画板', exact=True)).to_be_visible()
    library.get_by_label('关闭画板库').tap()
    page.locator('[data-action="zoom-menu"]').tap()
    page.locator('[data-action="fit"]').tap()
    page.locator('[data-tool="select"]').tap()
    page.get_by_label('更多操作').tap()
    menu_bounds = page.locator('#popover').bounding_box()
    assert menu_bounds['x'] >= 0 and menu_bounds['x'] + menu_bounds['width'] <= width
    assert menu_bounds['y'] >= 0 and menu_bounds['y'] + menu_bounds['height'] <= height
    page.get_by_label('更多操作').tap()
    expect(page.locator('#save-state')).to_have_attribute('data-state', 'saved', timeout=15000)
    page.screenshot(path=OUTPUT / ('touch-' + name + '.png'))
    assert not errors, errors
    context.close()
    return {"formFactor": name, "viewport": [width, height], "touchDraw": True, "fingerUndoRedo": True,
            "touchFilledShape": True, "selectionFormatAndLayersPersisted": True, "canInsertTable": True, "canShare": True, "libraryAccess": True,
            "menuInsideViewport": True, "pageOverflow": False, "uncaughtErrors": errors}


def run(url):
    OUTPUT.mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = chromium(playwright)
        result = [exercise(browser, url, name, width, height) for name, width, height in
                  [('phone', 390, 844), ('small-phone', 320, 568), ('tablet', 820, 1180)]]
        browser.close()
    (OUTPUT / 'touch-devices.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    run(parser.parse_args().url)
