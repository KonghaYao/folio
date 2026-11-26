import type { BoardEditor } from './editor';

export function showDrawingOptions(editor: BoardEditor) {
  if (editor.readonly) return;
  const view = document.createElement('dialog');
  view.className = 'folio-asset-dialog folio-drawing-options';
  view.setAttribute('aria-label', '绘图辅助');
  view.innerHTML =
    '<h2>绘图辅助</h2><section aria-label="选取与擦除"></section><label>局部橡皮直径 <input aria-label="局部橡皮直径" type="number" min="2" max="160" step="1"> px</label><label><input type="checkbox"> 使用直尺</label><label>直尺角度 <input aria-label="直尺角度" type="number" min="-180" max="180" step="1"> °</label><small>每一笔从落笔位置沿设置角度绘制。</small><footer><button type="button">完成</button></footer>';
  const [diameter, ruler, angle] = view.querySelectorAll('input');
  diameter.value = String(editor.eraserRadius * 2);
  ruler.checked = editor.rulerAngle !== null;
  angle.value = String(editor.rulerAngle ?? 0);
  const save = () => {
    editor.eraserRadius = Math.min(80, Math.max(1, Number(diameter.value) / 2 || 8));
    editor.rulerAngle = ruler.checked
      ? Math.min(180, Math.max(-180, Number(angle.value) || 0))
      : null;
  };
  const modes = [
    ['套索选择', 'lasso'],
    ['局部橡皮', 'partial'],
    ['对象橡皮', 'object'],
  ] as const;
  for (const [label, mode] of modes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute(
      'aria-pressed',
      String(
        editor.assist === mode || (mode === 'object' && !editor.assist && editor.tool === 'eraser'),
      ),
    );
    button.onclick = () => {
      save();
      editor.setAssist(mode);
      view.close();
    };
    view.querySelector('section')!.append(button);
  }
  view.querySelector('footer button')!.addEventListener('click', () => {
    save();
    if (ruler.checked && !['draw', 'highlight'].includes(editor.tool)) editor.setTool('draw');
    editor.requestRender();
    view.close();
  });
  view.addEventListener(
    'close',
    () => {
      view.remove();
      editor.container.focus({ preventScroll: true });
    },
    { once: true },
  );
  document.body.append(view);
  view.showModal();
}
