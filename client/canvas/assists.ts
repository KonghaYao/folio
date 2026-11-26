import { localBounds, pageBounds, type ShapeRecord } from '@quickdrawjs/core';
import type { Point } from './sdk';

type Size = { w: number; h: number };
export interface EraseCut {
  base: Size;
  radius: number;
  points: number[];
}

function inkSpan(shape: ShapeRecord) {
  // Store erasures in the same origin-relative space as Quickdraw's pts.
  // Extents track nonuniform resize including a horizontal or vertical stroke.
  const p = shape.props.pts,
    origin = p[0],
    top = p[1];
  let w = 0,
    h = 0;
  for (let i = 0; i < p.length; i += 3) {
    w = Math.max(w, Math.abs(p[i] - origin));
    h = Math.max(h, Math.abs(p[i + 1] - top));
  }
  return { w: w || 1, h: h || 1 };
}

export function toShape(shape: ShapeRecord, p: Point): Point {
  const b = localBounds(shape),
    cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  const x = p.x - shape.x - cx,
    y = p.y - shape.y - cy;
  const c = Math.cos(shape.rot),
    s = Math.sin(shape.rot);
  return { x: cx + c * x + s * y, y: cy - s * x + c * y };
}

function distance2(p: Point, a: Point, b: Point) {
  const x = b.x - a.x,
    y = b.y - a.y,
    len = x * x + y * y;
  const t = len ? Math.min(1, Math.max(0, ((p.x - a.x) * x + (p.y - a.y) * y) / len)) : 0;
  return (p.x - a.x - t * x) ** 2 + (p.y - a.y - t * y) ** 2;
}

export function appendTrail(trail: Point[], p: Point, scale: number) {
  const last = trail[trail.length - 1];
  if (last && (last.x - p.x) ** 2 + (last.y - p.y) ** 2 < (0.65 / scale) ** 2) return;
  const prev = trail[trail.length - 2];
  // Preserve corners and reversals while collapsing nearly straight runs.
  if (prev && distance2(last, prev, p) < (0.25 / scale) ** 2) trail[trail.length - 1] = p;
  else trail.push(p);
}

function capsule(ctx: CanvasRenderingContext2D, a: Point, b: Point, r: number, extent: number) {
  const theta = Math.atan2(b.y - a.y, b.x - a.x);
  const path = new Path2D();
  path.rect(-extent, -extent, 2 * extent, 2 * extent);
  path.moveTo(a.x + r * Math.cos(theta - Math.PI / 2), a.y + r * Math.sin(theta - Math.PI / 2));
  path.arc(b.x, b.y, r, theta - Math.PI / 2, theta + Math.PI / 2);
  path.arc(a.x, a.y, r, theta + Math.PI / 2, theta + (3 * Math.PI) / 2);
  path.closePath();
  ctx.clip(path, 'evenodd');
}

/** Subtract each capsule from just this object's clip. Underlying objects and
 * the paper are untouched, and export uses the same vector masks. */
export function clipErased(ctx: CanvasRenderingContext2D, shape: ShapeRecord) {
  const cuts = shape.props.erasures as EraseCut[] | undefined;
  if (!cuts?.length) return;
  const span = inkSpan(shape),
    box = localBounds(shape);
  const bound =
    Math.max(Math.abs(box.x), Math.abs(box.y), Math.abs(box.x + box.w), Math.abs(box.y + box.h)) +
    512;
  for (const cut of cuts) {
    const sx = span.w / cut.base.w,
      sy = span.h / cut.base.h;
    // Set the ellipse transform for the cut, then restore the transform while
    // retaining the clip for painting this shape.
    const matrix = ctx.getTransform();
    ctx.scale(sx, sy);
    let a = { x: cut.points[0], y: cut.points[1] };
    for (let n = 0; n < cut.points.length; n += 2) {
      const b = { x: cut.points[n], y: cut.points[n + 1] };
      capsule(ctx, a, b, cut.radius, bound / Math.min(sx, sy));
      a = b;
    }
    ctx.setTransform(matrix);
  }
}

export function erasedAt(shape: ShapeRecord, p: Point) {
  const cuts = shape.props.erasures as EraseCut[] | undefined;
  if (!cuts?.length) return false;
  const span = inkSpan(shape);
  for (const cut of cuts) {
    const q = { x: (p.x * cut.base.w) / span.w, y: (p.y * cut.base.h) / span.h };
    let a = { x: cut.points[0], y: cut.points[1] };
    for (let i = 0; i < cut.points.length; i += 2) {
      const b = { x: cut.points[i], y: cut.points[i + 1] };
      if (distance2(q, a, b) <= cut.radius ** 2) return true;
      a = b;
    }
  }
  return false;
}

export function cutFor(shape: ShapeRecord, trail: Point[], radius: number): EraseCut | undefined {
  if (!['draw', 'highlight'].includes(shape.type) || shape.props.locked || !trail.length) return;
  const points = trail.map((p) => toShape(shape, p)),
    samples = shape.props.pts;
  // Symmetric segment tests include a fast eraser crossing a sparse stroke.
  const width = shape.props.ink?.width ?? 8,
    reach2 = (radius + width * 2.5) ** 2;
  const l0 = { x: samples[0], y: samples[1] };
  let a = l0;
  for (let n = 0; n < samples.length; n += 3) {
    const b = { x: samples[n], y: samples[n + 1] };
    let c = points[0];
    for (const d of points) {
      if (
        intersects(a, b, c, d) ||
        Math.min(distance2(a, c, d), distance2(b, c, d), distance2(c, a, b), distance2(d, a, b)) <=
          reach2
      )
        return { base: inkSpan(shape), radius, points: points.flatMap((p) => [p.x, p.y]) };
      c = d;
    }
    a = b;
  }
}

const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function intersects(a: Point, b: Point, c: Point, d: Point) {
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}
function inside(p: Point, polygon: Point[]) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      hit = !hit;
  }
  return hit;
}

export function lassoHit(shape: ShapeRecord, trail: Point[]) {
  if (trail.length < 3) return false;
  const box = pageBounds(shape);
  if (!shape.props.pts) return inside({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, trail);
  const polygon = trail.map((p) => toShape(shape, p)),
    pts = shape.props.pts;
  let prev = { x: pts[0], y: pts[1] };
  for (let i = 0; i < pts.length; i += 3) {
    const p = { x: pts[i], y: pts[i + 1] };
    if (!erasedAt(shape, p) && inside(p, polygon)) return true;
    for (let j = 0; j < polygon.length; j++)
      if (intersects(prev, p, polygon[j], polygon[(j + 1) % polygon.length])) return true;
    prev = p;
  }
  return false;
}

export function projectToRuler(origin: Point, p: Point, degrees: number): Point {
  const a = (degrees * Math.PI) / 180,
    dx = Math.cos(a),
    dy = Math.sin(a);
  const t = (p.x - origin.x) * dx + (p.y - origin.y) * dy;
  return { x: origin.x + dx * t, y: origin.y + dy * t };
}
