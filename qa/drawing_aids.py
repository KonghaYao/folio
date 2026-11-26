"""Exercise ink masks, ruler, lasso, interrupted input and cross-board attachment copy."""

import argparse
import math
import statistics
import base64
import io
import json
from urllib.parse import urlparse, parse_qs

from PIL import Image
from playwright.sync_api import expect, sync_playwright
from draw import OUTPUT, chromium, wait_for_durable
from studio import choose_tool, click_action, set_ink_width
from sharing import open_invite


def paper_metrics(image):
    region=image.convert('L').crop((420, 600, 1060, 1200))
    w,h=region.size
    tone=region.tobytes()
    horizontal=[255-statistics.mean(tone[x::w]) for x in range(w)]
    vertical=[255-statistics.mean(tone[y*w:(y+1)*w]) for y in range(h)]
    def pitch(profile):
        peaks=[i for i in range(1,len(profile)-1) if profile[i]>.25 and
               profile[i]>profile[i-1] and profile[i]>=profile[i+1]]
        return round(statistics.linear_regression(range(len(peaks)),peaks).slope,4)
    return {"pitchPhysicalPx":[pitch(horizontal),pitch(vertical)],"minimumIntensity":min(tone),
            "meanIntensity":round(statistics.mean(tone),4),"whiteFraction":round(tone.count(255)/len(tone),5)}


def compare_paper(browser,url):
    # Reference screenshot is 2048×1548 pixels. The neutral crop is clear of app chrome and ink.
    reference={"pitchPhysicalPx":[11.5755,11.5763],"minimumIntensity":229,"meanIntensity":252.9447,"whiteFraction":0.80921}
    ctx=browser.new_context(base_url=url,viewport={"width":1024,"height":774},device_scale_factor=2)
    try:
        page=ctx.new_page()
        page.goto(url)
        expect(page.locator('#app')).to_have_attribute('data-ready','true')
        def capture():
            encoded=page.locator('.qd-canvas').evaluate("canvas=>canvas.toDataURL('image/png')")
            return paper_metrics(Image.open(io.BytesIO(base64.b64decode(encoded.split(',')[1]))))
        full=capture()
        cdp=ctx.new_cdp_session(page)
        cdp.send('Input.dispatchMouseEvent',dict(type='mouseWheel',x=320,y=330,deltaX=0,
            deltaY=2*math.log(4)/.012,modifiers=2))
        expect(page.locator('#zoom-value')).to_have_text('25%')
        scaled=capture()
        assert all(abs(a-b)<.12 for a,b in zip(scaled['pitchPhysicalPx'],reference['pitchPhysicalPx'])),scaled
        assert abs(scaled['meanIntensity']-reference['meanIntensity'])<.2 and scaled['minimumIntensity']==229,scaled
        assert abs(scaled['whiteFraction']-reference['whiteFraction'])<.02,scaled
        assert abs(full['pitchPhysicalPx'][0]-46.3)<.15,full
        return {"reference":reference,"at25Percent":scaled,"at100Percent":full,"deviceScaleFactor":2,
                "viewportCss":[1024,774],"cropPhysicalPx":[420,600,1060,1200]}
    finally:
        ctx.close()

