import { validRecord } from '../../server/records';
import { MAX_BOARD_BYTES, MAX_MUTATION_BYTES } from '../../server/protocol';
import { pageBounds, type Editor, type ShapeRecord, type Store } from '@quickdrawjs/core';

type Slot = 'text' | 'label' | 'description' | 'cells' | 'url' | 'filename';
interface Field {
  id: string;
  slot: Slot;
  row?: number;
  col?: number;
  value: string;
  editable: boolean;
}
interface Match extends Field {
  count: number;
}
export interface SearchResult {
  fields: Match[];
  total: number;
  editable: number;
  pattern: RegExp;
}

function* fieldsOf(shape: ShapeRecord): Generator<Field> {
  const p = shape.props;
  const editable = !p.locked;
  for (const slot of ['text', 'label', 'description', 'url'] as const) {
    if (typeof p[slot] === 'string' && p[slot])
      yield { id: shape.id, slot, value: p[slot], editable: editable && slot !== 'url' };
  }
  if (p.kind === 'table' && Array.isArray(p.cells)) {
    for (const [row, cells] of p.cells.entries()) {
      if (!Array.isArray(cells)) continue;
      for (const [col, value] of cells.entries())
        if (typeof value === 'string' && value) {
          yield { id: shape.id, slot: 'cells', row, col, value, editable };
        }
    }
  }
  if (typeof p.attachment?.name === 'string') {
    yield { id: shape.id, slot: 'filename', value: p.attachment.name, editable: false };
  }
}

export function searchBoard(store: Store, query: string): SearchResult {
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const found: SearchResult = { fields: [], total: 0, editable: 0, pattern };
  if (!query) return found;
  for (const shape of store.shapes()) {
    for (const field of fieldsOf(shape)) {
      let count = 0;
      pattern.lastIndex = 0;
      while (pattern.test(field.value)) count++;
      if (!count) continue;
      found.fields.push({ ...field, count });
      found.total += count;
      if (field.editable) found.editable += count;
    }
  }
  return found;
}

function occurrence(result: SearchResult, index: number) {
  for (const field of result.fields) {
    if (index >= field.count) {
      index -= field.count;
      continue;
    }
    result.pattern.lastIndex = 0;
    let match = result.pattern.exec(field.value)!;
    while (index-- > 0) match = result.pattern.exec(field.value)!;
    return { field, at: match.index, length: match[0].length };
  }
}

export function replaceText(
  store: Store,
  query: string,
  replacement: string,
  index?: number,
): number {
  const result = searchBoard(store, query);
  const current = index === undefined ? undefined : occurrence(result, index);
  const fields = index === undefined ? result.fields : current ? [current.field] : [];
  const updates = new Map<string, ShapeRecord['props']>();
  let replaced = 0;
  let growth = 0;
  for (const field of fields) {
    if (!field.editable) continue;
    const matchCount = current ? 1 : field.count;
    // Bound replacement expansion before allocating repeated text.
    growth += matchCount * Math.max(0, replacement.length - query.length);
    if (
      growth > MAX_BOARD_BYTES ||
      field.value.length + matchCount * (replacement.length - query.length) > MAX_MUTATION_BYTES
    ) {
      throw new Error('替换后的文本过长，请分次修改');
    }
    const after = current
      ? field.value.slice(0, current.at) +
        replacement +
        field.value.slice(current.at + current.length)
      : field.value.replace(result.pattern, () => replacement);
    const item = store.get(field.id);
    if (item?.typeName !== 'shape') continue;
    const props = updates.get(field.id) ?? { ...item.props };
    if (field.slot === 'cells') {
      if (props.cells === item.props.cells)
        props.cells = item.props.cells.map((row: string[]) => [...row]);
      props.cells[field.row!][field.col!] = after;
    } else props[field.slot] = after;
    updates.set(field.id, props);
    replaced += matchCount;
  }
  if (!updates.size) return 0;
  let boardBytes = 0;
  for (const item of store.all()) {
    const next = updates.has(item.id) ? { ...item, props: updates.get(item.id) } : item;
    if (updates.has(item.id) && !validRecord(item.id, next)) {
      throw new Error('替换后的内容超过对象允许的范围');
    }
    const size = new Blob([JSON.stringify(next)]).size;
    if (updates.has(item.id) && size + item.id.length + 256 > MAX_MUTATION_BYTES) {
      throw new Error('对象超过保存限额，请缩短替换文本');
    }
    boardBytes += size;
  }
  if (boardBytes > MAX_BOARD_BYTES) throw new Error('画板超过保存限额，请缩短替换文本');
  store.transact(() => {
    for (const [id, props] of updates) store.update(id, { props });
  });
  return replaced;
}

