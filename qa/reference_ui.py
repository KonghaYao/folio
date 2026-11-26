"""Measure the native Freeform reference's controls at their photographed positions.

Use --reference-image with the user's 2048x1548 original for visual comparison.
The deterministic geometry, color and interaction checks can run without that image.
"""
import argparse
import hashlib
import json
import os
from urllib.parse import urlparse,parse_qs
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import distance_transform_edt
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CROP = (24,56,2024,1488)
CSS_SIZE = (1000,716)
DPR = 2
# Immutable hand-measured group extents in CSS pixels in the app-only coordinate system.
GROUPS = {
    "back": ("[data-shell=back]", [9,5.5,41.5,41.5]),
    "creation": ("[data-shell=creation]", [341,5.5,317.5,41.5]),
    "overview": ("[data-shell=overview]", [745,5.5,41.5,41.5]),
    "actions": ("[data-shell=actions]", [796.5,5.5,143,41.5]),
    "compose": ("[data-shell=compose]", [949.5,5.5,41.5,41.5]),
    "pen_tray": (".tool-rail", [18.5,76.5,93,549]),
    "scene_controls": ("[data-shell=scene-controls]", [18.5,665.5,260,42]),
    "view_controls": ("[data-shell=view-controls]", [855,665.5,127,42]),
}
# Source-pixel foreground ROIs, grouped equally by functional section rather than by white area.
# The third value limits min(R,G,B) for the ink mask. Faint tools need a brighter threshold.
ROIS = {
    "navigation": [
        ("back-chevron", (52,80,116,136),174), ("board-title",(139,84,347,137),164),
        ("title-menu",(351,86,394,133),230),
    ],
    "creation": [
        ("ink",(722,81,782,136),172), ("text",(831,80,890,134),172),
        ("shapes",(939,78,1000,136),172), ("note",(1049,79,1110,135),172),
        ("table",(1155,77,1220,136),172), ("attachment",(1261,76,1327,140),172),
    ],
    "commands": [
        ("overview",(1523,76,1586,139),172), ("undo",(1629,77,1689,137),199),
        ("share",(1729,75,1789,140),172), ("more",(1829,89,1888,126),172),
        ("compose",(1936,75,1998,141),172),
    ],
    "tray-actions": [
        ("tray-undo",(84,278,148,344),230), ("tray-redo",(157,278,223,344),230),
        ("tray-options",(118,1205,190,1273),230),
    ],
    "drawing-instruments": [
        ("first-instrument",(61,367,220,417),237), ("pen",(61,446,222,503),236),
        ("technical-pen",(61,532,220,586),236), ("highlighter",(61,613,219,671),236),
        ("eraser",(61,700,219,756),236), ("lasso",(61,784,219,845),236),
        ("ruler",(61,860,219,931),236),
    ],
    "bottom-navigation": [
        ("zoom",(90,1407,179,1455),174), ("previous",(224,1401,272,1457),202),
        ("scenes",(304,1402,364,1459),174), ("next",(400,1402,447,1459),202),
        ("favorite",(480,1400,558,1460),174),
    ],
    "bottom-view": [
        ("connections",(1775,1400,1847,1464),174), ("board-grid",(1881,1401,1940,1464),174)
    ],
}
# Native screenshot's five solid paint wells. The sixth is an angle-dependent hue selector.
WELLS = {"yellow": ((116,998),[254,208,47]), "black": ((190,998),[0,0,0]),
    "red": ((116,1068),[252,48,66]), "blue": ((190,1068),[22,126,251]),
    "green": ((190,1138),[83,215,105])}
PAPER = (145,205,450,525)
WEIGHTS = {"geometry":0.30, "control_ink":0.50, "swatches":0.15, "paper":0.05}


def crop_roi(array, rect):
    x,y,r,b=rect
    return array[y-CROP[1]:b-CROP[1],x-CROP[0]:r-CROP[0],:3]


def iou(a,b):
    intersection=max(0,min(a[0]+a[2],b[0]+b[2])-max(a[0],b[0]))*max(0,min(a[1]+a[3],b[1]+b[3])-max(a[1],b[1]))
    return intersection/max(1,a[2]*a[3]+b[2]*b[3]-intersection)


