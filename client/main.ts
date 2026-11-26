import type { FillId, GeoId, GridId } from '@quickdrawjs/core';
import { createBoardCanvas, type CanvasTool } from './canvas';
import { menuItem, shapes, shell } from './chrome';
import { mountBoardChat } from './chat';
import { syncPenTray } from './pen-tray';
import { createScene, goToScene, scenesOf } from './extras/scenes';
import { rememberViewport } from './viewport';
import {
  createAgentDesignSample,
  frameAgentDesign,
  isAgentDesignSample,
  registerSampleRenderers,
} from './sample-board';
import { modal, textPrompt } from './dialogs';
import { consumeDeviceLink, showDevices } from './devices';
import { createBoardExtras } from './extras';
import { icon } from './icons';
import { openBoardLibrary } from './library';
import {
  BoardSync,
  bootstrapSession,
  createBoard,
  getBoard,
  joinBoard,
  listBoards,
  renameBoard,
  uploadAsset,
  type Board,
} from './net';
import { mountObjectTools } from './objects';
import { openSharing } from './sharing';
import { bindPresence } from './presence';
import { formatSelection } from './format';
import './style.css';

type Canvas = ReturnType<typeof createBoardCanvas>;
interface Session {
  board: Board;
  canvas: Canvas;
  sync: BoardSync;
  chat: ReturnType<typeof mountBoardChat>;
  extras: ReturnType<typeof createBoardExtras>;
  objects: ReturnType<typeof mountObjectTools>;
  detachHeader: () => void;
  detachPresence: () => void;
  detachViewport: () => void;
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = shell();
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const surface = element('board-surface');
const popover = element('popover');
const picker = element<HTMLInputElement>('file-picker');
let session: Session | undefined;
let switching = false;
let panel: string | undefined;
let selectedColor = '#000000';
const widths: Partial<Record<CanvasTool, number>> = {
  pen: 4,
  pencil: 3,
  marker: 18,
  shape: 3,
  line: 3,
  arrow: 3,
};
let activeTool: CanvasTool = 'select';
let toastTimer: ReturnType<typeof setTimeout>;
let lastPanelTrigger: HTMLElement | undefined;
let sceneIndex = -1;

function toast(message: string) {
  const node = element('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5400);
}

function errorMessage(error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  const translations: Record<string, string> = {
    invalid_token: '此邀请链接已失效。',
    board_not_found: '画板不存在或你尚未获得访问权限。',
    request_too_large: '文件或单次操作超过大小限制。',
    permission_denied: '当前身份没有此操作权限。',
    not_found: '画板不存在或你尚未获得访问权限。',
    forbidden: '当前身份没有此操作权限。',
  };
  return translations[reason] ?? `操作未完成（${reason}）`;
}

function closePanel(returnFocus = false) {
  panel = undefined;
  popover.hidden = true;
  popover.replaceChildren();
  if (returnFocus && lastPanelTrigger?.isConnected) lastPanelTrigger.focus();
}

function showPanel(name: string, anchor: HTMLElement, content: string) {
  if (name === panel) {
    closePanel();
    return;
  }
  panel = name;
  lastPanelTrigger = anchor;
  popover.innerHTML = content;
  popover.hidden = false;
  const rect = anchor.getBoundingClientRect(),
    box = popover.getBoundingClientRect();
  const rail = !!anchor.closest('.tool-rail');
  const bounds = surface.getBoundingClientRect();
  const maxX = Math.max(8, bounds.right - box.width - 8);
  const maxY = Math.max(8, bounds.bottom - box.height - 8);
  const x = rail
    ? rect.right + 12
    : rect.left > bounds.left + bounds.width / 2
      ? rect.right - box.width
      : rect.left;
  const y = rail
    ? rect.top - 6
    : rect.bottom + 8 + box.height <= bounds.bottom
      ? rect.bottom + 8
      : rect.top - box.height - 8;
  popover.style.left = `${Math.max(8, Math.min(maxX, x))}px`;
  popover.style.top = `${Math.max(8, Math.min(maxY, y))}px`;
}

function updateTitle(title: string) {
  element('board-title').textContent = title;
  document.title = title + ' · Folio';
}

function updateStatus(state: 'saved' | 'saving' | 'offline' | 'conflict') {
  const node = element('save-state');
  if (node.dataset.state === state) return;
  node.dataset.state = state;
  node.querySelector('span')!.textContent = {
    saved: '已同步',
    saving: '正在保存',
    offline: '连接中断',
    conflict: '编辑冲突',
  }[state];
}

function updateSelection(canvas: Canvas) {
  const hasSelection = canvas.editor.selection.size > 0;
  const strip = document.querySelector<HTMLElement>('.selection-strip')!;
  strip.hidden = !hasSelection || activeTool !== 'select' || canvas.editor.readonly;
  element('selection-count').textContent = `已选 ${canvas.editor.selection.size} 项`;
}

function refreshTools(canvas: Canvas) {
  activeTool = canvas.getTool();
  for (const button of app.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === activeTool));
    button.disabled = canvas.editor.readonly && button.dataset.tool !== 'hand';
  }
  syncPenTray(activeTool, selectedColor, canvas.editor.readonly);
  app
    .querySelector('[data-action=tray-lasso]')
    ?.setAttribute('aria-pressed', String(canvas.editor.assist === 'lasso'));
  app
    .querySelector('[data-action=tray-ruler]')
    ?.setAttribute('aria-pressed', String(canvas.editor.rulerAngle !== null));
  const width = widths[activeTool] ?? 4;
  element<HTMLInputElement>('ink-width').value = String(width);
  element('ink-width-value').textContent = width + ' px';
  for (const button of app.querySelectorAll<HTMLButtonElement>('[data-color]'))
    button.setAttribute('aria-pressed', String(button.dataset.color === selectedColor));
  updateSelection(canvas);
}

