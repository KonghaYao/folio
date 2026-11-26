import type { ShapeRecord } from '@quickdrawjs/core';
import { validVectorPath, type VectorPath } from '../../shared/vector-path';
import type { Point, Renderer } from './sdk';

const paths = new WeakMap<VectorPath, Path2D>();

function pathOf(shape: ShapeRecord) {
  const data = shape.props.vectorPath as VectorPath;
  if (!data || typeof data !== 'object') return;
  let path = paths.get(data);
  if (!path) {
    if (!validVectorPath(data)) return;
    path = new Path2D(data.d);
    paths.set(data, path);
  }
  return { path, data };
}

export const paintVector: Renderer = (ctx, shape, { theme }) => {
  const geometry = pathOf(shape);
  if (!geometry) return;
  const { path, data } = geometry;
  ctx.scale(shape.props.w / data.w, shape.props.h / data.h);
  if (data.fill !== 'none') {
    ctx.fillStyle = data.fill;
    ctx.fill(path);
  }
  if (data.strokeWidth) {
    ctx.strokeStyle = theme.colors[shape.props.color as keyof typeof theme.colors].stroke;
    ctx.lineWidth = data.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
};

export function hitVector(
  ctx: CanvasRenderingContext2D,
  shape: ShapeRecord,
  local: Point,
  tolerance: number,
) {
  const geometry = pathOf(shape);
  if (!geometry) return false;
  const { path, data } = geometry;
  const sx = shape.props.w / data.w,
    sy = shape.props.h / data.h;
  const x = local.x / sx,
    y = local.y / sy;
  ctx.save();
  ctx.resetTransform();
  ctx.lineWidth = data.strokeWidth + (2 * tolerance) / Math.max(0.001, Math.min(sx, sy));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const hit =
    (data.fill !== 'none' && ctx.isPointInPath(path, x, y)) ||
    (data.strokeWidth > 0 && ctx.isPointInStroke(path, x, y));
  ctx.restore();
  return hit;
}
