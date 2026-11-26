import {
  localBounds,
  Store,
  type BoardRecord,
  type DiffSource,
  type Bounds,
  type ShapeRecord,
} from '@quickdrawjs/core';
import { ShapeIndex } from './spatial';

type Point = { x: number; y: number };
type Anchor = { id: string; u: number; v: number };
type Bindings = { start?: Anchor; end?: Anchor };

function rotate(point: Point, center: Point, angle: number): Point {
  const dx = point.x - center.x,
    dy = point.y - center.y;
  return {
    x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}
function anchorFrame(shape: ShapeRecord) {
  const box = localBounds(shape);
  const x = shape.x + box.x,
    y = shape.y + box.y;
  return { x, y, w: box.w, h: box.h, center: { x: x + box.w / 2, y: y + box.h / 2 } };
}

function isNode(shape: ShapeRecord) {
  return ['geo', 'note', 'text', 'image'].includes(shape.type);
}

export class BoardStore extends Store {
  generation = 0;
  orderGeneration = 0;
  private readonly spatial = new ShapeIndex(this.records);
  private count = 0;
  private high: number | undefined = 0;
  private low: number | undefined = 0;
  get shapeCount() {
    return this.count;
  }
  override maxZ() {
    return (this.high ??= super.maxZ());
  }
  override minZ() {
    return (this.low ??= super.minZ());
  }

  shapesInBounds(bounds: Bounds, hitTolerance = 0) {
    return this.spatial.search(bounds, hitTolerance);
  }
  disposeIndex() {
    this.spatial.dispose();
  }
  drawingBounds() {
    return this.spatial.bounds();
  }
  fontsChanged() {
    this.spatial.fontsChanged();
    this.generation++;
  }

  private geometryChanged(id: string, before?: BoardRecord, after?: BoardRecord) {
    const prev = before?.typeName === 'shape' ? before : undefined;
    const next = after?.typeName === 'shape' ? after : undefined;
    if (!prev && !next) return;
    this.count += Number(!!next) - Number(!!prev);
    if (
      !prev ||
      !next ||
      prev.z !== next.z ||
      (prev.type === 'highlight') !== (next.type === 'highlight')
    )
      this.orderGeneration++;
    this.spatial.changed(id);
    if (prev?.z === next?.z) return;
    if (prev && this.high === prev.z && (!next || next.z < prev.z)) this.high = undefined;
    if (prev && this.low === prev.z && (!next || next.z > prev.z)) this.low = undefined;
    if (next && this.high !== undefined) this.high = Math.max(this.high, next.z);
    if (next && this.low !== undefined) this.low = Math.min(this.low, next.z);
  }
  private linksByTarget = new Map<string, Set<string>>();

  override shapes() {
    return this.all().filter((r): r is ShapeRecord => r.typeName === 'shape');
  }

  anchorAt(point: Point, tolerance: number): Anchor | undefined {
    const pad = Math.SQRT2 * tolerance;
    const shapes = this.shapesInBounds({
      x: point.x - pad,
      y: point.y - pad,
      w: 2 * pad,
      h: 2 * pad,
    })
      .filter(isNode)
      .sort((a, b) => b.z - a.z);
    const ties = new Map<string, Anchor>();
    let topZ: number | undefined;
    for (const s of shapes) {
      if (topZ !== undefined && topZ !== s.z) break;
      const box = anchorFrame(s);
      const p = rotate(point, box.center, -s.rot);
      if (
        p.x < box.x - tolerance ||
        p.x > box.x + box.w + tolerance ||
        p.y < box.y - tolerance ||
        p.y > box.y + box.h + tolerance
      )
        continue;
      const u = Math.min(1, Math.max(0, (p.x - box.x) / Math.max(1, box.w)));
      const v = Math.min(1, Math.max(0, (p.y - box.y) / Math.max(1, box.h)));
      topZ = s.z;
      ties.set(s.id, { id: s.id, u, v });
    }
    if (ties.size === 1) return ties.values().next().value;
    // Native anchorAt resolves equal-z overlaps in document insertion order.
    if (ties.size > 1) for (const id of this.records.keys()) if (ties.has(id)) return ties.get(id);
  }

  private pointOf(anchor?: Anchor) {
    if (!anchor) return;
    const rec = this.get(anchor.id);
    if (rec?.typeName !== 'shape') return;
    const b = anchorFrame(rec);
    return rotate({ x: b.x + anchor.u * b.w, y: b.y + anchor.v * b.h }, b.center, rec.rot);
  }

  private track(rec: BoardRecord | undefined, add: boolean) {
    if (rec?.typeName !== 'shape') return;
    const bindings = rec.props.bindings as Bindings | undefined;
    for (const anchor of [bindings?.start, bindings?.end]) {
      if (!anchor) continue;
      let links = this.linksByTarget.get(anchor.id);
      if (add && !links) this.linksByTarget.set(anchor.id, (links = new Set()));
      if (add) links?.add(rec.id);
      else {
        links?.delete(rec.id);
        if (!links?.size) this.linksByTarget.delete(anchor.id);
      }
    }
  }

  private reflow(targetId: string) {
    for (const id of this.linksByTarget.get(targetId) ?? []) {
      const line = this.get(id);
      if (line?.typeName !== 'shape') continue;
      const bindings = line.props.bindings as Bindings;
      const a = this.pointOf(bindings.start) ?? { x: line.x, y: line.y };
      const b = this.pointOf(bindings.end) ?? {
        x: line.x + line.props.dx,
        y: line.y + line.props.dy,
      };
      this.spatial.changed(line.id);
      super.put({
        ...line,
        x: a.x,
        y: a.y,
        rot: 0,
        props: { ...line.props, dx: b.x - a.x, dy: b.y - a.y },
      });
    }
  }

  override put(rec: BoardRecord, source: DiffSource = 'user') {
    const previous = this.get(rec.id);
    const history = (this as unknown as { _applyingHistory?: boolean })._applyingHistory;
    if (
      source === 'user' &&
      !history &&
      previous?.typeName === 'shape' &&
      previous.props.locked &&
      rec.typeName === 'shape' &&
      rec.props.locked
    )
      return;
    this.transact(() => {
      this.generation++;
      this.geometryChanged(rec.id, previous, rec);
      this.track(previous, false);
      super.put(rec, source);
      this.track(rec, true);
      if (source === 'user' && !history && rec.typeName === 'shape' && isNode(rec))
        this.reflow(rec.id);
    }, source);
  }

  override remove(ids: string[], source: DiffSource = 'user') {
    const history = (this as unknown as { _applyingHistory?: boolean })._applyingHistory;
    this.transact(() => {
      const removable = ids.filter((id) => {
        const r = this.get(id);
        return source === 'remote' || history || r?.typeName !== 'shape' || !r.props.locked;
      });
      if (removable.length) this.generation++;
      for (const id of new Set(removable)) {
        const previous = this.get(id);
        this.geometryChanged(id, previous);
        this.track(previous, false);
      }
      super.remove(removable, source);
    }, source);
  }
}
