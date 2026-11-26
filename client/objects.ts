import { newId, pageBounds, type Editor, type ShapeRecord, type Store } from '@quickdrawjs/core';
import { showCrop } from './image-crop';
import './objects.css';

type ToolEditor = Editor & {
  registerRenderer(
    kind: string,
    renderer: (ctx: CanvasRenderingContext2D, shape: ShapeRecord) => void,
  ): unknown;
  registerOpenHandler(kind: string, handler: (shape: ShapeRecord) => void): unknown;
};
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
  const el = document.createElement(tag);
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function button(label: string, run: () => void) {
  const el = element('button', label);
  el.type = 'button';
  el.addEventListener('click', run);
  return el;
}
function label(title: string, el: HTMLElement) {
  const root = element('label');
  root.append(element('span', title), el);
  return root;
}
function drawTable(ctx: CanvasRenderingContext2D, shape: ShapeRecord) {
  const { cells, w, h } = shape.props;
  if (!Array.isArray(cells) || !cells.length || !Array.isArray(cells[0]) || !cells[0].length)
    return;
  const rows = cells.length,
    cols = cells[0].length,
    cw = w / cols,
    rh = h / rows;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e0eee5';
  ctx.fillRect(0, 0, w, rh);
  ctx.strokeStyle = '#98aaa0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let n = 0; n <= cols; n++) {
    ctx.moveTo(n * cw, 0);
    ctx.lineTo(n * cw, h);
  }
  for (let n = 0; n <= rows; n++) {
    ctx.moveTo(0, n * rh);
    ctx.lineTo(w, n * rh);
  }
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#213e35';
  const font = Math.min(22, Math.max(9, rh * 0.37));
  for (let r = 0; r < rows; r++) {
    ctx.font = (r === 0 ? '600 ' : '') + font + 'px system-ui, sans-serif';
    for (let c = 0; c < cols; c++) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(c * cw + 2, r * rh, cw - 4, rh);
      ctx.clip();
      ctx.fillText(String(cells[r]?.[c] ?? ''), c * cw + 8, (r + 0.5) * rh);
      ctx.restore();
    }
  }
}