function setTool(tool: CanvasTool) {
  if (!session || (session.canvas.editor.readonly && tool !== 'hand')) return;
  session.canvas.setTool(tool);
  if (widths[tool] !== undefined) session.canvas.setWidth(widths[tool]!);
  refreshTools(session.canvas);
}

function setColor(value: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value) || !session || session.canvas.editor.readonly) return;
  selectedColor = value.toLowerCase();
  element<HTMLInputElement>('ink-color').value = selectedColor;
  session.canvas.setColor(selectedColor);
  refreshTools(session.canvas);
}

function syncHeader(ctx: Session) {
  const { canvas, board } = ctx;
  const undo = app.querySelectorAll<HTMLButtonElement>('[data-action="undo"]');
  const redo = app.querySelectorAll<HTMLButtonElement>('[data-action="redo"]');
  const history = () => {
    for (const buttons of [undo, redo]) {
      const disabled =
        canvas.editor.readonly || !(buttons === undo ? canvas.store.canUndo : canvas.store.canRedo);
      for (const button of buttons) if (button.disabled !== disabled) button.disabled = disabled;
    }
  };
  let objectCount = -1;
  const count = () => {
    if (objectCount === canvas.store.shapeCount) return;
    objectCount = canvas.store.shapeCount;
    element('object-count').textContent = objectCount + ' 个对象';
  };
  const observeCount = canvas.store.listen(count);
  const zoom = () => {
    element('zoom-value').textContent = Math.round(canvas.editor.camera.z * 100) + '%';
  };
  const listeners = [
    canvas.editor.on('tool', () => refreshTools(canvas)),
    canvas.editor.on('selection', () => updateSelection(canvas)),
    canvas.editor.on('camera', zoom),
    canvas.editor.on('history', history),
    observeCount,
    canvas.editor.on('help', shortcuts),
    canvas.store.listen((diff) => {
      if (
        [...Object.values(diff.added), ...Object.values(diff.removed)].some(
          (item) => (item.typeName as string) === 'scene',
        )
      )
        updateSceneControls(canvas);
    }),
  ];
  ctx.detachHeader = () => listeners.forEach((dispose) => dispose());
  history();
  count();
  zoom();
  refreshTools(canvas);
  updateSceneControls(canvas);
  for (const button of app.querySelectorAll<HTMLButtonElement>(
    '[data-action=insert-table],[data-action=connectors],[data-action=save-scene]',
  ))
    button.disabled = canvas.editor.readonly;
  app.querySelector<HTMLButtonElement>('[data-action=share]')!.disabled = board.role !== 'owner';
  app.querySelector<HTMLButtonElement>('[data-action=insert]')!.disabled = canvas.editor.readonly;
  element('access-state').textContent = board.role === 'viewer' ? '仅查看' : '可编辑';
}

