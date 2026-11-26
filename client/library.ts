import type { LibraryBoard, LibraryFolder, LibraryState } from '../server/library-store';
import { cacheLibrary, cachedLibrary, currentCacheScope } from './offline';
import './library.css';

interface LibraryOptions {
  currentBoardId?: string;
  onOpen(id: string): void | Promise<void>;
  onCreate(): void | Promise<void>;
}
type LibraryView =
  | { kind: 'all' | 'favorites' | 'shared' | 'trash' }
  | { kind: 'folder'; id: string };

const roles = { owner: '我的画板', editor: '可编辑', viewer: '仅查看' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, name = '', text = '') {
  const node = document.createElement(tag);
  if (name) node.className = name;
  if (text) node.textContent = text;
  return node;
}
function button(name: string, onClick: () => void, style = '') {
  const node = el('button', style, name);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export async function openBoardLibrary(options: LibraryOptions): Promise<void> {
  if (document.querySelector('dialog.folio-library[open]')) return;
  const dialog = el('dialog', 'folio-library');
  dialog.setAttribute('aria-label', '画板库');
  const head = el('header', 'library-head');
  const search = el('input', 'library-search');
  search.type = 'search';
  search.placeholder = '搜索画板名称或内容';
  search.maxLength = 120;
  search.setAttribute('aria-label', search.placeholder);
  const create = button('新建画板', () => leave(options.onCreate), 'library-primary');
  const close = button('×', () => dialog.close(), 'library-close');
  close.setAttribute('aria-label', '关闭画板库');
  head.append(el('h2', '', '画板库'), search, create, close);
  const layout = el('div', 'library-layout');
  const nav = el('nav', 'library-nav');
  nav.setAttribute('aria-label', '画板分类');
  const body = el('section', 'library-body');
  const status = el('p', 'library-status');
  status.setAttribute('role', 'status');
  layout.append(nav, body);
  dialog.append(head, layout, status);
  document.body.append(dialog);
  const abort = new AbortController();
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let data: LibraryState = { folders: [], boards: [] };
  let view: LibraryView = { kind: 'all' };
  let busy = false;
  let offline = false;
  let fingerprint = '';
  const backgroundRefresh = () => {
    if (
      document.visibilityState === 'visible' &&
      dialog.open &&
      !busy &&
      !dialog.querySelector('.library-folder-form')
    )
      void refresh(true);
  };
  const poll = window.setInterval(backgroundRefresh, 5000);
  window.addEventListener('focus', backgroundRefresh);
  document.addEventListener('visibilitychange', backgroundRefresh);
  dialog.addEventListener(
    'close',
    () => {
      clearTimeout(queryTimer);
      clearInterval(poll);
      window.removeEventListener('focus', backgroundRefresh);
      document.removeEventListener('visibilitychange', backgroundRefresh);
      abort.abort();
      dialog.remove();
    },
    { once: true },
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      )
        dialog.close();
    }
  });
  // Keep board-level keyboard shortcuts from operating the canvas while browsing.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  search.addEventListener('input', () => {
    clearTimeout(queryTimer);
    sequence++;
    queryTimer = setTimeout(() => void refresh(), 160);
  });
  dialog.showModal();
  search.focus();
  await refresh();

  async function leave(action: () => void | Promise<void>) {
    if (busy) return;
    try {
      await action();
      dialog.close();
    } catch {
      status.textContent = '无法打开画板，请重试。';
    }
  }

  async function refresh(quiet = false): Promise<void> {
    const current = ++sequence;
    const scope = currentCacheScope();
    const term = search.value.trim();
    let result: LibraryState;
    let networkResponse = false;
    let offlineResult = false;
    try {
      const response = await fetch('/api/library?q=' + encodeURIComponent(term), {
        signal: abort.signal,
      });
      networkResponse = true;
      if (!response.ok) throw new Error();
      result = (await response.json()) as LibraryState;
      if (!term && current === sequence)
        await cacheLibrary(result, scope ?? currentCacheScope()).catch(() => {});
    } catch {
      if (current !== sequence || abort.signal.aborted) return;
      const saved = networkResponse ? undefined : await cachedLibrary(scope).catch(() => undefined);
      if (!saved) {
        if (!quiet) status.textContent = '读取画板库失败，请联网后重试。';
        return;
      }
      result = {
        folders: saved.folders,
        boards: saved.boards.filter((board) =>
          board.title.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
        ),
      };
      offlineResult = true;
    }
    if (current !== sequence || abort.signal.aborted || (scope && scope !== currentCacheScope()))
      return;
    const next = JSON.stringify(result) + String(offlineResult);
    if (quiet && fingerprint === next) return;
    data = result;
    fingerprint = next;
    offline = offlineResult;
    status.textContent = offline ? '离线浏览。可按名称搜索，已打开过的画板可离线编辑。' : '';
    const previousScroll = [nav.scrollTop, body.scrollTop];
    render();
    nav.scrollTop = previousScroll[0]!;
    body.scrollTop = previousScroll[1]!;
  }

  async function change(
    path: string,
    method: 'POST' | 'PATCH',
    payload: object,
    after?: (result: Response) => Promise<void> | void,
  ) {
    if (busy || offline) return;
    busy = true;
    try {
      const response = await fetch('/api/library/' + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error();
      await after?.(response);
      await refresh();
    } catch {
      if (!abort.signal.aborted) status.textContent = '更改未保存，请重试。';
    } finally {
      busy = false;
    }
  }

  function switchView(next: LibraryView): void {
    view = next;
    dialog.querySelector('.library-folder-form')?.remove();
    render();
  }

  function navItem(name: string, next: LibraryView): HTMLButtonElement {
    const active =
      next.kind === 'folder'
        ? view.kind === 'folder' && view.id === next.id
        : view.kind === next.kind;
    const item = button(name, () => switchView(next), 'library-navitem');
    item.setAttribute('aria-current', active ? 'page' : 'false');
    return item;
  }

  function folderForm(folder?: LibraryFolder): void {
    const existing = dialog.querySelector('.library-folder-form');
    existing?.remove();
    const form = el('form', 'library-folder-form');
    const field = el('input');
    field.placeholder = '文件夹名称';
    field.setAttribute('aria-label', '文件夹名称');
    field.value = folder?.name ?? '';
    field.required = true;
    field.maxLength = 160;
    const save = el('button', '', '保存');
    save.type = 'submit';
    form.append(
      field,
      save,
      button('取消', () => form.remove()),
    );
    nav.append(form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!field.value.trim()) return;
      if (folder)
        void change('folders/' + folder.id, 'PATCH', { name: field.value.trim() }, () =>
          form.remove(),
        );
      else
        void change('folders', 'POST', { name: field.value.trim() }, async (response) => {
          form.remove();
          const created = (await response.json()) as LibraryFolder;
          view = { kind: 'folder', id: created.id };
        });
    });
    field.focus();
    field.select();
  }

  function renderRow(board: LibraryBoard): HTMLElement {
    const row = el('div', 'library-row');
    const main = el('div', 'library-row-main');
    const title =
      view.kind === 'trash'
        ? el('span', 'library-row-title', board.title)
        : button(board.title, () => leave(() => options.onOpen(board.id)), 'library-row-title');
    const meta = [roles[board.role], dateFormat.format(board.updatedAt)];
    if (board.id === options.currentBoardId) meta.push('当前画板');
    const folderName = data.folders.find((folder) => folder.id === board.folderId)?.name;
    if (folderName && view.kind !== 'folder') meta.push(folderName);
    main.append(title, el('small', '', meta.join(' · ')));
    row.append(main);
    if (view.kind === 'trash') {
      row.append(
        button('恢复', () => void change('boards/' + board.id, 'PATCH', { trashed: false })),
      );
      return row;
    }
    const star = button(
      board.favorite ? '★' : '☆',
      () => void change('boards/' + board.id, 'PATCH', { favorite: !board.favorite }),
      'library-star',
    );
    star.setAttribute(
      'aria-label',
      board.favorite ? '取消收藏 ' + board.title : '收藏 ' + board.title,
    );
    star.setAttribute('aria-pressed', String(board.favorite));
    star.title = board.favorite ? '取消收藏' : '收藏';
    const move = el('select', 'library-action');
    move.setAttribute('aria-label', '管理 ' + board.title);
    move.title = '移动画板或移入废纸篓';
    function option(value: string, text: string) {
      const entry = el('option', '', text);
      entry.value = value;
      move.append(entry);
    }
    option('', '管理…');
    if (board.folderId) option('root', '移出文件夹');
    for (const folder of data.folders.filter(
      (f) => f.trashedAt === null && f.id !== board.folderId,
    ))
      option('folder:' + folder.id, '移至 ' + folder.name);
    option('trash', '移入我的废纸篓');
    move.addEventListener('change', () => {
      const value = move.value;
      move.value = '';
      if (!value) return;
      void change(
        'boards/' + board.id,
        'PATCH',
        value === 'trash'
          ? { trashed: true }
          : { folderId: value === 'root' ? null : value.slice(7) },
      );
    });
    row.append(star, move);
    return row;
  }

  function render(): void {
    const sections = [
      ['all', '全部画板'],
      ['favorites', '收藏'],
      ['shared', '与我共享'],
      ['trash', '废纸篓'],
    ] as const;
    const editor = nav.querySelector<HTMLFormElement>('.library-folder-form');
    const editorFocus = editor?.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    nav.replaceChildren(...sections.map(([kind, name]) => navItem(name, { kind })));
    const heading = el('div', 'library-folders-head');
    const addFolder = button('+', () => folderForm(), 'library-add');
    addFolder.setAttribute('aria-label', '新建文件夹');
    heading.append(el('span', '', '文件夹'), addFolder);
    nav.append(heading);
    for (const folder of data.folders.filter((f) => f.trashedAt === null))
      nav.append(navItem(folder.name, { kind: 'folder', id: folder.id }));
    if (editor) {
      nav.append(editor);
      editorFocus?.focus({ preventScroll: true });
    }
    const selectedFolder =
      view.kind === 'folder'
        ? data.folders.find((f) => view.kind === 'folder' && f.id === view.id)
        : undefined;
    const items = data.boards.filter((b) => {
      if (view.kind === 'trash') return b.trashedAt !== null;
      if (b.trashedAt !== null) return false;
      if (view.kind === 'favorites') return b.favorite;
      if (view.kind === 'shared') return b.role !== 'owner';
      return view.kind !== 'folder' || b.folderId === view.id;
    });
    const title =
      selectedFolder?.name ?? sections.find(([kind]) => kind === view.kind)?.[1] ?? '画板';
    const sectionHead = el('div', 'library-section-head');
    sectionHead.append(el('h3', '', title));
    if (selectedFolder) {
      sectionHead.append(
        button('重命名', () => folderForm(selectedFolder)),
        button(
          '移入废纸篓',
          () =>
            void change('folders/' + selectedFolder.id, 'PATCH', { trashed: true }, () => {
              view = { kind: 'trash' };
            }),
        ),
      );
    }
    body.replaceChildren(sectionHead);
    let count = items.length;
    if (view.kind === 'trash') {
      body.append(el('p', 'library-hint', '此处只影响你的画板库。恢复文件夹也会恢复其中的画板。'));
      const query = search.value.trim().toLocaleLowerCase();
      for (const folder of data.folders.filter(
        (f) => f.trashedAt !== null && f.name.toLocaleLowerCase().includes(query),
      )) {
        const row = el('div', 'library-row');
        const main = el('div', 'library-row-main');
        main.append(el('span', 'library-row-title', folder.name), el('small', '', '文件夹'));
        row.append(
          main,
          button(
            '恢复文件夹',
            () => void change('folders/' + folder.id, 'PATCH', { trashed: false }),
          ),
        );
        body.append(row);
        count++;
      }
    }
    for (const item of items) body.append(renderRow(item));
    if (offline) {
      create.disabled = true;
      body
        .querySelectorAll<
          HTMLButtonElement | HTMLSelectElement
        >('button:not(.library-row-title),select')
        .forEach((node) => {
          node.disabled = true;
        });
      addFolder.disabled = true;
    } else create.disabled = false;
    if (!count)
      body.append(
        el('p', 'library-empty', search.value.trim() ? '没有匹配的画板。' : '这里还没有画板。'),
      );
  }
}