export function mountObjectTools({ editor: raw, store }: { editor: Editor; store: Store }) {
  const editor = raw as ToolEditor;
  let dialog: HTMLDialogElement | null = null;
  function open(title: string) {
    dialog?.close();
    const view = element('dialog', '', 'object-dialog');
    const head = element('header');
    head.append(
      element('h2', title),
      button('关闭', () => view.close()),
    );
    view.setAttribute('aria-label', title);
    view.append(head);
    view.addEventListener(
      'close',
      () => {
        view.remove();
        if (dialog === view) dialog = null;
      },
      { once: true },
    );
    view.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.append(view);
    view.showModal();
    dialog = view;
    return view;
  }
  function selection() {
    if (editor.selection.size < 2) {
      const id = editor.selection.values().next().value;
      const record = id && store.get(id);
      return record && record.typeName === 'shape' ? [record] : [];
    }
    return store.shapes().filter((s) => editor.selection.has(s.id));
  }
  function center() {
    const { w, h } = editor.viewSize();
    return editor.screenToPage(w / 2, h / 2);
  }
  function shape(
    x: number,
    y: number,
    w: number,
    h: number,
    extra: Record<string, unknown> = {},
  ): ShapeRecord {
    return {
      id: newId(),
      typeName: 'shape',
      type: 'geo',
      x,
      y,
      rot: 0,
      z: store.maxZ() + 1,
      props: {
        geo: 'rectangle',
        w,
        h,
        color: 'green',
        size: 's',
        dash: 'solid',
        fill: 'semi',
        font: 'sans',
        ...extra,
      },
    };
  }
  function table(existing?: ShapeRecord) {
    if (editor.readonly) return;
    const selected = existing ?? selection().find((s) => s.props.kind === 'table');
    if (selected?.props.locked) return;
    let cells: string[][] = selected
      ? structuredClone(selected.props.cells)
      : [
          ['项目', '说明', '状态'],
          ['', '', ''],
          ['', '', ''],
        ];
    const view = open(selected ? '编辑表格' : '插入表格');
    const grid = element('div', '', 'cell-grid'),
      actions = element('footer'),
      warning = element('small');
    const render = () => {
      grid.replaceChildren();
      grid.style.gridTemplateColumns = 'repeat(' + cells[0].length + ', minmax(86px, 1fr))';
      cells.forEach((row, r) =>
        row.forEach((value, c) => {
          const input = element('input');
          input.value = value;
          input.maxLength = 1024;
          input.setAttribute('aria-label', '第' + (r + 1) + '行第' + (c + 1) + '列');
          input.oninput = () => {
            cells[r][c] = input.value;
          };
          grid.append(input);
        }),
      );
    };
    const save = button('保存表格', () => {
      if (selected && !store.has(selected.id)) {
        warning.textContent = '表格已被删除。';
        return;
      }
      if (selected) {
        store.update(selected.id, {
          props: {
            cells,
            w: (selected.props.w / cellsWidth(selected)) * cells[0].length,
            h: (selected.props.h / selected.props.cells.length) * cells.length,
          },
        });
      } else {
        const p = center(),
          w = 120 * cells[0].length,
          h = 39 * cells.length;
        const rec = shape(p.x - w / 2, p.y - h / 2, w, h, { kind: 'table', cells, fill: 'solid' });
        store.put(rec);
        editor.setTool('select');
        editor.setSelection([rec.id]);
      }
      view.close();
    });
    save.className = 'primary-action';
    actions.append(
      button('加行', () => {
        if (cells.length < 24) {
          cells.push(cells[0].map(() => ''));
          render();
        }
      }),
      button('加列', () => {
        if (cells[0].length < 12) {
          cells.forEach((r) => r.push(''));
          render();
        }
      }),
      button('删末行', () => {
        if (cells.length > 1) {
          cells.pop();
          render();
        }
      }),
      button('删末列', () => {
        if (cells[0].length > 1) {
          cells.forEach((r) => r.pop());
          render();
        }
      }),
      save,
    );
    view.append(grid, warning, actions);
    render();
  }
  function cellsWidth(record: ShapeRecord) {
    return record.props.cells[0].length as number;
  }
  function diagram() {
    if (editor.readonly) return;
    const view = open('插入流程图'),
      input = element('textarea');
    input.rows = 4;
    input.value = '开始\n处理\n完成';
    const submit = button('插入流程图', () => {
      const names = input.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 12);
      if (!names.length) return;
      const { x, y } = center(),
        nodes: ShapeRecord[] = [];
      store.transact(() => {
        names.forEach((name, i) => {
          const node = shape(x - 90, y + (i - (names.length - 1) / 2) * 110 - 28, 180, 56, {
            geo: i === 0 || i === names.length - 1 ? 'ellipse' : 'rectangle',
            label: name.slice(0, 220),
            color: i === 0 ? 'green' : 'blue',
          });
          nodes.push(node);
          store.put(node);
        });
        nodes.slice(1).forEach((target, i) => {
          const source = nodes[i],
            ax = source.x + 90,
            ay = source.y + 56;
          store.put({
            id: newId(),
            typeName: 'shape',
            type: 'arrow',
            z: store.maxZ() + 1,
            rot: 0,
            x: ax,
            y: ay,
            props: {
              color: 'grey',
              size: 's',
              dash: 'solid',
              dx: target.x + 90 - ax,
              dy: target.y - ay,
              bindings: {
                start: { id: source.id, u: 0.5, v: 1 },
                end: { id: target.id, u: 0.5, v: 0 },
              },
            },
          });
        });
      });
      editor.setTool('select');
      editor.setSelection([nodes[0].id]);
      view.close();
    });
    submit.className = 'primary-action';
    view.append(label('每行一个节点', input), submit);
  }
  function inspect() {
    const items = selection();
    const view = open('对象属性');
    if (!items.length) {
      view.append(element('p', '先在画板上选中一个或多个对象。'));
      return;
    }
    const first = items[0],
      one = items.length === 1;
    const desc = element('textarea');
    desc.value = one ? String(first.props.description ?? '') : '';
    desc.rows = 3;
    desc.maxLength = 1600;
    const angle = element('input');
    angle.type = 'number';
    angle.value = String(Math.round((first.rot * 180) / Math.PI));
    const lock = element('input');
    lock.type = 'checkbox';
    lock.checked = items.every((s) => s.props.locked);
    if (one) view.append(label('对象描述', desc));
    view.append(label('旋转角度（度）', angle), label('锁定位置与内容', lock));
    const actions = element('footer');
    if (one && first.type === 'image' && !first.props.locked && !editor.readonly)
      actions.append(
        button('裁剪图片', () => {
          view.close();
          void showCrop(first, store).catch(() => {
            const failed = open('裁剪图片');
            failed.append(element('p', '无法读取此图片。'));
          });
        }),
      );
    if (items.length > 1) {
      const left = Math.min(...items.map((s) => pageBounds(s).x)),
        top = Math.min(...items.map((s) => pageBounds(s).y));
      for (const [name, axis, position] of [
        ['左对齐', 'x', left],
        ['顶对齐', 'y', top],
      ] as const) {
        actions.append(
          button(name, () => {
            store.transact(() =>
              items.forEach((s) => {
                if (!s.props.locked)
                  store.update(s.id, { [axis]: s[axis] + position - pageBounds(s)[axis] });
              }),
            );
            view.close();
          }),
        );
      }
      actions.append(
        button('组合', () => {
          const groupId = newId('group');
          store.transact(() => items.forEach((s) => store.update(s.id, { props: { groupId } })));
          view.close();
        }),
      );
    }
    if (items.some((s) => s.props.groupId))
      actions.append(
        button('取消组合', () => {
          store.transact(() =>
            items.forEach((s) => store.update(s.id, { props: { groupId: null } })),
          );
          view.close();
        }),
      );
    const submit = button('应用', () => {
      store.transact(() =>
        items.forEach((s) => {
          if (!lock.checked && s.props.locked) store.update(s.id, { props: { locked: false } });
          if (!s.props.locked || !lock.checked)
            store.update(s.id, {
              rot: ((Number(angle.value) || 0) * Math.PI) / 180,
              props: { ...(one ? { description: desc.value } : {}), locked: lock.checked },
            });
        }),
      );
      view.close();
    });
    submit.className = 'primary-action';
    actions.append(submit);
    view.append(actions);
    if (editor.readonly)
      view
        .querySelectorAll<HTMLInputElement>('input,textarea,footer button')
        .forEach((el) => (el.disabled = true));
  }
  editor.registerRenderer('table', drawTable);
  editor.registerOpenHandler('table', (shape) => table(shape));
  return { table: () => table(), diagram, inspect, destroy: () => dialog?.close() };
}
