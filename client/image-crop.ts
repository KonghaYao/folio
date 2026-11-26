import type { ShapeRecord, Store } from '@quickdrawjs/core';
import { readAsset } from './asset-cache';

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
  ellipse: boolean;
}
const full: Crop = { left: 0, top: 0, right: 100, bottom: 100, ellipse: false };
export function cropImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  w: number,
  h: number,
  crop?: Crop,
) {
  if (!crop) {
    ctx.drawImage(image, 0, 0, w, h);
    return;
  }
  const c = crop,
    x = (image.naturalWidth * c.left) / 100,
    y = (image.naturalHeight * c.top) / 100;
  const sw = (image.naturalWidth * (c.right - c.left)) / 100,
    sh = (image.naturalHeight * (c.bottom - c.top)) / 100;
  if (!(sw > 0 && sh > 0)) return;
  ctx.save();
  if (c.ellipse) {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
    ctx.clip();
  }
  ctx.drawImage(image, x, y, sw, sh, 0, 0, w, h);
  ctx.restore();
}
export async function showCrop(shape: ShapeRecord, store: Store) {
  const asset = store.asset(shape.props.assetId);
  if (!asset || shape.props.locked) return;
  const view = document.createElement('dialog');
  view.setAttribute('aria-label', '裁剪图片');
  view.className = 'object-dialog';
  const h = document.createElement('h2');
  h.textContent = '裁剪图片';
  const preview = document.createElement('canvas');
  preview.width = 380;
  preview.height = 185;
  preview.style.cssText = 'width:100%;height:155px;object-fit:contain;background:#f3f4ef';
  const source = asset.src.startsWith('/api/')
    ? URL.createObjectURL(await readAsset(asset.src))
    : asset.src;
  const image = new Image();
  image.src = source;
  try {
    await image.decode();
  } catch (error) {
    if (source.startsWith('blob:')) URL.revokeObjectURL(source);
    throw error;
  }
  const state: Crop = { ...full, ...shape.props.crop };
  const paint = () => {
    if (!image.complete || !image.naturalWidth) return;
    const ctx = preview.getContext('2d')!;
    ctx.clearRect(0, 0, preview.width, preview.height);
    const ratio =
      (image.naturalWidth * (state.right - state.left)) /
      (image.naturalHeight * (state.bottom - state.top));
    const w = Math.min(preview.width, preview.height * ratio),
      h = w / ratio;
    ctx.save();
    ctx.translate((preview.width - w) / 2, (preview.height - h) / 2);
    cropImage(ctx, image, w, h, state);
    ctx.restore();
  };
  const close = () => view.close();
  view.addEventListener('keydown', (e) => e.stopPropagation());
  view.addEventListener(
    'close',
    () => {
      view.remove();
      if (source.startsWith('blob:')) URL.revokeObjectURL(source);
    },
    { once: true },
  );
  view.append(h, preview);
  const sliders: {
    input: HTMLInputElement;
    key: 'left' | 'right' | 'top' | 'bottom';
    out: HTMLOutputElement;
  }[] = [];
  function sync() {
    for (const { input, key, out } of sliders) {
      input.value = String(state[key]);
      out.value = state[key] + '%';
    }
    paint();
  }
  for (const [key, name] of [
    ['left', '左边界'],
    ['right', '右边界'],
    ['top', '上边界'],
    ['bottom', '下边界'],
  ] as const) {
    const row = document.createElement('label');
    row.style.cssText = 'display:grid;grid-template-columns:58px 1fr 42px;align-items:center';
    const title = document.createElement('span');
    title.textContent = name;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.setAttribute('aria-label', name);
    const out = document.createElement('output');
    input.oninput = () => {
      const min = key === 'right' ? state.left + 1 : key === 'bottom' ? state.top + 1 : 0;
      const max = key === 'left' ? state.right - 1 : key === 'top' ? state.bottom - 1 : 100;
      state[key] = Math.max(min, Math.min(Number(input.value), max));
      sync();
    };
    sliders.push({ input, key, out });
    row.append(title, input, out);
    view.append(row);
  }
  const mask = document.createElement('label'),
    check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = state.ellipse;
  check.onchange = () => {
    state.ellipse = check.checked;
    paint();
  };
  mask.append(check, '椭圆蒙版');
  view.append(mask);
  const footer = document.createElement('footer');
  function button(name: string, action: () => void) {
    const el = document.createElement('button');
    el.textContent = name;
    el.onclick = action;
    footer.append(el);
    return el;
  }
  button('恢复完整图片', () => {
    Object.assign(state, full);
    check.checked = false;
    sync();
  });
  button('取消', close);
  button('应用裁剪', () => {
    const current = store.get(shape.id);
    if (current?.typeName === 'shape' && !current.props.locked) {
      const ratio =
        (image.naturalWidth * (state.right - state.left)) /
        (image.naturalHeight * (state.bottom - state.top));
      if (Number.isFinite(ratio) && ratio > 0)
        store.update(shape.id, {
          props: { crop: { ...state }, h: Math.max(1, current.props.w / ratio) },
        });
    }
    close();
  }).className = 'primary-action';
  view.append(footer);
  document.body.append(view);
  view.showModal();
  sync();
}
