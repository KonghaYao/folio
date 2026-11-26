import type { GeoId } from '@quickdrawjs/core';
import type { CanvasTool } from './canvas';
import { icon, type IconName } from './icons';
import { penTrayMarkup } from './pen-tray';

export const toolLabels: Record<CanvasTool, string> = {
  select: '选择',
  hand: '平移',
  pen: '钢笔',
  pencil: '铅笔',
  marker: '荧光笔',
  eraser: '橡皮擦',
  shape: '形状',
  text: '文本',
  note: '便签',
  line: '直线',
  arrow: '连接箭头',
  laser: '激光笔',
};

export const shapes: Array<[GeoId, string, IconName]> = [
  ['rectangle', '矩形', 'rectangle'],
  ['ellipse', '椭圆', 'ellipse'],
  ['triangle', '三角形', 'triangle'],
  ['diamond', '菱形', 'diamond'],
  ['hexagon', '六边形', 'hexagon'],
  ['star', '星形', 'star'],
  ['cloud', '云朵', 'cloud'],
];

export function cmd(action: string, label: string, glyph: IconName, extra = ''): string {
  return `<button type="button" class="icon-button ${extra}" aria-label="${label}" title="${label}" data-action="${action}">${icon(glyph)}</button>`;
}

function tool(id: CanvasTool, glyph: IconName, key: string): string {
  const label = toolLabels[id];
  return `<button type="button" data-tool="${id}" title="${label} (${key})" aria-label="${label}" aria-pressed="false" class="tool-button"><span>${icon(glyph, 21)}</span></button>`;
}

export function menuItem(action: string, name: string, glyph: IconName, shortcut = ''): string {
  return `<button type="button" class="menu-item" data-action="${action}">${icon(glyph, 17)}<span>${name}</span><small>${shortcut}</small></button>`;
}

export function shell(): string {
  return `<main class="workspace" aria-label="无限画布工作区">
    <div id="board-surface" data-testid="board-surface" aria-label="无限画布" tabindex="0"></div>
    <header class="studio-header">
      <div class="title-cluster">
        <button type="button" data-shell="back" class="glass circle-button" data-action="library" aria-label="画板库" title="返回画板库">${icon('back', 20)}</button>
        <button type="button" data-shell="title" class="board-title" data-action="board-menu" aria-haspopup="true"><span id="board-title">正在打开画板</span><span class="title-chevron">${icon('chevron', 11)}</span></button>
        <span id="save-state" class="save-state" role="status">${icon('cloud', 13)}<span>连接中</span></span>
      </div>
      <nav class="glass creation-tools" data-shell="creation" aria-label="创作工具">
        <button type="button" class="icon-button" data-action="tray-toggle" title="绘图工具" aria-label="绘图工具" aria-expanded="true">${icon('markup', 22)}</button>
        ${tool('text', 'textBox', 'T')}${tool('shape', 'freeShape', 'G')}${tool('note', 'freeNote', 'N')}
        ${cmd('insert-table', '插入表格', 'freeTable')}${cmd('insert', '插入内容', 'paperclip')}
      </nav>
      <nav class="header-actions" aria-label="画板命令">
        <button type="button" class="glass circle-button overview-button" data-shell="overview" data-action="board-info" title="画板信息" aria-label="画板信息">${icon('boardInfo', 21)}</button>
        <div class="glass command-group" data-shell="actions">${cmd('undo', '撤销 (⌘/Ctrl Z)', 'undo')}${cmd('share', '共享画板', 'shareBox')}${cmd('more', '更多操作', 'more')}</div>
        <button type="button" data-shell="compose" class="glass circle-button compose-button" data-action="new" title="新建画板" aria-label="新建画板">${icon('compose', 21)}</button>
      </nav>
    </header>
    ${penTrayMarkup()}
    <section class="selection-strip glass" aria-label="选区操作" hidden><span id="selection-count"></span><i></i>${cmd('inspect', '对象属性', 'inspect')}${cmd('duplicate', '复制对象', 'duplicate')}${cmd('delete-selection', '删除对象', 'trash')}${cmd('selection-menu', '更多选区操作', 'more')}</section>
    <div class="workspace-bottom">
      <nav class="glass scene-controls" data-shell="scene-controls" aria-label="缩放与场景">
        <button type="button" class="zoom-value" data-action="zoom-menu" title="缩放" aria-label="缩放菜单" aria-haspopup="true" id="zoom-value">100%</button>
        <span class="footer-rule"></span>${cmd('previous-scene', '上一个场景', 'back')}${cmd('scenes', '场景', 'sceneList')}${cmd('next-scene', '下一个场景', 'forward')}<span class="footer-rule"></span>${cmd('save-scene', '保存当前场景', 'sceneSave')}
      </nav>
      <div class="document-state"><span id="access-state" class="visually-hidden">可编辑</span><span class="visually-hidden" id="object-count">0 个对象</span></div>
      <button type="button" class="glass circle-button chat-toggle" data-testid="chat-open" data-action="open-chat" aria-expanded="false" aria-controls="chat-panel" aria-label="画板 Chat" title="画板 Chat (⌘/Ctrl Alt C)">${icon('chat', 20)}</button>
      <nav class="glass view-controls" data-shell="view-controls" aria-label="连线与网格">${cmd('connectors', '连接工具', 'connector')}${cmd('grid', '网格设置', 'gridBox')}</nav>
    </div>
    <div id="popover" class="folio-popover" hidden></div>
  </main>
  <input type="file" multiple id="file-picker" hidden>
  <div role="status" aria-live="polite" id="toast" hidden></div>`;
}