def run(url):
    OUTPUT.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        browser = chromium(pw)
        paper=compare_paper(browser,url)
        ctx = browser.new_context(base_url=url, viewport={"width": 1280, "height": 820},
                                  permissions=["clipboard-read", "clipboard-write"], device_scale_factor=1)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(url)
        expect(pg.locator("#app")).to_have_attribute("data-ready", "true")
        act = lambda key: pg.locator(f'[data-action="{key}"]:visible').first
        board_id = lambda: parse_qs(urlparse(pg.url).query)["board"][0]
        snapshot = lambda: pg.request.get("/api/boards/" + board_id()).json()

        def options():
            click_action(pg, "drawing-options")
            return pg.get_by_role("dialog", name="绘图辅助")

        def pixel(x, y):
            return Image.open(io.BytesIO(pg.screenshot())).convert("RGB").getpixel((x, y))

        choose_tool(pg, "pen")
        pg.locator("#ink-color").fill("#182d20")
        set_ink_width(pg, 14)
        dlg = options()
        dlg.get_by_label("使用直尺").check()
        dlg.get_by_label("直尺角度").fill("0")
        dlg.get_by_role("button", name="完成").click()
        pg.mouse.move(340, 300)
        pg.mouse.down()
        pg.mouse.move(680, 375, steps=20)
        pg.mouse.up()
        wait_for_durable(pg)
        stroke = next(iter(snapshot()["items"].values()))
        assert max(abs(d) for d in stroke["props"]["pts"][1::3]) == 0
        dlg = options()
        dlg.get_by_label("使用直尺").uncheck()
        dlg.get_by_label("局部橡皮直径").fill("32")
        dlg.get_by_role("button", name="局部橡皮", exact=True).click()
        before = pixel(510, 300)
        pg.mouse.move(510, 258)
        pg.mouse.down()
        pg.mouse.move(510, 340, steps=15)
        pg.mouse.up()
        wait_for_durable(pg)
        after = pixel(510, 300)
        assert min(after) > 200 and max(before) < 160, (before, after)
        assert max(pixel(450, 300)) < 160
        assert len(snapshot()["items"][stroke["id"]]["props"]["erasures"]) == 1
        click_action(pg, "undo")
        wait_for_durable(pg)
        assert max(pixel(510, 300)) < 160
        click_action(pg, "redo")
        wait_for_durable(pg)
        assert min(pixel(510, 300)) > 200
        dlg = options()
        dlg.get_by_role("button", name="套索选择").click()
        pg.mouse.move(319, 268)
        pg.mouse.down()
        for x, y in [(705, 268), (705, 335), (319, 335), (319, 268)]:
            pg.mouse.move(x, y, steps=5)
        pg.mouse.up()
        expect(pg.locator("#selection-count")).to_have_text("已选 1 项")

        # A platform cancel can arrive after one or more complete storage-sized
        # segments. Start it with native input, replay a coalesced device packet
        # through DOM PointerEvents, then verify the server observed no operation.
        choose_tool(pg, "pencil")
        pg.evaluate("""()=>document.querySelector('.qd-canvas').addEventListener('pointerdown',
          e=>window.__interruptedPointer=e.pointerId,{once:true,capture:true})""")
        cdp = ctx.new_cdp_session(pg)
        cdp.send("Input.dispatchMouseEvent", {"type":"mousePressed","x":370,"y":510,
            "pointerType":"pen","button":"left","buttons":1,"force":0.7,"clickCount":1})
        old_rev = snapshot()["rev"]
        pg.evaluate("""() => {
          const target=document.querySelector('.qd-canvas'), id=window.__interruptedPointer;
          const packet=Array.from({length:2054},(_,i)=>new PointerEvent('pointermove',
            {bubbles:true,pointerId:id,pointerType:'pen',buttons:1,pressure:.7,
             clientX:370+i/16,clientY:510+(i%2)}));
          const event=packet[packet.length-1];
          Object.defineProperty(event,'getCoalescedEvents',{value:()=>packet});
          target.dispatchEvent(event);
        }""")
        pg.wait_for_timeout(400)
        assert snapshot()["rev"] == old_rev, "unfinished pen stroke reached the server"
        pg.evaluate("""()=>document.querySelector('.qd-canvas').dispatchEvent(new PointerEvent(
          'pointercancel',{bubbles:true,pointerId:window.__interruptedPointer,pointerType:'pen'}))""")
        cdp.send("Input.dispatchMouseEvent", {"type":"mouseReleased","x":498,"y":511,"pointerType":"pen",
            "button":"left","buttons":0,"force":0,"clickCount":1})
        wait_for_durable(pg)
        assert snapshot()["rev"] == old_rev

        # Copy an image via keyboard, paste into a different private board, and
        # open it from a fresh profile that can read only the destination.
        file = io.BytesIO()
        Image.new("RGB", (120, 90), (230, 80, 36)).save(file, format="PNG")
        pg.locator("#file-picker").set_input_files({"name":"Orange.png","mimeType":"image/png","buffer":file.getvalue()})
        expect(pg.locator("#object-count")).to_have_text("2 个对象")
        wait_for_durable(pg)
        src = next(r["src"] for r in snapshot()["items"].values() if r["typeName"]=="asset")
        pg.locator("#board-surface").focus()
        pg.keyboard.press("Control+c")
        pg.wait_for_function("""async()=>{try{return JSON.parse(await navigator.clipboard.readText()).shapes[0].type==='image'}catch{return false}}""")
        act("board-menu").click()
        act("new").click()
        pg.get_by_label("画板名称").fill("Copy destination")
        pg.get_by_role("button", name="创建画板").click()
        expect(pg.locator("#object-count")).to_have_text("0 个对象")
        pg.locator("#board-surface").focus()
        pg.keyboard.press("Control+v")
        expect(pg.locator("#object-count")).to_have_text("1 个对象", timeout=10000)
        wait_for_durable(pg)
        dst = next(r["src"] for r in snapshot()["items"].values() if r["typeName"]=="asset")
        assert dst != src and dst.startswith("/api/boards/" + board_id() + "/assets/")
        viewer = open_invite(pg, "viewer", browser, url)
        assert viewer.request.get(src).status in (403,404)
        assert viewer.request.get(dst).body() == file.getvalue()
        assert not errors, errors
        result={"browser": browser.version, "paper":paper,"rulerOutputVerticalRange":0, "lassoSelection":1,
            "partialEraseRGB":{"before":before,"after":after},"partialEraseUndoRedo":True,
            "canceledCoalescedSamples":2054,"canceledServerRevisionDelta":0,
            "crossBoardClipboardImageReadableByDestinationOnlyViewer":True,"pageErrors":errors}
        (OUTPUT/"drawing-aids.json").write_text(json.dumps(result,indent=2)+"\n")
        print(json.dumps(result))


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("url",nargs="?",default="http://127.0.0.1:3000")
    run(parser.parse_args().url)