function focusShape(editor: Editor, id: string) {
  const shape = editor.store.get(id);
  if (shape?.typeName !== 'shape') return;
  const b = pageBounds(shape);
  const { w, h } = editor.viewSize();
  const z = Math.max(
    0.05,
    Math.min(1.5, (w * 0.66) / Math.max(1, b.w), (h * 0.72) / Math.max(1, b.h)),
  );
  editor.setCamera({ z, x: (0.48 * w) / z - (b.x + b.w / 2), y: (0.54 * h) / z - (b.y + b.h / 2) });
  editor.setSelection([id]);
}

export function showFind(editor: Editor): { close: () => void; focus: () => void } {
  const panel = document.createElement('section');
  panel.className = 'folio-find';
  panel.setAttribute('role', 'search');
  panel.setAttribute('aria-label', '画板内查找');
  const entry = (label: string, id: string) => {
    const el = document.createElement('input');
    el.type = 'text';
    el.placeholder = label;
    el.setAttribute('aria-label', label);
    el.dataset.action = id;
    el.maxLength = 512;
    return el;
  };
  const button = (label: string, id: string) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.dataset.action = id;
    return el;
  };
  const search = entry('查找文本', 'find-query');
  const substitute = entry('替换为', 'find-value');
  const previous = button('上一处', 'find-prev');
  const next = button('下一处', 'find-next');
  const done = button('完成', 'find-close');
  const replace = button('替换', 'find-replace');
  const all = button('全部替换', 'find-replace-all');
  const hits = document.createElement('output');
  hits.setAttribute('aria-live', 'polite');
  const preview = document.createElement('p');
  const top = document.createElement('div');
  top.className = 'folio-find-row';
  top.append(search, previous, next, done);
  const edits = document.createElement('div');
  edits.className = 'folio-find-row';
  edits.append(substitute, replace, all);
  panel.append(top, hits, preview);
  if (!editor.readonly) panel.append(edits);
  document.body.append(panel);
  let index = 0;
  let found = searchBoard(editor.store, '');
  const labels: Record<Slot, string> = {
    text: '正文',
    label: '标签',
    description: '描述',
    cells: '表格',
    url: '网址',
    filename: '文件名',
  };
  function refresh(move: boolean, updated = '') {
    index = Math.max(0, Math.min(index, found.total - 1));
    const match = occurrence(found, index);
    previous.disabled = next.disabled = found.total < 2;
    replace.disabled = !match?.field.editable;
    all.disabled = !found.editable;
    hits.textContent =
      updated +
      (search.value ? (found.total ? index + 1 + ' / ' + found.total : '无匹配结果') : '');
    preview.replaceChildren();
    if (!match) return;
    const { field, at, length } = match;
    preview.append(labels[field.slot] + ' · ', field.value.slice(Math.max(0, at - 24), at));
    const mark = document.createElement('mark');
    mark.textContent = field.value.slice(at, at + length);
    preview.append(mark, field.value.slice(at + length, at + length + 42));
    if (move) focusShape(editor, field.id);
  }
  const recalculate = (move = false, updated = '') => {
    found = searchBoard(editor.store, search.value);
    refresh(move, updated);
  };
  const off = editor.store.listen(() => recalculate());
  const close = () => {
    off();
    panel.remove();
  };
  done.onclick = () => {
    close();
    editor.container.focus({ preventScroll: true });
  };
  const step = (n: number) => {
    if (!found.total) return;
    index = (index + n + found.total) % found.total;
    refresh(true);
  };
  previous.onclick = () => step(-1);
  next.onclick = () => step(1);
  search.oninput = () => {
    index = 0;
    recalculate(true);
  };
  const replaceMatches = (every: boolean) => {
    if (editor.readonly) return;
    try {
      const count = replaceText(
        editor.store,
        search.value,
        substitute.value,
        every ? undefined : index,
      );
      recalculate(true, '已替换 ' + count + ' 处　');
    } catch (error) {
      hits.textContent = error instanceof Error ? error.message : '替换失败';
    }
  };
  replace.onclick = () => replaceMatches(false);
  all.onclick = () => replaceMatches(true);
  panel.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      done.click();
    }
    if (event.key === 'Enter' && event.target === search) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
    if (event.key === 'Enter' && event.target === substitute) {
      event.preventDefault();
      replaceMatches(false);
    }
    event.stopPropagation();
  };
  search.focus();
  refresh(false);
  return {
    close,
    focus: () => {
      if (panel.isConnected) {
        search.focus();
        search.select();
      }
    },
  };
}
