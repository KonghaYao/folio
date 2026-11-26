import { strokeOutline, type ShapeRecord } from '@quickdrawjs/core';

export type Brush = 'pen' | 'pencil' | 'marker';
export type Sample = [
  x: number,
  y: number,
  pressure: number,
  tiltX: number,
  tiltY: number,
  twist: number,
  tangentialPressure: number,
];
export interface Ink {
  version: 1;
  brush: Brush;
  color: string;
  width: number;
  samples: Sample[];
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const radians = Math.PI / 180;

export function readSample(event: PointerEvent, x: number, y: number): Sample {
  // Pointer Events defines zero as a valid contact pressure. The fallback is
  // for a missing sensor only; a true light touch must remain reproducible.
  let tiltX = event.tiltX || 0,
    tiltY = event.tiltY || 0;
  const altitude = event.altitudeAngle,
    azimuth = event.azimuthAngle;
  if (
    !tiltX &&
    !tiltY &&
    Number.isFinite(altitude) &&
    altitude >= 0 &&
    altitude < Math.PI / 2 - 1e-5 &&
    Number.isFinite(azimuth)
  ) {
    const horizontal = Math.cos(altitude),
      vertical = Math.sin(altitude);
    tiltX = Math.atan2(horizontal * Math.cos(azimuth), vertical) / radians;
    tiltY = Math.atan2(horizontal * Math.sin(azimuth), vertical) / radians;
  }
  return [
    x,
    y,
    clamp(event.pressure ?? 0.5, 0, 1),
    clamp(tiltX, -90, 90),
    clamp(tiltY, -90, 90),
    clamp(event.twist || 0, 0, 359),
    clamp(event.tangentialPressure || 0, -1, 1),
  ];
}

/** Elliptic contact patch from the stylus tilt planes, in CSS page units. */
export function footprint(sample: Sample, ink: Pick<Ink, 'brush' | 'width'>) {
  const [, , pressure, tiltX, tiltY, twist, barrel] = sample;
  const tx = Math.tan(radians * clamp(tiltX, -89.99, 89.99));
  const ty = Math.tan(radians * clamp(tiltY, -89.99, 89.99));
  const inclination = Math.atan(Math.hypot(tx, ty)) / (Math.PI / 2);
  const angle = Math.atan2(ty, tx) + (ink.brush === 'marker' ? twist * radians : 0);
  const radius = (ink.width * (0.18 + 0.82 * Math.pow(pressure, 0.75)) * (1 + 0.15 * barrel)) / 2;
  const spread = ink.brush === 'pencil' ? 3.5 : ink.brush === 'marker' ? 2 : 0.9;
  return {
    a: Math.max(0.12, radius * (1 + spread * inclination)),
    b: Math.max(0.12, radius),
    angle,
  };
}

const cached = new WeakMap<object, Path2D>();
interface DraftPath {
  path: Path2D;
  count: number;
}
const drafts = new WeakMap<object, DraftPath>();

type Nib = { x: number; y: number; a: number; b: number; angle: number };

/** Append the support geometry for samples [start, end) in page coordinates. */
function appendSamples(path: Path2D, shape: ShapeRecord, ink: Ink, start: number, end: number) {
  const pts = shape.props.pts as number[];
  let previous: Nib | undefined;
  if (start > 0) {
    const { a, b, angle } = footprint(ink.samples[start - 1], ink);
    previous = { x: pts[(start - 1) * 3], y: pts[(start - 1) * 3 + 1], a, b, angle };
  }
  for (let i = start; i < end; i++) {
    const { a, b, angle } = footprint(ink.samples[i], ink);
    const x = pts[i * 3],
      y = pts[i * 3 + 1];
    path.moveTo(x + a * Math.cos(angle), y + a * Math.sin(angle));
    path.ellipse(x, y, a, b, angle, 0, Math.PI * 2);
    path.closePath();
    if (previous) {
      const dx = x - previous.x,
        dy = y - previous.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.001) {
        const normalX = -dy / distance,
          normalY = dx / distance;
        const startSupport = support(previous, normalX, normalY);
        const endSupport = support({ a, b, angle }, normalX, normalY);
        // Match ellipse winding so overlaps add under the nonzero fill rule.
        path.moveTo(previous.x - startSupport.x, previous.y - startSupport.y);
        path.lineTo(x - endSupport.x, y - endSupport.y);
        path.lineTo(x + endSupport.x, y + endSupport.y);
        path.lineTo(previous.x + startSupport.x, previous.y + startSupport.y);
        path.closePath();
      }
    }
    previous = { x, y, a, b, angle };
  }
}

function draftPath(shape: ShapeRecord, ink: Ink) {
  const count = Math.min(ink.samples.length, Math.floor((shape.props.pts as number[]).length / 3));
  let entry = drafts.get(shape.props);
  if (!entry || entry.count > count) {
    entry = { path: new Path2D(), count: 0 };
    drafts.set(shape.props, entry);
  }
  if (entry.count < count) {
    appendSamples(entry.path, shape, ink, entry.count, count);
    entry.count = count;
  }
  return entry.path;
}

function makePath(shape: ShapeRecord, ink: Ink) {
  const path = new Path2D();
  const pts = shape.props.pts as number[];
  if (!pts.length || !ink.samples.length) return path;
  // Mouse crayons use the Quickdraw velocity outline. With hardware telemetry,
  // each sample contributes the support points of an oriented ellipse.
  if (!shape.props.isPen && ink.brush === 'pen' && pts.length > 3) {
    const outline = strokeOutline(pts, { size: ink.width, simulate: true, streamline: 0.18 });
    for (let i = 0; i < outline.length; i += 2) {
      if (i === 0) path.moveTo(outline[i], outline[i + 1]);
      else path.lineTo(outline[i], outline[i + 1]);
    }
    path.closePath();
    return path;
  }
  // Quickdraw transforms its native pts during resize. Those are authoritative
  // for replay coordinates; samples preserve the original digitizer telemetry.
  const count = Math.min(ink.samples.length, Math.floor(pts.length / 3));
  appendSamples(path, shape, ink, 0, count);
  return path;
}

function support(nib: { a: number; b: number; angle: number }, nx: number, ny: number) {
  const cos = Math.cos(nib.angle),
    sin = Math.sin(nib.angle);
  const u = cos * nx + sin * ny,
    v = -sin * nx + cos * ny;
  const h = Math.hypot(nib.a * u, nib.b * v);
  const su = (nib.a ** 2 * u) / h,
    sv = (nib.b ** 2 * v) / h;
  return { x: su * cos - sv * sin, y: su * sin + sv * cos };
}

export function inkPath(shape: ShapeRecord) {
  const ink = shape.props.ink as Ink;
  // Live stylus strokes arrive sample by sample. Append only the new geometry
  // instead of rebuilding the whole path on every animation frame.
  if (!shape.props.done && (shape.props.isPen || ink.brush !== 'pen')) {
    return draftPath(shape, ink);
  }
  let path = cached.get(shape.props);
  if (!path) {
    path = makePath(shape, ink);
    if (shape.props.done) cached.set(shape.props, path);
  }
  return path;
}

export function paintInk(ctx: CanvasRenderingContext2D, shape: ShapeRecord) {
  const ink = shape.props.ink as Ink;
  const path = inkPath(shape);
  ctx.fillStyle = ink.color;
  if (ink.brush === 'marker') {
    ctx.globalAlpha *= 0.38;
    ctx.globalCompositeOperation = 'multiply';
  }
  if (ink.brush === 'pencil') ctx.globalAlpha *= 0.83;
  ctx.fill(path);
}