function disposeBoard(ctx: Session) {
  ctx.chat.destroy();
  ctx.detachHeader();
  ctx.detachPresence();
  ctx.detachViewport();
  ctx.extras.destroy();
  ctx.objects.destroy();
  ctx.sync.close();
  ctx.canvas.destroy();
}

async function mount(board: Board) {
  if (session) {
    session.chat.cancel();
    await session.sync.flush();
    if (session) disposeBoard(session);
  }
  closePanel();
  sceneIndex = -1;
  const canvas = createBoardCanvas(surface, {
    readonly: board.role === 'viewer',
    boardId: board.id,
  });
  canvas.setTool(board.role === 'viewer' ? 'hand' : 'pen');
  canvas.setWidth(widths.pen!);
  canvas.setColor(selectedColor);
  const sync = new BoardSync(board, canvas.store, {
    onStatus: updateStatus,
    onTitle: (title) => {
      board.title = title;
      updateTitle(title);
    },
    onError: toast,
    onRole(role) {
      if (session?.board.id !== board.id) return;
      board.role = role;
      session.chat.cancel();
      canvas.setReadOnly(role === 'viewer');
      for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]'))
        dialog.close();
      closePanel();
      session.detachHeader();
      syncHeader(session);
      toast(role === 'viewer' ? '你的权限已变更为仅查看。' : '你现在可以编辑此画板。');
    },
    onRevoked() {
      if (session?.board.id !== board.id) return;
      canvas.setReadOnly(true);
      for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]'))
        dialog.close();
      closePanel();
      disposeBoard(session);
      session = undefined;
      app.removeAttribute('data-ready');
      updateTitle('画板访问权限已收回');
      const body = document.createElement('div'),
        button = document.createElement('button');
      body.className = 'dialog-form';
      body.textContent = '此画板已删除，或你的访问权限已被收回。';
      button.className = 'primary-action';
      button.textContent = '返回我的画板';
      body.append(button);
      const view = modal('无法继续访问画板', body);
      button.onclick = () => view.close();
      view.addEventListener('close', () => location.assign(location.pathname), { once: true });
    },
  });
  const extras = createBoardExtras({
    boardId: board.id,
    editor: canvas.editor,
    title: () => board.title,
    flush: () => sync.flush(),
    openBoard,
  });
  registerSampleRenderers(canvas);
  const objects = mountObjectTools(canvas);
  const detachPresence = bindPresence(board.id, canvas, board.role);
  const detachViewport = rememberViewport(board.id, canvas.editor, () => {
    if (isAgentDesignSample(board)) frameAgentDesign(canvas);
    else if (canvas.store.shapeCount) canvas.editor.fitContent({ margin: 0.1, maxZoom: 1 });
  });
  session = {
    board,
    canvas,
    sync,
    extras,
    objects,
    detachPresence,
    detachViewport,
    chat: mountBoardChat(board, canvas, () => sync.flush()),
    detachHeader: () => {},
  };
  updateTitle(board.title);
  updateStatus(navigator.onLine ? 'saved' : 'offline');
  syncHeader(session);
  const url = new URL(location.href);
  url.searchParams.delete('sample');
  url.searchParams.set('board', board.id);
  url.hash = '';
  history.replaceState(null, '', url);
  canvas.editor.render();
  app.dataset.ready = 'true';
}

async function openBoard(id: string) {
  if (switching || session?.board.id === id) return;
  switching = true;
  try {
    await mount(await getBoard(id));
  } finally {
    switching = false;
  }
}

async function newBoard() {
  if (switching) return;
  const title = await textPrompt({
    title: '新建画板',
    inputLabel: '画板名称',
    value: '未命名画板',
    button: '创建画板',
    maxLength: 160,
  });
  if (!title) return;
  switching = true;
  try {
    await mount(await createBoard(title));
  } finally {
    switching = false;
  }
}

