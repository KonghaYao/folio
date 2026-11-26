"""Revoke two independent grants while an invited editor has the board open."""
import argparse
import json

from playwright.sync_api import expect, sync_playwright

from draw import OUTPUT, chromium


def new_link(owner, role):
    owner.get_by_role("button", name="共享画板", exact=True).click()
    share = owner.get_by_role("dialog", name="共享画板")
    share.get_by_label("访问权限").select_option(role)
    share.get_by_role("button", name="生成邀请链接").click()
    link = share.get_by_label("邀请链接", exact=True)
    expect(link).to_be_visible()
    address = link.input_value()
    share.get_by_role("button", name="关闭", exact=True).click()
    return address


def revoke(owner, role_label):
    owner.get_by_role("button", name="共享画板", exact=True).click()
    share = owner.get_by_role("dialog", name="共享画板")
    share.locator('summary').click()
    row = share.locator('.invitation-row').filter(has=owner.get_by_text(role_label, exact=True))
    expect(row.locator('small')).to_contain_text('已加入 1 人')
    row.get_by_role("button", name="撤销邀请").click()
    row.get_by_role("button", name="确认撤销").click()
    expect(row).to_have_count(0)
    share.get_by_role("button", name="关闭", exact=True).click()


def run(url):
    with sync_playwright() as playwright:
        browser = chromium(playwright)
        owner = browser.new_context().new_page()
        owner.goto(url)
        expect(owner.locator("#app")).to_have_attribute("data-ready", "true")
        viewer_link, editor_link = new_link(owner, 'viewer'), new_link(owner, 'editor')
        guest = browser.new_context().new_page()
        guest.goto(viewer_link)
        expect(guest.locator("#access-state")).to_have_text("仅查看")
        guest.goto(editor_link)
        # Hash-only navigation can occur when a link points to an already open
        # studio tab. Navigating to the complete invite URL must consume it.
        expect(guest.locator("#access-state")).to_have_text("可编辑")
        expect(guest.locator('[data-tool=pen]')).to_be_enabled()
        revoke(owner, '可编辑')
        expect(guest.locator("#access-state")).to_have_text("仅查看",timeout=10000)
        expect(guest.locator('[data-tool=pen]')).to_be_disabled()
        revoke(owner, '仅查看')
        blocked = guest.get_by_role('dialog',name='无法继续访问画板')
        expect(blocked).to_be_visible(timeout=10000)
        expect(guest.locator('#board-surface canvas')).to_have_count(0)
        blocked.get_by_role('button',name='返回我的画板').click()
        expect(guest.locator("#app")).to_have_attribute("data-ready", "true")
        assert guest.url != owner.url
        report = {"revokeEditorGrant":"downgraded live to viewer", "revokeFinalViewerGrant":"removed live canvas and tools",
                  "otherDataSafe":"guest opened their own board after losing shared access", "browser":browser.version}
        OUTPUT.mkdir(exist_ok=True)
        (OUTPUT/'revocation.json').write_text(json.dumps(report,indent=2))
        print(json.dumps(report))
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    run(parser.parse_args().url)
