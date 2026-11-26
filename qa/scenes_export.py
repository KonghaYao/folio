"""Drive saved views, the PDF exporter and a portable copy through Chromium's UI."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageChops
from playwright.sync_api import expect, sync_playwright
from pypdf import PdfReader
from studio import click_action, choose_tool


def check(url, output):
    observed = []
    with TemporaryDirectory() as temporary, sync_playwright() as browser_api:
        folder = Path(temporary)
        browser = browser_api.chromium.launch(
            executable_path=os.getenv('CHROMIUM_PATH'), headless=True,
            args=['--disable-dev-shm-usage', '--disable-gpu'])
        page = browser.new_page(viewport={'width': 1100, 'height': 820}, accept_downloads=True)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url)
        expect(page.locator('#app')).to_have_attribute('data-ready', 'true')
        act = lambda name: page.locator('[data-action="' + name + '"]:visible')
        dialog = lambda: page.locator('dialog[open]').last
        close = lambda: dialog().get_by_role('button', name='关闭', exact=True).click()

        def menu(name):
            act('more').click()
            act(name).click()

        def export(action, target):
            with page.expect_download() as download:
                act(action).click()
            download.value.save_as(target)

        # The ink and red attachment provide independent visual oracles for the PDFs.
        choose_tool(page,'pen')
        page.mouse.move(320, 320)
        page.mouse.down()
        page.mouse.move(430, 480, steps=15)
        page.mouse.move(520, 350, steps=15)
        page.mouse.up()
        image = Image.new('RGB', (160, 90), (228, 42, 32))
        stream = io.BytesIO()
        image.save(stream, format='PNG')
        image_file = stream.getvalue()
        act('insert').click()
        with page.expect_file_chooser() as picker:
            act('attach').click()
        picker.value.set_files({'name': '试色.png', 'mimeType': 'image/png', 'buffer': image_file})
        expect(page.locator('#object-count')).to_have_text('2 个对象')
        act('scenes').click()
        act('scene-add').click()
        close()
        click_action(page,'zoom-in')
        expect(page.locator('#zoom-value')).to_have_text('125%')
        act('scenes').click()
        act('scene-add').click()
        rows = page.locator('.folio-scene-row')
        rows.nth(1).locator('summary').click()
        act('scene-rename').click()
        dialog().get_by_role('textbox').fill('细部')
        dialog().get_by_role('button', name='保存', exact=True).click()
        expect(rows.nth(1)).to_contain_text('细部')
        rows.nth(1).locator('summary').click()
        act('scene-up').click()
        expect(rows.first).to_contain_text('细部')
        act('present').click()
        expect(page.locator('.folio-projector-controls')).to_contain_text('1 / 2')
        page.keyboard.press('ArrowRight')
        expect(page.locator('.folio-projector-controls')).to_contain_text('2 / 2')
        page.keyboard.press('Escape')
        expect(dialog()).to_have_count(0)
        page.reload()
        expect(page.locator('#app')).to_have_attribute('data-ready', 'true')
        act('scenes').click()
        expect(rows.first).to_contain_text('细部')
        rows.nth(1).locator('[data-action=scene-jump]').click()
        expect(page.locator('#zoom-value')).to_have_text('100%')
        observed.extend(['capture and rename two views', 'reorder and restore saved scene after reload',
                         'keyboard-driven presentation', 'jump to saved camera'])

        menu('export')
        export('export-png', folder / 'original.png')
        export('export-pdf', folder / 'board.pdf')
        export('export-scenes-pdf', folder / 'scenes.pdf')
        export('export-archive', folder / 'copy.folio.json')
        close()
        pdf_sizes = {}
        for title, count in [('board', 1), ('scenes', 2)]:
            pdf = PdfReader(folder / (title + '.pdf'))
            assert len(pdf.pages) == count
            for pdf_page in pdf.pages:
                raster = list(pdf_page.images)
                assert len(raster) == 1
                pixels = raster[0].image.convert('RGB')
                thumb = pixels.resize((200, 140))
                red = sum(n for n, (r, g, b) in thumb.getcolors(thumb.width * thumb.height)
                          if r > 160 and g < 100 and b < 100)
                assert red > 20, (title, red)
            pdf_sizes[title] = (folder / (title + '.pdf')).stat().st_size
        archive = json.loads((folder / 'copy.folio.json').read_text())
        assert len(archive['resources']) == 1
        assert base64.b64decode(archive['resources'][0]['base64']) == image_file
        assert len([item for item in archive['items'].values() if item['typeName'] == 'scene']) == 2
        observed.extend(['PNG download', 'one-page board PDF', 'two-page PDF with decoded image on each page',
                         'archive embeds original attachment bytes'])

        old_url = page.url
        menu('import')
        act('import-file').set_input_files(folder / 'copy.folio.json')
        act('import-submit').click()
        expect(page.locator('#board-title')).to_contain_text('副本')
        assert page.url != old_url
        expect(page.locator('#object-count')).to_have_text('2 个对象')
        menu('export')
        export('export-png', folder / 'restored.png')
        export('export-archive', folder / 'restored.json')
        restored = json.loads((folder / 'restored.json').read_text())
        assert restored['resources'][0]['path'] != archive['resources'][0]['path']
        assert base64.b64decode(restored['resources'][0]['base64']) == image_file
        first = Image.open(folder / 'original.png').convert('RGB')
        second = Image.open(folder / 'restored.png').convert('RGB')
        assert first.size == second.size and ImageChops.difference(first, second).getbbox() is None
        observed.extend(['archive import creates independently owned board', 'attachment copied into new board',
                         'original and restored PNG pixels identical'])
        close()
        # Removing the last of two scenes plus undo exercises scene metadata history.
        act('scenes').click()
        rows.first.locator('summary').click()
        act('scene-remove').click()
        expect(rows).to_have_count(1)
        close()
        click_action(page,'undo')
        act('scenes').click()
        expect(rows).to_have_count(2)
        observed.append('delete and undo a scene')
        close()
        act('insert').click()
        act('table').click()
        dialog().get_by_role('textbox', name='第1行第1列').fill('鸥鸟 鸥鸟')
        dialog().get_by_role('textbox', name='第2行第1列').fill('鸥鸟')
        dialog().get_by_role('button', name='保存表格').click()
        page.keyboard.press('Control+f')
        act('find-query').fill('鸥鸟')
        expect(page.locator('.folio-find output')).to_have_text('1 / 3')
        act('find-next').click()
        expect(page.locator('.folio-find output')).to_have_text('2 / 3')
        act('find-value').fill('鹈鹕')
        act('find-replace').click()
        expect(page.locator('.folio-find output')).to_contain_text('已替换 1 处')
        act('find-replace-all').click()
        expect(page.locator('.folio-find output')).to_contain_text('已替换 2 处')
        act('find-query').fill('鹈鹕')
        expect(page.locator('.folio-find output')).to_have_text('1 / 3')
        act('find-close').click()
        click_action(page,'undo')
        menu('find')
        act('find-query').fill('鹈鹕')
        expect(page.locator('.folio-find output')).to_have_text('1 / 1')
        observed.extend(['open canvas find with shortcut and menu', 'navigate matches in table cells',
                         'replace one, replace all, undo batch'])
        act('find-close').click()
        page.context.set_offline(True)
        menu('export')
        export('export-archive', folder / 'offline.json')
        offline = json.loads((folder / 'offline.json').read_text())
        assert base64.b64decode(offline['resources'][0]['base64']) == image_file
        page.context.set_offline(False)
        observed.append('offline archive export includes cached original attachment')
        assert not errors, errors
        evidence = {'passed': True, 'checks': observed, 'pageErrors': errors,
                    'exportedPdfBytes': pdf_sizes, 'pngDimensions': list(first.size),
                    'restoredPngPixelDifference': 0}
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(evidence, ensure_ascii=False))
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:3000')
    parser.add_argument('--out', type=Path, default=Path(__file__).resolve().parents[1] / 'evidence/scenes-export.json')
    args = parser.parse_args()
    check(args.url, args.out)
