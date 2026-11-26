"""Exercise personal library controls through the browser, using a fresh browser context."""
import argparse
import json
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright


def verify(base_url: str, output: Path) -> None:
    checked = []
    with sync_playwright() as runner:
        browser = runner.chromium.launch(
            executable_path=os.getenv("CHROMIUM_PATH"),
            headless=True,
            args=["--disable-dev-shm-usage"],
        )
        page = browser.new_page(viewport={"width": 1120, "height": 800})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base_url)
        title = page.locator("#board-title")
        expect(title).not_to_have_text("")
        expect(title).not_to_have_text("正在打开画板")
        current = title.inner_text().strip()
        page.get_by_role("button", name="画板库", exact=True).click()
        library = page.get_by_role("dialog", name="画板库")
        expect(library.get_by_role("button", name=current, exact=True)).to_be_visible()
        search = library.get_by_role("searchbox")
        search.fill("没有这张画板 83")
        expect(library.get_by_text("没有匹配的画板。")).to_be_visible()
        search.fill(current)
        expect(library.get_by_role("button", name=current, exact=True)).to_be_visible()
        search.fill("")
        checked.append("search board title")
        library.get_by_role("button", name="收藏 " + current).click()
        expect(library.get_by_role("button", name="取消收藏 " + current)).to_be_visible()
        library.get_by_role("button", name="收藏", exact=True).click()
        expect(library.get_by_role("button", name=current, exact=True)).to_be_visible()
        checked.append("favorite and browse favorites")
        library.get_by_role("button", name="新建文件夹").click()
        library.get_by_role("textbox", name="文件夹名称").fill("海鸟写生")
        library.get_by_role("button", name="保存", exact=True).click()
        expect(library.get_by_role("heading", name="海鸟写生")).to_be_visible()
        library.get_by_role("button", name="重命名").click()
        library.get_by_role("textbox", name="文件夹名称").fill("鹈鹕研究")
        library.get_by_role("button", name="保存", exact=True).click()
        expect(library.get_by_role("heading", name="鹈鹕研究")).to_be_visible()
        library.get_by_role("button", name="全部画板", exact=True).click()
        picker = library.get_by_role("combobox", name="管理 " + current)
        picker.select_option(label="移至 鹈鹕研究")
        expect(picker.locator('option[value="root"]')).to_have_count(1)
        library.get_by_role("button", name="鹈鹕研究", exact=True).click()
        expect(library.get_by_role("button", name=current, exact=True)).to_be_visible()
        checked.append("create and rename a folder, move a board into it")
        library.get_by_role("button", name="移入废纸篓", exact=True).click()
        expect(library.get_by_role("heading", name="废纸篓")).to_be_visible()
        expect(library.get_by_text(current, exact=True)).to_be_visible()
        library.get_by_role("button", name="恢复文件夹").click()
        expect(library.get_by_role("button", name="恢复文件夹")).to_have_count(0)
        library.get_by_role("button", name="鹈鹕研究", exact=True).click()
        expect(library.get_by_role("button", name=current, exact=True)).to_be_visible()
        checked.append("recover a folder with its board")
        picker.select_option(label="移入我的废纸篓")
        expect(library.get_by_role("button", name=current, exact=True)).to_have_count(0)
        library.get_by_role("button", name="废纸篓", exact=True).click()
        library.get_by_role("button", name="恢复", exact=True).click()
        expect(library.get_by_role("button", name="恢复", exact=True)).to_have_count(0)
        library.get_by_role("button", name="鹈鹕研究", exact=True).click()
        expect(library.get_by_role("button", name=current, exact=True)).to_be_visible()
        checked.append("recover an individual board")
        page.set_viewport_size({"width": 390, "height": 780})
        expect(library.get_by_role("searchbox")).to_be_visible()
        assert library.evaluate("(d) => d.getBoundingClientRect().right <= innerWidth")
        checked.append("mobile dialog fits a 390px viewport")
        library.get_by_role("button", name="关闭画板库").click()
        expect(library).to_have_count(0)
        assert not errors, errors
        version = browser.version
        browser.close()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"engine": "Chromium","version":version,"checks":checked,"pageErrors":errors},
                                indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "evidence/browser-library.json")
    args = parser.parse_args()
    verify(args.url, args.output)
