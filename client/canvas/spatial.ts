import RBush, { type BBox } from 'rbush';
import { pageBounds, type BoardRecord, type Bounds, type ShapeRecord } from '@quickdrawjs/core';
import type { VectorPath } from '../../shared/vector-path';

const localPaths = new WeakMap<VectorPath, BBox>();
const lengths: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

/** Conservative control hull in SVG-local coordinates, including reflected controls and rotated arcs. */
function pathHull(data: VectorPath) {
  const cached = localPaths.get(data);
  if (cached) return cached;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  function include(x: number, y: number) {
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  }
  let x = 0,
    y = 0,
    mx = 0,
    my = 0,
    cx = 0,
    cy = 0,
    prev = '',
    command = '';
  let args: number[] = [];
  const tokens = data.d.matchAll(/[MLHVQTCSAZ]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/gi);
  for (const [value] of tokens) {
    if (/^[a-z]$/i.test(value)) {
      command = value;
      args = [];
      if (command.toUpperCase() === 'Z') {
        x = mx;
        y = my;
        prev = 'Z';
      }
      continue;
    }
    args.push(Number(value));
    const kind = command.toUpperCase(),
      relative = kind !== command;
    if (args.length !== lengths[kind]) continue;
    const ox = relative ? x : 0,
      oy = relative ? y : 0;
    const px = (i: number) => args[i] + ox,
      py = (i: number) => args[i] + oy;
    if (kind === 'H') x = px(0);
    else if (kind === 'V') y = py(0);
    else {
      const nextX = px(args.length - 2),
        nextY = py(args.length - 1);
      if (kind === 'M') {
        mx = nextX;
        my = nextY;
        command = relative ? 'l' : 'L';
      }
      if (kind === 'C' || kind === 'Q') {
        cx = px(0);
        cy = py(1);
        include(cx, cy);
      }
      if (kind === 'S' || kind === 'T') {
        const reflect = kind === 'T' ? prev === 'T' || prev === 'Q' : prev === 'S' || prev === 'C';
        cx = reflect ? 2 * x - cx : x;
        cy = reflect ? 2 * y - cy : y;
        include(cx, cy);
      }
      if (kind === 'C' || kind === 'S') {
        cx = px(args.length - 4);
        cy = py(args.length - 3);
        include(cx, cy);
      }
      if (kind === 'A' && args[0] > 0 && args[1] > 0 && (x !== nextX || y !== nextY)) {
        const angle = (args[2] * Math.PI) / 180,
          dx = (x - nextX) / 2,
          dy = (y - nextY) / 2;
        const scale = Math.max(
          1,
          Math.hypot(
            (Math.cos(angle) * dx + Math.sin(angle) * dy) / args[0],
            (Math.cos(angle) * dy - Math.sin(angle) * dx) / args[1],
          ),
        );
        // Every point on an ellipse lies within one major diameter of either endpoint.
        const diameter = 2 * Math.max(args[0], args[1]) * scale;
        include(x - diameter, y - diameter);
        include(x + diameter, y + diameter);
      }
      x = nextX;
      y = nextY;
    }
    include(x, y);
    prev = kind;
    args = [];
  }
  localPaths.set(data, box);
  return box;
}

