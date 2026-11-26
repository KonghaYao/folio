"""Operate the visible Freeform-style toolbar and its native popovers as a user."""

from playwright.sync_api import expect


def visible_action(page, name):
    return page.locator(f'[data-action="{name}"]:visible').first


def click_action(page, name):
    item = visible_action(page, name)
    if not item.is_visible() and name in {"fit", "zoom-reset", "zoom-in", "zoom-out"}:
        visible_action(page, "zoom-menu").click()
    elif not item.is_visible() and name == "drawing-options":
        if not visible_action(page, "tray-more").is_visible():
            visible_action(page, "tray-toggle").click()
        visible_action(page, "tray-more").click()
    item.click()


def choose_tool(page, name):
    tool = page.locator(f'[data-tool="{name}"]:visible').first
    if not tool.is_visible():
        tray = visible_action(page, "tray-more")
        if not tray.is_visible():
            visible_action(page, "tray-toggle").click()
        if not tool.is_visible():
            tray.click()
    tool.click()


def number_input(locator, value):
    current = float(locator.input_value())
    lo = float(locator.get_attribute("min") or 0)
    hi = float(locator.get_attribute("max") or 100)
    step = float(locator.get_attribute("step") or 1)
    target = max(lo, min(hi, lo + round((value - lo) / step) * step))
    if abs(current - target) < step * 0.2:
        return target
    bounds = locator.bounding_box()
    relative = (target - lo) / (hi - lo)
    locator.click(position={"x": 8 + relative * (bounds["width"] - 16), "y": bounds["height"] / 2})
    for _ in range(12):
        current = float(locator.input_value())
        if abs(current - target) < step * 0.2:
            break
        locator.press("ArrowRight" if target > current else "ArrowLeft")
    return float(locator.input_value())


def set_ink_width(page, value):
    slider = page.locator("#ink-width")
    if not slider.is_visible():
        more = visible_action(page, "tray-more")
        more.click()
        expect(slider).to_be_visible()
        actual = number_input(slider, value)
        page.keyboard.press("Escape")
        expect(slider).to_be_hidden()
        return actual
    return number_input(slider, value)