function shortcuts() {
  const body = document.createElement('div');
  body.className = 'shortcut-list';
  const shortcuts = [
    ['选择 / 平移', 'V / H'],
    ['钢笔 / 铅笔 / 荧光笔', 'P / B / I'],
    ['橡皮擦', 'E'],
    ['形状 / 连接箭头', 'G / A'],
    ['文本 / 便签', 'T / N'],
    ['临时平移', '按住空格拖动'],
    ['多选', 'Shift + 点击'],
    ['撤销 / 重做', 'Ctrl/⌘ Z · Ctrl/⌘ ⇧ Z'],
    ['缩放到内容', 'Shift + 1'],
    ['删除选区', 'Delete'],
  ];
  for (const [action, key] of shortcuts) {
    const row = document.createElement('div'),
      label = document.createElement('span'),
      hint = document.createElement('kbd');
    label.textContent = action;
    hint.textContent = key;
    row.append(label, hint);
    body.append(row);
  }
  modal('键盘快捷键', body);
}

function boardMenu(trigger: HTMLElement) {
  showPanel(
    'board-menu',
    trigger,
    menuItem('library', '画板库', 'library') +
      menuItem('new', '新建画板', 'plus') +
      menuItem('sample', '打开示例画板', 'scenes') +
      menuItem('devices', '同步我的设备', 'devices') +
      (session?.board.role !== 'viewer' ? menuItem('rename', '重命名', 'pen') : '') +
      menuItem('import', '导入画板', 'import'),
  );
}

function shapeMenu(trigger: HTMLElement) {
  const canvas = session!.canvas;
  setTool('shape');
  const list = shapes
    .map(
      ([kind, name, glyph]) =>
        `<button data-kind="${kind}" aria-label="${name}" title="${name}" aria-pressed="${canvas.editor.geoKind === kind}">${icon(glyph, 19)}</button>`,
    )
    .join('');
  const fills: Array<[FillId, string]> = [
    ['none', '无'],
    ['semi', '淡色'],
    ['solid', '实心'],
    ['pattern', '斜线'],
  ];
  showPanel(
    'shape',
    trigger,
    `<div class="menu-label">形状</div><div class="shape-options">${list}</div><div class="menu-label">填充</div><div class="fill-options">${fills.map(([fill, label]) => `<button data-fill="${fill}" aria-pressed="${canvas.editor.styles.fill === fill}">${label}</button>`).join('')}</div>` +
      menuItem('line', '直线', 'line', 'L') +
      menuItem('arrow', '连接箭头', 'arrow', 'A'),
  );
}

async function addFiles(files: Iterable<File>, at?: { x: number; y: number }) {
  const ctx = session;
  if (!ctx || ctx.board.role === 'viewer') return;
  for (const file of files) {
    if (ctx !== session) return;
    const asset = await uploadAsset(ctx.board.id, file);
    if (ctx !== session) return;
    await ctx.canvas.addAttachment({ name: asset.name, url: asset.url, mime: asset.type }, at);
    if (at) at = { x: at.x + 24, y: at.y + 24 };
  }
  setTool('select');
}

function updateSceneControls(canvas: Canvas) {
  const count = canvas.store.size === canvas.store.shapeCount ? 0 : scenesOf(canvas.store).length;
  sceneIndex = Math.min(sceneIndex, count - 1);
  app.querySelector<HTMLButtonElement>('[data-action=previous-scene]')!.disabled =
    !count || sceneIndex < 1;
  app.querySelector<HTMLButtonElement>('[data-action=next-scene]')!.disabled =
    !count || sceneIndex + 1 >= count;
}

function boardInfo(board: Board) {
  const body = document.createElement('div');
  body.className = 'board-info-table';
  const entries = [
    ['名称', board.title],
    ['访问权限', element('access-state').textContent],
    ['内容', element('object-count').textContent],
    ['同步状态', element('save-state').textContent],
  ];
  for (const [name, value] of entries) {
    const row = document.createElement('div'),
      label = document.createElement('span'),
      detail = document.createElement('strong');
    label.textContent = name;
    detail.textContent = value;
    row.append(label, detail);
    body.append(row);
  }
  modal('画板信息', body);
}

