"""An optional cross-engine pass using Linux WebKit and Chromium against the same Bun process."""
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

def run():
    bun=os.environ.get('BUN_PATH') or shutil.which('bun')
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as runner:
        env=dict(os.environ, FOLIO_DB=str(Path(tmp)/'cross.db'),HOST='127.0.0.1',PORT='0')
        api=subprocess.Popen([bun,'service/index.js'], cwd=ROOT,env=env,stdout=subprocess.PIPE,text=True)
        try:
            base=api.stdout.readline().strip().split()[-1].rstrip('/')
            chromium=runner.chromium.launch(headless=True,executable_path=os.getenv('CHROMIUM_PATH'))
            webkit=runner.webkit.launch(headless=True, executable_path=os.getenv('WEBKIT_PATH'))
            desktop=chromium.new_page(viewport={'width':1200,'height':820})
            tablet=webkit.new_page(viewport={'width':1000,'height':716}, device_scale_factor=2,has_touch=True)
            errors=[]
            for page in [desktop,tablet]:page.on('pageerror',lambda err:errors.append(str(err)))
            desktop.goto(base);expect(desktop.locator('#app')).to_have_attribute('data-ready','true')
            desktop.locator('[data-action=board-menu]:visible').first.click()
            desktop.locator('[data-action=devices]:visible').first.click()
            desktop.get_by_role('button',name='生成一次性配对链接').click()
            token=desktop.get_by_label('一次性设备配对链接').input_value()
            desktop.get_by_role('dialog').get_by_role('button',name='关闭',exact=True).click()
            tablet.goto(token)
            tablet.get_by_role('button',name='连接此设备').click()
            expect(tablet.locator('#app')).to_have_attribute('data-ready','true')
            def stroke(page,x,y):
                page.locator('[data-tool=pen]:visible').first.click()
                page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+95,y+40,steps=10);page.mouse.up()
            def objects(page,n):
                expect(page.locator('#object-count')).to_have_text(f'{n} 个对象',timeout=15000)
            stroke(desktop,500,360);objects(tablet,1)
            stroke(tablet,470,475);objects(desktop,2)
            deadline=time.monotonic()+8
            while True:
                image=Image.open(io.BytesIO(tablet.screenshot(scale='css'))).convert('RGB')
                visible_ink=sum(max(px)<155 for px in image.crop((475,470,565,520)).getdata())
                if visible_ink>65 or time.monotonic()>deadline:break
                tablet.wait_for_timeout(120)
            assert visible_ink>65, f"Only {visible_ink} visible ink pixels in the WebKit screenshot."
            tablet.reload()
            expect(tablet.locator('#app')).to_have_attribute('data-ready','true')
            objects(tablet,2)
            assert not errors,errors
            report={'webkit':webkit.version,'chromium':chromium.version,'implementation':'Linux Playwright WPE WebKit',
                    'tabletCssViewport':[1000,716],'dpr':2,'crossEngineTwoWayEdits':True,'itemsAfterWebKitReload':2,'visibleInkPixels':visible_ink,'pageErrors':errors}
            (ROOT/'evidence/webkit-sync.json').write_text(json.dumps(report,indent=2)+'\n')
            print(report)
        finally:
            api.terminate();api.wait(timeout=6)

if __name__=='__main__':run()