def bbox(mask):
    yy,xx=np.nonzero(mask)
    return [] if not len(xx) else [int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)]


def score_ink(ref,actual,templates=None):
    sections={}
    for name,parts in ROIS.items():
        details=[]
        for part,rect,threshold in parts:
            b=crop_roi(actual,rect).astype(float)
            right=b.min(axis=2)<threshold
            if ref is not None:
                a=crop_roi(ref,rect).astype(float)
                left=a.min(axis=2)<threshold
            else:
                left=np.unpackbits(templates[part],count=right.size).reshape(right.shape).astype(bool)
            # No true negatives are counted. Both missing ink and extraneous ink lower the score.
            precision=recall=0.
            if left.any() and right.any():
                precision=float((distance_transform_edt(~left)[right] <= 3).mean())
                recall=float((distance_transform_edt(~right)[left] <= 3).mean())
            f1=2*precision*recall/(precision+recall) if precision+recall else 0.
            union=left|right
            raw=1-float(np.abs(a-b)[union].mean())/255 if ref is not None and union.any() else None
            details.append({"control":part,"sourceRoi":rect,"precision":round(precision,4),"recall":round(recall,4),
                "f1":round(f1,4),"rawRgbAgreementOnForegroundUnion":round(raw,4) if raw is not None else None,
                "sourceForegroundPx":int(left.sum()),"browserForegroundPx":int(right.sum()),
                "sourceInkBoundsInRoi":bbox(left),"browserInkBoundsInRoi":bbox(right)})
        sections[name]={"meanF1":round(float(np.mean([part['f1'] for part in details])),4),"controls":details}
    return sections


def swatches(picture):
    result={}
    for name,((x,y),target) in WELLS.items():
        sample=crop_roi(picture,(x-5,y-5,x+6,y+6))
        color=np.median(sample.reshape(-1,3),axis=0)
        # Within the native 64x64px search cell, check the contiguous well instead of the page color.
        patch=crop_roi(picture,(x-32,y-32,x+33,y+33)).astype(float)
        matched=np.max(np.abs(patch-np.array(target)),axis=2)<35
        bounds=bbox(matched)
        delta=float(np.abs(color-np.array(target)).max())
        result[name]={"targetRgb":target,"browserRgb":color.astype(int).tolist(),"maxRgbDelta":delta,
            "diameterCssPx":round(((bounds[2]-bounds[0]+bounds[3]-bounds[1])/4) if bounds else 0,2),
            "agreement":round(max(0,1-delta/255),4)}
    return result


def paper(picture):
    x,y,r,b=PAPER
    tile=picture[y*DPR:b*DPR,x*DPR:r*DPR,:3]
    intensity=255-tile.astype(float).mean(axis=2)
    # Refine the dominant grid frequency with a local Fourier maximum for sub-pixel spacing.
    def pitch(signal):
        signal=signal-signal.mean()
        n=len(signal)
        if np.abs(signal).max()<.01:return None
        frequencies=np.linspace(1/14,1/9,600)
        energy=np.abs(np.exp(-2j*np.pi*frequencies[:,None]*np.arange(n)) @ (signal*np.hanning(n)))
        return round(float(1/frequencies[energy.argmax()]),3)
    return {"pitchXphysicalPx":pitch(intensity.mean(axis=0)), "pitchYphysicalPx":pitch(intensity.mean(axis=1)),
        "meanLuminance":round(float(255-intensity.mean()),3), "inkPercentile":round(float(np.percentile(255-intensity,0.2)),1),
        "pureWhiteFraction":round(float((intensity<0.5).mean()),4)}


def montage(reference, actual, output):
    # Source is downsampled and placed alongside the browser render only in this optional QA output.
    width=980; height=width*CSS_SIZE[1]//CSS_SIZE[0]
    photo=Image.new('RGB',(width*2+48,height+66),'#ecece9')
    draw=ImageDraw.Draw(photo)
    regular=ImageFont.truetype('DejaVuSans.ttf',17)
    draw.text((16,12),'REFERENCE  /  native app crop',fill='#232323',font=regular)
    draw.text((width+32,12),'BROWSER  /  Chromium, 1000 x 716 CSS px, DPR 2',fill='#232323',font=regular)
    for x,im in ((16,reference),(width+32,actual)):
        photo.paste(im.resize((width,height),Image.Resampling.LANCZOS),(x,44))
    photo.save(output,optimize=True)