async function command(action: string, trigger: HTMLElement) {
  const ctx = session;
  if (!ctx) return;
  const { canvas, board, extras, objects } = ctx;
  if (
    !['board-menu', 'more', 'insert', 'grid', 'selection-menu', 'zoom-menu', 'connectors'].includes(
      action,
    )
  )
    closePanel();
  switch (action) {
    case 'board-menu':
      boardMenu(trigger);
      break;
    case 'tray-toggle': {
      const tray = element('pen-tray');
      tray.hidden = !tray.hidden;
      trigger.setAttribute('aria-expanded', String(!tray.hidden));
      if (
        !tray.hidden &&
        !canvas.editor.readonly &&
        !['pen', 'pencil', 'marker', 'eraser', 'select'].includes(activeTool)
      )
        setTool('pen');
      break;
    }
    case 'tray-ruler':
      if (canvas.editor.readonly) break;
      canvas.editor.rulerAngle = canvas.editor.rulerAngle === null ? 0 : null;
      if (canvas.editor.rulerAngle !== null && !['pen', 'pencil', 'marker'].includes(activeTool))
        setTool('pen');
      canvas.editor.requestRender();
      refreshTools(canvas);
      break;
    case 'tray-lasso':
      if (!canvas.editor.readonly) {
        canvas.editor.setAssist('lasso');
        refreshTools(canvas);
      }
      break;
    case 'board-info':
      boardInfo(board);
      break;
    case 'zoom-menu':
      showPanel(
        'zoom-menu',
        trigger,
        menuItem('zoom-in', '放大', 'plus') +
          menuItem('zoom-out', '缩小', 'minus') +
          menuItem('zoom-reset', '重置为 100%', 'rectangle') +
          menuItem('fit', '适应内容', 'fit'),
      );
      break;
    case 'connectors':
      showPanel(
        'connectors',
        trigger,
        menuItem('arrow', '连接箭头', 'arrow', 'A') +
          menuItem('line', '直线', 'line', 'L') +
          menuItem('diagram', '流程图', 'diagram'),
      );
      break;
    case 'previous-scene':
    case 'next-scene': {
      const list = scenesOf(canvas.store);
      sceneIndex = Math.min(
        list.length - 1,
        Math.max(0, sceneIndex + (action === 'next-scene' ? 1 : -1)),
      );
      if (list[sceneIndex]) goToScene(canvas.editor, list[sceneIndex]);
      updateSceneControls(canvas);
      break;
    }
    case 'save-scene': {
      if (canvas.editor.readonly) break;
      const title = await textPrompt({
        title: '保存当前场景',
        inputLabel: '场景名称',
        value: '场景 ' + (scenesOf(canvas.store).length + 1),
        button: '保存',
        maxLength: 120,
      });
      if (title && session === ctx) {
        const record = createScene(canvas.editor, title);
        sceneIndex = scenesOf(canvas.store).findIndex((item) => item.id === record.id);
        updateSceneControls(canvas);
      }
      break;
    }
    case 'library':
      await openBoardLibrary({ currentBoardId: board.id, onOpen: openBoard, onCreate: newBoard });
      break;
    case 'sample':
      if (switching) break;
      switching = true;
      try {
        await mount(await createAgentDesignSample());
      } finally {
        switching = false;
      }
      break;
    case 'new':
      await newBoard();
      break;
    case 'devices':
      await ctx.sync.flush();
      await showDevices();
      break;
    case 'rename': {
      const title = await textPrompt({
        title: '重命名画板',
        inputLabel: '画板名称',
        value: board.title,
        button: '保存',
        maxLength: 160,
      });
      if (title) {
        const updated = await renameBoard(board.id, title);
        board.title = updated.title;
        updateTitle(updated.title);
      }
      break;
    }
    case 'open-chat':
      ctx.chat.toggle();
      break;
    case 'more':
      showPanel(
        'more',
        trigger,
        menuItem('board-info', '画板信息', 'boardInfo') +
          menuItem('open-chat', '画板 Chat', 'chat', '⌘/Ctrl Alt C') +
          menuItem('find', '查找与替换', 'find', '⌘/Ctrl F') +
          menuItem('drawing-options', '绘图辅助', 'inspect') +
          menuItem('scenes', '场景与演示', 'scenes') +
          menuItem('export', '导出画板', 'export') +
          menuItem('import', '导入画板', 'import') +
          '<hr>' +
          menuItem('help', '键盘快捷键', 'help', '?'),
      );
      break;
    case 'insert':
      showPanel(
        'insert',
        trigger,
        menuItem('attach', '图片、媒体或文件', 'attach') +
          menuItem('link', '网页链接', 'link') +
          menuItem('table', '表格', 'table') +
          menuItem('diagram', '流程图', 'diagram') +
          '<hr>' +
          menuItem('arrow', '连接箭头', 'arrow', 'A') +
          menuItem('line', '直线', 'line', 'L') +
          menuItem('laser', '激光笔', 'laser', 'K') +
          menuItem('drawing-options', '绘图辅助', 'inspect'),
      );
      break;
    case 'attach':
      picker.click();
      break;
    case 'link': {
      const value = await textPrompt({
        title: '插入网页链接',
        inputLabel: '网址',
        type: 'url',
        placeholder: 'https://',
        button: '插入',
        maxLength: 2048,
      });
      if (value && session === ctx) {
        canvas.addLink(value);
        setTool('select');
      }
      break;
    }
    case 'insert-table':
    case 'table':
      objects.table();
      break;
    case 'diagram':
      objects.diagram();
      break;
    case 'inspect':
      objects.inspect();
      break;
    case 'selection-menu':
      showPanel(
        'selection-menu',
        trigger,
        menuItem('format', '格式', 'format') +
          menuItem('front', '置于顶层', 'layers') +
          menuItem('back', '置于底层', 'layers'),
      );
      break;
    case 'format':
      formatSelection(canvas);
      break;
    case 'drawing-options':
      canvas.openDrawingOptions();
      break;
    case 'front':
      canvas.editor.bringToFront();
      break;
    case 'back':
      canvas.editor.sendToBack();
      break;
    case 'find':
      extras.openFind();
      break;
    case 'duplicate':
      canvas.editor.duplicateSelection();
      break;
    case 'delete-selection':
      canvas.editor.deleteSelection();
      break;
    case 'arrow':
    case 'line':
    case 'laser':
      setTool(action);
      break;
    case 'undo':
      canvas.store.undo();
      break;
    case 'redo':
      canvas.store.redo();
      break;
    case 'scenes':
      extras.openScenes();
      break;
    case 'export':
      extras.openExport();
      break;
    case 'import':
      extras.openImport();
      break;
    case 'share':
      openSharing(board.id);
      break;
    case 'help':
      shortcuts();
      break;
    case 'fit':
      canvas.editor.fitContent({ margin: 0.1, maxZoom: 1.5, animate: 140 });
      break;
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset': {
      const { w, h } = canvas.editor.viewSize();
      canvas.editor.zoomAt(
        w / 2,
        h / 2,
        action === 'zoom-in' ? 1.25 : action === 'zoom-out' ? 0.8 : 1 / canvas.editor.camera.z,
        { animate: 120 },
      );
      break;
    }
    case 'grid': {
      const options: Array<[GridId, string]> = [
        ['dots', '点阵'],
        ['lines', '方格'],
        ['ruled', '横线'],
        ['crosses', '十字'],
        ['iso', '等距'],
        ['none', '空白'],
      ];
      showPanel(
        'grid',
        trigger,
        '<div class="menu-label">画布网格</div>' +
          options
            .map(
              ([id, name]) =>
                `<button class="menu-item grid-option" data-grid="${id}" aria-pressed="${canvas.editor.grid === id}"><span>${name}</span>${canvas.editor.grid === id ? icon('check', 16) : ''}</button>`,
            )
            .join(''),
      );
      break;
    }
  }
}

