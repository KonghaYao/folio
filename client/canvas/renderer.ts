import { cropImage } from '../image-crop';
import {
  drawShape,
  hitShape,
  localBounds,
  type Bounds,
  type Camera,
  type ShapeRecord,
  type Theme,
} from '@quickdrawjs/core';
import { imageData, paintCard } from './attachments';
import { clipErased, erasedAt, toShape } from './assists';
import { inkPath, paintInk, type Ink } from './ink';
import { paintVector, hitVector } from './vector-path';
import { ViewportBuffer } from './viewport-buffer';
import { shapeBounds as boxOf, documentBounds, paintOrder } from './spatial';
import type { BoardStore } from './store';
import { DottedPaper } from './paper';
import { QuickdrawEditor, type Renderer, type ShapePaintOptions } from './sdk';

export function paperTheme(theme: Theme): Theme {
  // Records may come from another browser, so CSS colors resolve at render time.
  const customColors = new Map<string, Theme['colors'][keyof Theme['colors']]>();
  const colors = new Proxy(
    { ...theme.colors },
    {
      get(target, key) {
        if (typeof key !== 'string') return undefined;
        if (Object.hasOwn(target, key)) return target[key as keyof typeof target];
        const cached = customColors.get(key);
        if (cached) return cached;
        if (!/^#[\da-f]{6}$/i.test(key)) return target.black;
        const rgb = [1, 3, 5].map((i) => parseInt(key.slice(i, i + 2), 16));
        const tint = (amount: number) =>
          'rgb(' + rgb.map((n) => Math.round(n + (255 - n) * amount)).join(',') + ')';
        const color = { stroke: key, fill: key, note: tint(0.72) };
        if (customColors.size >= 1024) customColors.clear();
        customColors.set(key, color);
        return color;
      },
    },
  );
  return { ...theme, colors, background: theme.id === 'light' ? '#ffffff' : theme.background };
}

function transformed(ctx: CanvasRenderingContext2D, s: ShapeRecord) {
  const b = localBounds(s);
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  ctx.translate(s.x + cx, s.y + cy);
  ctx.rotate(s.rot);
  ctx.translate(-cx, -cy);
}

export class CanvasRenderer extends QuickdrawEditor {
  declare store: BoardStore;
  private visibleRegion?: {
    revision: number;
    zoom: number;
    region: Bounds;
    records: ShapeRecord[];
  };
  private visibleShapes(cam: Camera, w: number, h: number) {
    const x = -cam.x,
      y = -cam.y,
      width = w / cam.z,
      height = h / cam.z;
    const previous = this.visibleRegion;
    let records: ShapeRecord[];
    if (
      previous &&
      previous.revision === this.store.generation &&
      previous.zoom === cam.z &&
      previous.region.x <= x &&
      previous.region.y <= y &&
      x + width <= previous.region.x + previous.region.w &&
      y + height <= previous.region.y + previous.region.h &&
      previous.region.w <= width * 2 &&
      previous.region.h <= height * 2
    ) {
      records = previous.records;
    } else {
      // Keep canonical paint order while panning, using a small screen-space margin.
      // A changed record invalidates this list before the next paint.
      const margin = 48 / cam.z,
        region = { x: x - margin, y: y - margin, w: width + margin * 2, h: height + margin * 2 };
      records = this.store.shapesInBounds(region).sort(paintOrder);
      this.visibleRegion = { revision: this.store.generation, zoom: cam.z, region, records };
    }
    return records.filter((s) => {
      const b = boxOf(s);
      return b.x + b.w >= x && b.y + b.h >= y && b.x <= x + width && b.y <= y + height;
    });
  }
  private readonly dots = new DottedPaper();
  private readonly viewportBuffer = new ViewportBuffer();
  protected pendingSegments: ShapeRecord[] = [];
  protected draft: ShapeRecord | undefined;
  private painters = new Map<string, Renderer>([
    ['attachment', paintCard],
    ['link', paintCard],
    ['vector-path', paintVector],
  ]);
  private images = new WeakMap<
    object,
    { image?: HTMLImageElement; ready: Promise<void>; failedAt?: number }
  >();
  private sorted?: { generation: number; records: ShapeRecord[] };
  override shapesSorted() {
    const generation = (this.store as import('./store').BoardStore).generation;
    if (!this.sorted || this.sorted.generation !== generation)
      this.sorted = { generation, records: super.shapesSorted() };
    return this.sorted.records.slice();
  }
  retryImages() {
    this.viewportBuffer.invalidate();
    this.images = new WeakMap();
    this.requestRender();
  }

  registerRenderer(kind: string, painter: Renderer) {
    this.painters.set(kind, painter);
    this.viewportBuffer.invalidate();
    this.requestRender();
  }

  private loadImage(s: ShapeRecord) {
    const asset = this.store.asset(s.props.assetId);
    if (!asset) return;
    let cached = this.images.get(asset);
    if (cached && (!cached.failedAt || Date.now() - cached.failedAt < 5000)) return cached;
    cached = { ready: Promise.resolve() };
    this.images.set(asset, cached);
    const entry = cached;
    entry.ready = imageData(asset.src)
      .then((image) => {
        entry.image = image;
        this.viewportBuffer.invalidate();
        this.requestRender();
      })
      .catch(() => {
        entry.failedAt = Date.now();
      });
    return entry;
  }

  override contentBounds(): Bounds | null {
    return this.store.drawingBounds();
  }

  async prepareImages(shapes: ShapeRecord[] = this.store.shapes(), requireDecoded = false) {
    await Promise.all(
      shapes
        .filter((s) => s.type === 'image')
        .map(async (s) => {
          const entry = this.loadImage(s);
          await entry?.ready;
          if (requireDecoded && !entry?.image)
            throw new Error('无法完整导出。图片未能读取：' + (s.props.attachment?.name || s.id));
        }),
    );
  }

  override hitTest(px: number, py: number) {
    const tolerance = 8 / this.camera.z;
    // Quickdraw hitShape allows up to two XL pen widths past pageBounds.
    const pad = 20;
    const ordered = this.store
      .shapesInBounds({ x: px - pad, y: py - pad, w: 2 * pad, h: 2 * pad }, tolerance)
      .sort(paintOrder);
    for (let i = ordered.length - 1; i >= 0; i--) {
      const s = ordered[i];
      if (s.props.erasures && erasedAt(s, toShape(s, { x: px, y: py }))) continue;
      if (s.props.kind === 'vector-path') {
        if (hitVector(this.canvas.getContext('2d')!, s, toShape(s, { x: px, y: py }), tolerance))
          return s;
        continue;
      }
      if (hitShape(s, px, py, tolerance, this.store)) return s;
      if (!s.props.ink) continue;
      const box = boxOf(s);
      if (px < box.x || px > box.x + box.w || py < box.y || py > box.y + box.h) continue;
      const bounds = localBounds(s);
      const cx = bounds.x + bounds.w / 2,
        cy = bounds.y + bounds.h / 2;
      const dx = px - s.x - cx,
        dy = py - s.y - cy;
      const cos = Math.cos(s.rot),
        sin = Math.sin(s.rot);
      const x = cx + cos * dx + sin * dy,
        y = cy - sin * dx + cos * dy;
      // Selection and object erasure also reach the broad edge of a side-shaded stroke.
      const ctx = this.canvas.getContext('2d')!;
      ctx.save();
      ctx.resetTransform();
      const inside = ctx.isPointInPath(inkPath(s), x, y);
      ctx.restore();
      if (inside) return s;
    }
    return null;
  }

  private paint(ctx: CanvasRenderingContext2D, s: ShapeRecord, opts: ShapePaintOptions) {
    const custom = s.props.ink ? paintInk : this.painters.get(s.props.kind);
    if (!custom && s.type !== 'image' && !s.props.erasures) {
      if (s.type === 'geo' && s.props.faceColor) {
        const key = s.props.color as keyof typeof opts.theme.colors;
        const colors = {
          ...opts.theme.colors,
          [key]: { ...opts.theme.colors[key], fill: s.props.faceColor },
        };
        drawShape(ctx, s, { ...opts, theme: { ...opts.theme, colors } });
      } else drawShape(ctx, s, opts);
      return;
    }
    ctx.save();
    if (opts.ghost) ctx.globalAlpha *= 0.3;
    transformed(ctx, s);
    if (s.props.erasures) clipErased(ctx, s);
    if (s.type === 'image') {
      const image = this.loadImage(s)?.image;
      if (image) cropImage(ctx, image, s.props.w, s.props.h, s.props.crop);
      else {
        ctx.fillStyle = '#e8e9e4';
        ctx.fillRect(0, 0, s.props.w, s.props.h);
      }
    } else if (custom) custom(ctx, s, opts);
    else drawShape(ctx, { ...s, x: 0, y: 0, rot: 0 }, opts);
    ctx.restore();
  }

  private paper(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, dpr: number) {
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, w * dpr, h * dpr);
    if (this.grid !== 'dots') {
      this._drawGrid(ctx, cam, w * dpr, h * dpr, dpr);
      return;
    }
    this.dots.paint(ctx, cam, w, h, dpr, this.theme.id === 'dark');
  }

  private scene(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    w: number,
    h: number,
    shapes: ShapeRecord[],
    { dpr = 1, background = true, hideEditing = false } = {},
  ) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (background) this.paper(ctx, cam, w, h, dpr);
    else ctx.clearRect(0, 0, w * dpr, h * dpr);
    ctx.setTransform(cam.z * dpr, 0, 0, cam.z * dpr, cam.x * cam.z * dpr, cam.y * cam.z * dpr);
    for (const s of shapes) {
      const box = boxOf(s);
      if (
        box.x + box.w < -cam.x ||
        box.y + box.h < -cam.y ||
        box.x > w / cam.z - cam.x ||
        box.y > h / cam.z - cam.y
      )
        continue;
      this.paint(ctx, s, {
        theme: this.theme,
        store: this.store,
        zoom: cam.z,
        ghost: hideEditing && this.session?.type === 'erasing' && this.session.hits?.has(s.id),
        hideText: hideEditing && this.editing?.id === s.id ? this.editing.field : null,
      });
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Highlighters blend beneath regular objects. Recompose only their pixel-aligned
  // dirty rectangle so that existing text, strokes, images and overlaps keep their order.
  private repaintMarker(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    w: number,
    h: number,
    dpr: number,
    marks: ShapeRecord[],
    preview: boolean,
  ) {
    const scale = cam.z * dpr;
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const mark of marks) {
      const b = boxOf(mark);
      left = Math.min(left, Math.floor((b.x + cam.x) * scale) - 2);
      top = Math.min(top, Math.floor((b.y + cam.y) * scale) - 2);
      right = Math.max(right, Math.ceil((b.x + b.w + cam.x) * scale) + 2);
      bottom = Math.max(bottom, Math.ceil((b.y + b.h + cam.y) * scale) + 2);
    }
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(w * dpr, right);
    bottom = Math.min(h * dpr, bottom);
    if (left >= right || top >= bottom) return;
    const nearby = this.store
      .shapesInBounds({
        x: left / scale - cam.x,
        y: top / scale - cam.y,
        w: (right - left) / scale,
        h: (bottom - top) / scale,
      })
      .sort(paintOrder);
    if (preview) {
      const firstRegular = nearby.findIndex((s) => s.type !== 'highlight');
      nearby.splice(firstRegular < 0 ? nearby.length : firstRegular, 0, ...marks);
    }
    ctx.save();
    ctx.resetTransform();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    this.scene(ctx, cam, w, h, nearby, { dpr });
    ctx.restore();
  }

  protected appendCommittedInk(previous: number, records: ShapeRecord[]) {
    this.viewportBuffer.append(previous, this.store.generation, (ctx, cam, width, height) => {
      const dpr = ctx.canvas.width / width;
      if (records[0].type === 'highlight') {
        this.repaintMarker(ctx, cam, width, height, dpr, records, false);
        return;
      }
      const scale = dpr * cam.z;
      ctx.setTransform(scale, 0, 0, scale, cam.x * scale, cam.y * scale);
      const options = { theme: this.theme, store: this.store, zoom: cam.z, hideText: null };
      for (const record of records) this.paint(ctx, record, options);
      ctx.resetTransform();
    });
  }

  override destroy() {
    this.viewportBuffer.invalidate();
    super.destroy();
  }

  private paintBuffered(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    w: number,
    h: number,
    shapes: () => ShapeRecord[],
    dpr: number,
  ) {
    // The raster contains the complete committed scene, including the paper for multiply blending.
    if (ctx.canvas !== this.canvas || this.editing || this.session?.type === 'erasing')
      return false;
    const reused = this.viewportBuffer.draw(
      ctx,
      cam,
      w,
      h,
      dpr,
      (this.store as import('./store').BoardStore).generation,
      this.grid + '/' + this.theme.id,
      // Long stylus strokes are expensive to rasterize every frame even when the
      // scene holds few shapes, so buffer them as soon as any real ink exists.
      () => {
        const list = shapes();
        return (
          list.length >= 350 ||
          list.some((s) => ((s.props.ink as Ink | undefined)?.samples.length ?? 0) >= 256)
        );
      },
      (surface, expanded, width, height) => {
        this.scene(surface, expanded, width, height, this.visibleShapes(expanded, width, height), {
          dpr,
        });
      },
      () => {
        this.requestRender();
      },
    );
    if (!reused) return false;
    if (this.draft) {
      // The raster already holds the committed scene, so live ink only needs to
      // be blended on top. This keeps stylus latency independent of board size.
      ctx.setTransform(cam.z * dpr, 0, 0, cam.z * dpr, cam.x * cam.z * dpr, cam.y * cam.z * dpr);
      const options = { theme: this.theme, store: this.store, zoom: cam.z, hideText: null };
      for (const s of this.pendingSegments) this.paint(ctx, s, options);
      this.paint(ctx, this.draft, options);
      ctx.resetTransform();
    }
    return true;
  }

  override renderScene(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    w: number,
    h: number,
    opts: { dpr?: number; background?: boolean; hideEditing?: boolean } = {},
  ) {
    let ordered: ShapeRecord[] | undefined;
    const candidates = () => (ordered ??= this.visibleShapes(cam, w, h));
    if (
      opts.hideEditing &&
      opts.background !== false &&
      this.paintBuffered(ctx, cam, w, h, candidates, opts.dpr ?? 1)
    )
      return;
    const shapes = candidates();
    if (this.draft && opts.hideEditing) {
      if (this.draft.type === 'highlight') {
        const index = shapes.findIndex((s) => s.type !== 'highlight');
        shapes.splice(index < 0 ? shapes.length : index, 0, ...this.pendingSegments, this.draft);
      } else shapes.push(...this.pendingSegments, this.draft);
    }
    this.scene(ctx, cam, w, h, shapes, opts);
  }

  override async exportImage({
    background = true,
    scale = 2,
    margin = 48,
    ids = null,
  }: {
    background?: boolean;
    scale?: number;
    margin?: number;
    ids?: Set<string> | null;
  } = {}) {
    const shapes = this.shapesSorted().filter((s) => !ids || ids.has(s.id));
    if (!shapes.length) return null;
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const s of shapes) {
      const b = documentBounds(s);
      left = Math.min(left, b.x);
      top = Math.min(top, b.y);
      right = Math.max(right, b.x + b.w);
      bottom = Math.max(bottom, b.y + b.h);
    }
    const w = Math.max(1, right - left + margin * 2),
      h = Math.max(1, bottom - top + margin * 2);
    const z = Math.min(scale, 8192 / Math.max(w, h), Math.sqrt(24e6 / (w * h)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w * z));
    canvas.height = Math.max(1, Math.ceil(h * z));
    await this.prepareImages(shapes, true);
    this.scene(
      canvas.getContext('2d')!,
      { x: margin - left, y: margin - top, z },
      canvas.width,
      canvas.height,
      shapes,
      { background },
    );
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  }
}