def verify(url, ref_path, outdir, strict=True):
    outdir.mkdir(exist_ok=True,parents=True)
    errors=[]
    with sync_playwright() as runner:
        browser=runner.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'),
            args=['--disable-dev-shm-usage'])
        ctx=browser.new_context(viewport={"width":CSS_SIZE[0],"height":CSS_SIZE[1]},device_scale_factor=DPR,
            has_touch=True, locale='zh-CN', color_scheme='light')
        page=ctx.new_page()
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(url,wait_until='domcontentloaded')
        expect(page.locator('#app')).to_have_attribute('data-ready','true',timeout=20000)
        page.locator('[data-action=board-menu]:visible').first.click()
        sample=page.get_by_text('打开示例画板',exact=True)
        if not sample.count():
            page.keyboard.press('Escape')
            page.locator('[data-action=more]:visible').first.click()
            sample=page.get_by_text('打开示例画板',exact=True)
        sample.click()
        expect(page.locator('#board-title')).to_have_text('Agent Design',timeout=20000)
        expect(page.locator('#zoom-value')).to_have_text('25%')
        expect(page.locator('.tool-rail')).to_be_visible()
        page.evaluate('document.fonts.ready.then(()=>true)')
        page.mouse.move(675,350)
        page.wait_for_timeout(320)
        # Screenshot and geometry both come from the real foreground DOM after UI navigation.
        screenshot=outdir/'reference-studio.png'
        page.screenshot(path=str(screenshot),animations='disabled',scale='device')
        geometry={}
        for name,(locator,target) in GROUPS.items():
            node=page.locator(locator).first
            bounds=node.bounding_box() if node.count() else None
            actual=[bounds[k] for k in ['x','y','width','height']] if bounds else [0]*4
            geometry[name]={"targetCss":target,
                "normalizedTargetXYWH":[round(v/size,5) for v,size in zip(target,(*CSS_SIZE,*CSS_SIZE))],
                "browserCss":[round(v,2) for v in actual],
                "maxCoordinateDeltaCss":round(max(abs(a-b) for a,b in zip(actual,target)),2),
                "intersectionOverUnion":round(iou(actual,target),4)}
        # A screenshot pasted into an empty board could match pixels but would fail this contract.
        board_id=parse_qs(urlparse(page.url).query)['board'][0]
        board=page.request.get(url.rstrip('/')+'/api/boards/'+board_id).json()
        kinds={}
        for record in board['items'].values():
            kind=record.get('type','unknown')
            kinds[kind]=kinds.get(kind,0)+1
        assert kinds.get('text',0)>=20 and kinds.get('geo',0)>=10 and kinds.get('arrow',0)+kinds.get('line',0)>=6,kinds
        tray=page.locator('.tool-rail')
        toggle=page.locator('[data-action=tray-toggle]')
        toggle.click();expect(tray).to_be_hidden()
        toggle.click();expect(tray).to_be_visible()
        page.locator('[data-shell=overview]').click()
        details=page.get_by_role('dialog',name='画板信息')
        expect(details).to_contain_text('Agent Design')
        details.get_by_role('button',name='关闭').click()
        expect(details).to_have_count(0)
        version=browser.version
        browser.close()

    render=Image.open(screenshot).convert('RGB')
    if render.size != (2000,1432): raise RuntimeError(f'Unexpected screenshot {render.size}')
    pixels=np.array(render)
    wells=swatches(pixels)
    paperMetrics=paper(pixels)
    coords=float(np.mean([v['intersectionOverUnion'] for v in geometry.values()]))
    color=float(np.mean([v['agreement'] for v in wells.values()]))
    expectedPaper={"pitchXphysicalPx":11.576,"pitchYphysicalPx":11.576,"meanLuminance":252.945,"inkPercentile":229.0}
    observed=paperMetrics
    paperPass=all(observed[k] is not None and abs(observed[k]-v)<=margin for k,v,margin in (
        ('pitchXphysicalPx',11.576,.35),('pitchYphysicalPx',11.576,.35),('meanLuminance',252.945,1.4),('inkPercentile',229,8)))
    result={"engine":'Chromium '+version,"viewportCss":CSS_SIZE,"deviceScaleFactor":DPR,
        "sourceCropOriginalPixels":CROP,"sourceOriginalSize":[2048,1548],
        "exclusions":["Operating-system status bar, home indicator and display bezel","Document artwork excluded from control masks; measured separately by the editable example scenario"],
        "userActions":["Opened Agent Design through board menu","Hid and restored the drawing tray","Opened and closed board information"],
        "persistedSampleObjectKinds":kinds,"weights":WEIGHTS,"regions":geometry,"swatches":wells,"paper":{"sampleCss":PAPER,"reference":expectedPaper,"browser":paperMetrics,"matched":paperPass},
        "coordinateIoUMean":round(coords,4),"swatchRgbAgreementMean":round(color,4),
        "referencePixelsSupplied":bool(ref_path),"controlAppearanceMeasured":False,"pageErrors":errors}
    geometryPass=all(item['maxCoordinateDeltaCss']<=4 for item in geometry.values())
    mandatory=geometryPass and not errors and paperPass and all(v['maxRgbDelta']<=25 and 21<=v['diameterCssPx']<=31 for v in wells.values())
    ref=None
    cropped=None
    with np.load(ROOT/'qa/fixtures/reference-ui-masks.npz', allow_pickle=False) as templates:
        source_hash=str(templates['reference_sha256'])
        if ref_path:
            source=Image.open(ref_path).convert('RGB')
            if source.size != (2048,1548):raise ValueError(f'Expected 2048x1548 reference, got {source.size}')
            source_hash=hashlib.sha256(Path(ref_path).read_bytes()).hexdigest()
            cropped=source.crop(CROP)
            ref=np.array(cropped)
        parts=score_ink(ref,pixels,templates)
    foreground=float(np.mean([group['meanF1'] for group in parts.values()]))
    agreement=WEIGHTS['geometry']*coords+WEIGHTS['control_ink']*foreground+WEIGHTS['swatches']*color+WEIGHTS['paper']*float(paperPass)
    result.update({"referenceSha256":source_hash,"referenceKind":"user-provided image" if ref_path else "embedded binary UI-control silhouettes and numeric landmarks",
        "controlAppearanceMeasured":True,"regionForegroundMasks":parts,"meanSectionForegroundF1":round(foreground,4),
        "referenceAppearanceMethod":"Mean symmetric silhouette precision/recall F1 per control, then per functional section. Fixed 1.5 CSS px tolerance (3 physical px), absolute registration. White background outside ink masks never contributes true negatives.",
        "referencePaperMeasured":paper(ref) if ref is not None else expectedPaper,"uiAgreement":round(agreement,4),"minimumUiAgreement":.95,
        "majorSectionsMatched":all(group['meanF1']>=.85 for group in parts.values())})
    mandatory=mandatory and agreement>=.95 and result['majorSectionsMatched']
    if cropped is not None: montage(cropped,render,outdir/'reference-comparison.png')
    result["allRequiredChecksPassed"]=mandatory
    (outdir/'reference-ui.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps({k:result[k] for k in ["coordinateIoUMean","swatchRgbAgreementMean","controlAppearanceMeasured","allRequiredChecksPassed"]} |
        {k:result[k] for k in ['meanSectionForegroundF1','uiAgreement'] if k in result}))
    if strict and not mandatory:raise AssertionError("Reference checks failed: review reference-ui.json")


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',default='http://127.0.0.1:3000')
    p.add_argument('--reference-image',type=Path,default=os.environ.get('FOLIO_REFERENCE_IMAGE'))
    p.add_argument('--output-dir',type=Path,default=ROOT/'evidence')
    p.add_argument('--report-only',action='store_true')
    args=p.parse_args()
    verify(args.url,args.reference_image,args.output_dir,not args.report_only)
