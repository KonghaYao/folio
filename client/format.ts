import type { DashId, FillId, FontId, SizeId } from '@quickdrawjs/core';
import type { BoardCanvas } from './canvas';
import { modal } from './dialogs';

/** Only touched fields are applied, preserving mixed styles across multi-selection. */
export function formatSelection(canvas: BoardCanvas) {
  const { editor, store } = canvas;
  const selected = store
    .shapes()
    .filter((shape) => editor.selection.has(shape.id) && !shape.props.locked);
  if (editor.readonly || !selected.length) return;
  const body = document.createElement('form');
  body.className = 'dialog-form';
  const changes: Array<() => void> = [];
  const canFill = selected.some((s) => s.type === 'geo' && !s.props.kind);
  const canFont = selected.some((s) => ['text', 'note', 'geo'].includes(s.type) && !s.props.kind);
  const canDash = selected.some((s) => ['line', 'arrow', 'geo'].includes(s.type) && !s.props.kind);
  function choices<T extends string>(
    labelText: string,
    options: Array<[T, string]>,
    save: (value: T) => void,
  ) {
    const label = document.createElement('label');
    label.textContent = labelText;
    const select = document.createElement('select');
    select.add(new Option('保持原样', ''));
    for (const [value, caption] of options) select.add(new Option(caption, value));
    changes.push(() => {
      if (select.value) save(select.value as T);
    });
    label.append(select);
    body.append(label);
  }
  const label = document.createElement('label'),
    color = document.createElement('input');
  label.textContent = '颜色';
  color.type = 'color';
  const current = selected[0].props.ink?.color ?? selected[0].props.color;
  color.value = /^#[\da-f]{6}$/i.test(current) ? current : '#263e36';
  let colored = false;
  color.oninput = () => {
    colored = true;
  };
  label.append(color);
  body.append(label);
  changes.push(() => {
    if (colored) canvas.setColor(color.value);
  });
  choices<SizeId>(
    '大小',
    [
      ['s', '小'],
      ['m', '中'],
      ['l', '大'],
      ['xl', '特大'],
    ],
    (size) => {
      editor.setStyle('size', size);
      for (const s of selected) {
        const shape = store.get(s.id);
        if (shape?.typeName === 'shape' && shape.props.ink)
          store.update(s.id, {
            props: { ink: { ...shape.props.ink, width: { s: 2, m: 4, l: 8, xl: 16 }[size] } },
          });
      }
    },
  );
  if (canFont)
    choices<FontId>(
      '字体',
      [
        ['sans', '无衬线'],
        ['serif', '衬线'],
        ['mono', '等宽'],
        ['draw', '手写'],
      ],
      (v) => editor.setStyle('font', v),
    );
  if (canDash)
    choices<DashId>(
      '线型',
      [
        ['solid', '实线'],
        ['dashed', '虚线'],
        ['dotted', '点线'],
        ['draw', '手绘'],
      ],
      (v) => editor.setStyle('dash', v),
    );
  if (canFill)
    choices<FillId>(
      '填充',
      [
        ['none', '无'],
        ['semi', '淡色'],
        ['solid', '实心'],
        ['pattern', '斜线'],
      ],
      (v) => editor.setStyle('fill', v),
    );
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary-action';
  submit.textContent = '应用格式';
  body.append(submit);
  const dialog = modal('选区格式', body);
  body.onsubmit = (e) => {
    e.preventDefault();
    if (!editor.readonly) store.transact(() => changes.forEach((apply) => apply()));
    dialog.close();
  };
}