app.addEventListener('click', (event) => {
  const target =
    event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
  if (!target || !session || target.disabled) return;
  const { tool, action, color, kind, fill, grid } = target.dataset;
  if (tool === 'shape') {
    shapeMenu(target);
    return;
  }
  if (tool) {
    closePanel();
    setTool(tool as CanvasTool);
    surface.focus({ preventScroll: true });
    return;
  }
  if (color) {
    setColor(color);
    surface.focus({ preventScroll: true });
    return;
  }
  if (kind) {
    session.canvas.setShape(kind as GeoId);
    closePanel();
    surface.focus({ preventScroll: true });
    return;
  }
  if (fill) {
    session.canvas.editor.setStyle('fill', fill as FillId);
    for (const item of popover.querySelectorAll<HTMLElement>('[data-fill]'))
      item.setAttribute('aria-pressed', String(item.dataset.fill === fill));
    return;
  }
  if (grid) {
    session.canvas.editor.setGrid(grid as GridId);
    closePanel();
    return;
  }
  if (action) void command(action, target).catch((error) => toast(errorMessage(error)));
});

document.addEventListener(
  'pointerdown',
  (event) => {
    if (
      panel &&
      event.target instanceof Node &&
      !popover.contains(event.target) &&
      !lastPanelTrigger?.contains(event.target)
    )
      closePanel();
  },
  true,
);
window.addEventListener('resize', () => closePanel());
element<HTMLInputElement>('ink-color').addEventListener('input', (event) =>
  setColor((event.target as HTMLInputElement).value),
);
element<HTMLInputElement>('ink-width').addEventListener('input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (session && Number.isFinite(value)) {
    widths[activeTool] = value;
    session.canvas.setWidth(value);
    element('ink-width-value').textContent = value + ' px';
  }
});
picker.addEventListener('change', () => {
  const files = Array.from(picker.files ?? []);
  picker.value = '';
  void addFiles(files).catch((error) => toast(errorMessage(error)));
});
surface.addEventListener(
  'dragover',
  (event) => {
    if (event.dataTransfer?.types.includes('Files') && session?.board.role !== 'viewer')
      event.preventDefault();
  },
  true,
);
surface.addEventListener(
  'drop',
  (event) => {
    const files = event.dataTransfer?.files;
    if (!files?.length || !session) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = surface.getBoundingClientRect();
    const at = session.canvas.editor.screenToPage(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    void addFiles(Array.from(files), at).catch((error) => toast(errorMessage(error)));
  },
  true,
);
surface.addEventListener(
  'paste',
  (event) => {
    const files = event.clipboardData?.files;
    if (!files?.length || !session || session.board.role === 'viewer') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void addFiles(Array.from(files)).catch((error) => toast(errorMessage(error)));
  },
  true,
);

const toolKeys: Record<string, CanvasTool> = {
  v: 'select',
  '1': 'select',
  h: 'hand',
  p: 'pen',
  d: 'pen',
  b: 'pencil',
  i: 'marker',
  e: 'eraser',
  g: 'shape',
  t: 'text',
  n: 'note',
  a: 'arrow',
  l: 'line',
  k: 'laser',
};
document.addEventListener(
  'keydown',
  (event) => {
    if (document.querySelector('dialog[open]')) return;
    if (session && (event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyC') {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      session.chat.toggle();
      return;
    }
    if (
      (event.target instanceof Element && event.target.closest('#chat-panel')) ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable)
    )
      return;
    if (event.key === 'Escape' && panel) {
      event.preventDefault();
      event.stopPropagation();
      closePanel(true);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !session) return;
    const key = event.key.toLowerCase();
    if (toolKeys[key]) {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      setTool(toolKeys[key]);
      surface.focus({ preventScroll: true });
    }
  },
  true,
);

async function start() {
  await bootstrapSession();
  await consumeDeviceLink();
  const token = new URLSearchParams(location.hash.slice(1)).get('join');
  if (token) {
    await openBoard((await joinBoard(token)).id);
    return;
  }
  const id = new URL(location.href).searchParams.get('board');
  if (id) {
    await openBoard(id);
    return;
  }
  if (new URL(location.href).searchParams.get('sample') === 'agent-design') {
    await mount(await createAgentDesignSample());
    return;
  }
  const [board] = await listBoards();
  await mount(board ? await getBoard(board.id) : await createBoard('未命名画板'));
}
void start().catch((error) => {
  updateTitle('未能打开画板');
  const body = document.createElement('div');
  body.className = 'dialog-form';
  const message = document.createElement('p');
  message.textContent = errorMessage(error);
  const recover = document.createElement('button');
  recover.className = 'primary-action';
  recover.textContent = '返回我的画板';
  recover.onclick = () => {
    location.assign(location.pathname);
  };
  body.append(message, recover);
  modal('画板未打开', body);
});