const stableBounds = new WeakMap<ShapeRecord, Bounds>();
/** Quickdraw's declared frame, with the same ink margin used by fit and export. */
export function documentBounds(shape: ShapeRecord): Bounds {
  const stable =
    shape.type !== 'text' && shape.type !== 'note' && (!shape.props.ink || shape.props.done);
  const cached = stable && stableBounds.get(shape);
  if (cached) return cached;
  const b = pageBounds(shape),
    m = shape.props.ink?.width ? shape.props.ink.width * 3 : 2;
  const result = { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
  if (stable) stableBounds.set(shape, result);
  return result;
}
const vectorBounds = new WeakMap<ShapeRecord, Bounds>();
/** Paint and hit candidates also include transformed SVG geometry outside its declared frame. */
export function shapeBounds(shape: ShapeRecord): Bounds {
  const base = documentBounds(shape),
    p = shape.props;
  if (p.kind !== 'vector-path' || !p.vectorPath) return base;
  const cached = vectorBounds.get(shape);
  if (cached) return cached;
  let left = base.x,
    top = base.y,
    right = base.x + base.w,
    bottom = base.y + base.h;
  if (p.kind === 'vector-path' && p.vectorPath) {
    const data: VectorPath = p.vectorPath,
      hull = pathHull(data),
      sx = p.w / data.w,
      sy = p.h / data.h;
    const radius = data.strokeWidth / 2,
      cx = p.w / 2,
      cy = p.h / 2,
      c = Math.cos(shape.rot),
      s = Math.sin(shape.rot);
    for (const x of [(hull.minX - radius) * sx, (hull.maxX + radius) * sx]) {
      for (const y of [(hull.minY - radius) * sy, (hull.maxY + radius) * sy]) {
        const px = shape.x + cx + c * (x - cx) - s * (y - cy),
          py = shape.y + cy + s * (x - cx) + c * (y - cy);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        left = Math.min(left, px);
        top = Math.min(top, py);
        right = Math.max(right, px);
        bottom = Math.max(bottom, py);
      }
    }
  }
  const bounds = { x: left, y: top, w: right - left, h: bottom - top };
  vectorBounds.set(shape, bounds);
  return bounds;
}

interface Entry extends BBox {
  shape: ShapeRecord;
}
function entry(shape: ShapeRecord): Entry {
  const b = shapeBounds(shape);
  return { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h, shape };
}
function vectorHitScale(shape: ShapeRecord) {
  const p = shape.props;
  if (p.kind !== 'vector-path' || !p.vectorPath?.strokeWidth) return 1;
  const x = p.w / p.vectorPath.w,
    y = p.h / p.vectorPath.h;
  return Math.max(1, Math.max(x, y) / Math.max(0.001, Math.min(x, y)));
}
function fromBox(b: BBox): Bounds {
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

/** A full replacement bulk-loads the tree. Large replacements build in bounded
 * event-loop slices; exact scans remain available during that initial paint. */
export class ShapeIndex {
  private tree = new RBush<Entry>();
  private entries = new Map<string, Entry>();
  private dirty = new Set<string>();
  private ready = false;
  private building?: MapIterator<BoardRecord>;
  private timer?: ReturnType<typeof setTimeout>;
  private frame?: number;
  private coldBounds?: Bounds;
  private hitScale = 1;
  private includesVectorPaths = false;
  constructor(private records: Map<string, BoardRecord>) {}
  changed(id: string) {
    this.coldBounds = undefined;
    if (this.ready || this.entries.has(id)) this.dirty.add(id);
  }
  fontsChanged() {
    this.coldBounds = undefined;
    for (const [id, { shape }] of this.entries)
      if (shape.type === 'text' || shape.type === 'note') this.changed(id);
  }
  dispose() {
    clearTimeout(this.timer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.building = undefined;
    this.ready = false;
    this.entries.clear();
    this.tree.clear();
    this.dirty.clear();
    this.coldBounds = undefined;
  }
  private add(shape: ShapeRecord) {
    const value = entry(shape);
    if (shape.props.kind === 'vector-path') this.includesVectorPaths = true;
    this.entries.set(shape.id, value);
    this.hitScale = Math.max(this.hitScale, vectorHitScale(shape));
    return value;
  }
  private buildSlice() {
    if (!this.building) return;
    const items: Entry[] = [];
    // Chunk size limits both geometry work and RBush's bulk sort in a single task.
    for (let n = 0; n < 1024; n++) {
      const cursor = this.building.next();
      if (cursor.done) {
        this.ready = true;
        this.building = undefined;
        break;
      }
      const shape = cursor.value;
      if (shape.typeName === 'shape' && !this.entries.has(shape.id)) items.push(this.add(shape));
    }
    if (items.length) this.tree.load(items);
    if (this.building) this.timer = setTimeout(() => this.buildSlice(), 0);
  }
  private sync() {
    if (this.building || (this.ready && !this.dirty.size)) return;
    if (!this.ready || (this.dirty.size > 256 && this.dirty.size * 3 > this.entries.size)) {
      this.tree.clear();
      this.entries.clear();
      this.hitScale = 1;
      this.includesVectorPaths = false;
      this.dirty.clear();
      this.coldBounds = undefined;
      if (this.records.size >= 4096 && typeof requestAnimationFrame === 'function') {
        this.ready = false;
        this.building = this.records.values();
        this.frame = requestAnimationFrame(() => {
          this.frame = undefined;
          this.timer = setTimeout(() => this.buildSlice(), 0);
        });
        return;
      }
      const values = [];
      for (const r of this.records.values()) if (r.typeName === 'shape') values.push(this.add(r));
      this.tree.load(values);
      this.ready = true;
    } else {
      for (const id of this.dirty) {
        const old = this.entries.get(id);
        if (old) {
          this.tree.remove(old);
          this.entries.delete(id);
        }
        const r = this.records.get(id);
        if (r?.typeName === 'shape') this.tree.insert(this.add(r));
      }
      this.dirty.clear();
    }
  }
  search(b: Bounds, hitTolerance = 0) {
    this.sync();
    if (!this.ready) {
      const found: ShapeRecord[] = [];
      for (const s of this.records.values()) {
        if (s.typeName !== 'shape') continue;
        const pb = shapeBounds(s),
          t = hitTolerance ? hitTolerance * vectorHitScale(s) : 0;
        if (
          pb.x + pb.w >= b.x - t &&
          pb.x <= b.x + b.w + t &&
          pb.y + pb.h >= b.y - t &&
          pb.y <= b.y + b.h + t
        )
          found.push(s);
      }
      return found;
    }
    const t = hitTolerance * this.hitScale;
    return this.tree
      .search({ minX: b.x - t, minY: b.y - t, maxX: b.x + b.w + t, maxY: b.y + b.h + t })
      .map((item) => item.shape);
  }
  bounds(): Bounds | null {
    this.sync();
    if (this.ready && !this.includesVectorPaths)
      return this.entries.size ? fromBox(this.tree.toJSON()) : null;
    if (!this.coldBounds) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const s of this.records.values()) {
        if (s.typeName !== 'shape') continue;
        const b = documentBounds(s);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }
      if (minX === Infinity) return null;
      this.coldBounds = fromBox({ minX, minY, maxX, maxY });
    }
    return { ...this.coldBounds };
  }
}

export function paintOrder(a: ShapeRecord, b: ShapeRecord) {
  return (
    Number(a.type !== 'highlight') - Number(b.type !== 'highlight') ||
    a.z - b.z ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
