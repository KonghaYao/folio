import { newId, localBounds, type ShapeRecord } from '@quickdrawjs/core';
import { vectorPathError } from '../../shared/vector-path';
import { validRecord } from '../../server/records';
import type { Sample } from '../canvas/ink';
import type { Change, CreateObject } from './schemas';

const geoKinds = ['rectangle', 'ellipse', 'diamond', 'triangle', 'star', 'hexagon', 'cloud'];
const radians = (degrees: number) => (degrees * Math.PI) / 180;

export function summarize(shape: ShapeRecord) {
  const p = shape.props;
  const rawText = String(p.text ?? p.label ?? p.attachment?.name ?? '');
  return {
    id: shape.id,
    kind:
      p.kind === 'vector-path'
        ? 'path'
        : (p.kind ??
          (shape.type === 'geo'
            ? p.geo
            : shape.type === 'draw' || shape.type === 'highlight'
              ? 'stroke'
              : shape.type)),
    x: shape.x,
    y: shape.y,
    z: shape.z,
    rotation: (shape.rot * 180) / Math.PI,
    color: p.ink?.color ?? p.color,
    locked: Boolean(p.locked),
    ...(rawText ? { text: rawText.slice(0, 4096), textTruncated: rawText.length > 4096 } : {}),
    ...(p.w ? { w: p.w, h: p.h } : {}),
    ...(p.vectorPath ? { fill: p.vectorPath.fill, strokeWidth: p.vectorPath.strokeWidth } : {}),
    ...(p.ink
      ? { brush: p.ink.brush, strokeWidth: p.ink.width, points: p.ink.samples.length }
      : {}),
    ...(p.bindings ? { fromId: p.bindings.start?.id, toId: p.bindings.end?.id } : {}),
    ...(p.kind === 'table' ? { rows: p.cells.length, columns: p.cells[0]?.length } : {}),
  };
}

export function assertValid(shape: ShapeRecord) {
  if (shape.props.kind === 'vector-path') {
    const reason = vectorPathError(shape.props.vectorPath);
    if (reason) throw new Error('Invalid path: ' + reason);
  }
  if (!validRecord(shape.id, shape))
    throw new Error(
      'Invalid ' + (shape.props.kind ?? shape.type) + ' geometry, styling or content.',
    );
  return shape;
}
function attach(id: string, lookup: (id: string) => ShapeRecord) {
  const shape = lookup(id);
  if (!['geo', 'text', 'note', 'image'].includes(shape.type))
    throw new Error('Connector endpoints must be nodes.');
  const b = localBounds(shape);
  return { id: shape.id, x: shape.x + b.x + b.w / 2, y: shape.y + b.y + b.h / 2 };
}

function applicable(object: Record<string, unknown>, fields: Set<string>) {
  const invalid = Object.keys(object).filter(
    (field) => object[field] !== undefined && !fields.has(field),
  );
  if (invalid.length)
    throw new Error(
      'Unsupported fields: ' +
        invalid.join(', ') +
        '. Accepted fields: ' +
        [...fields].join(', ') +
        '.',
    );
}

export function createShape(
  a: CreateObject,
  z: number,
  lookup: (id: string) => ShapeRecord,
): ShapeRecord {
  let { x, y } = a;
  const { kind } = a;
  const color = a.color ?? '#243b47';
  const defaults = { color, size: a.size ?? 'm', font: 'sans', dash: 'solid' };
  let type: ShapeRecord['type'] = 'geo';
  let props: ShapeRecord['props'];
  let fields: string[];
  if (geoKinds.includes(kind)) {
    fields = ['w', 'h', 'fill', 'text', 'size'];
    props = {
      ...defaults,
      geo: kind,
      w: a.w ?? 120,
      h: a.h ?? 80,
      label: a.text ?? '',
      fill: a.fill?.startsWith('#') ? 'solid' : (a.fill ?? 'none'),
      ...(a.fill?.startsWith('#') ? { faceColor: a.fill } : {}),
    };
  } else if (kind === 'text' || kind === 'note') {
    fields = ['text', 'size'];
    type = kind;
    props = { ...defaults, text: a.text ?? '', autosize: true, scale: 1 };
  } else if (kind === 'table') {
    fields = ['w', 'h', 'cells'];
    if (!a.cells) throw new Error('Table requires cells.');
    props = {
      ...defaults,
      geo: 'rectangle',
      kind: 'table',
      w: a.w ?? a.cells[0].length * 110,
      h: a.h ?? a.cells.length * 44,
      cells: a.cells,
      fill: 'semi',
    };
  } else if (kind === 'line' || kind === 'arrow') {
    fields = ['size', 'endX', 'endY', 'fromId', 'toId', 'bend'];
    type = kind;
    const from = a.fromId ? attach(a.fromId, lookup) : undefined;
    const to = a.toId ? attach(a.toId, lookup) : undefined;
    if (from) {
      x = from.x;
      y = from.y;
    }
    const endX = to?.x ?? a.endX,
      endY = to?.y ?? a.endY;
    if (endX === undefined || endY === undefined)
      throw new Error('Line/arrow needs toId or both endX and endY.');
    props = {
      ...defaults,
      dx: endX - x,
      dy: endY - y,
      bend: a.bend ?? 0,
      ...(from || to
        ? {
            bindings: {
              ...(from ? { start: { id: from.id, u: 0.5, v: 0.5 } } : {}),
              ...(to ? { end: { id: to.id, u: 0.5, v: 0.5 } } : {}),
            },
          }
        : {}),
    };
  } else if (kind === 'stroke') {
    fields = ['points', 'strokeWidth', 'brush'];
    if (!a.points?.length) throw new Error('Stroke requires local points.');
    const samples: Sample[] = a.points.map(([px, py, p = 0.5, tx = 0, ty = 0, tw = 0, tp = 0]) => [
      px,
      py,
      p,
      tx,
      ty,
      tw,
      tp,
    ]);
    const brush = a.brush ?? 'pen';
    type = brush === 'marker' ? 'highlight' : 'draw';
    props = {
      ...defaults,
      pts: samples.flatMap(([px, py, p]) => [px, py, p]),
      isPen: true,
      done: true,
      ink: { version: 1, brush, color, width: a.strokeWidth ?? 4, samples },
    };
  } else {
    fields = ['d', 'w', 'h', 'fill', 'strokeWidth'];
    if (!a.d || !a.w || !a.h || a.fill === 'semi')
      throw new Error('Path needs d, w, h and a solid color or none for fill.');
    props = {
      ...defaults,
      kind: 'vector-path',
      geo: 'rectangle',
      w: a.w,
      h: a.h,
      fill: 'none',
      vectorPath: {
        d: a.d,
        w: a.w,
        h: a.h,
        fill: a.fill === 'solid' ? color : (a.fill ?? 'none'),
        strokeWidth: a.strokeWidth ?? 3,
      },
    };
  }
  applicable(a, new Set(['kind', 'key', 'x', 'y', 'color', 'rotation', ...fields]));
  return assertValid({
    id: newId(),
    typeName: 'shape',
    type,
    x,
    y,
    z,
    rot: radians(a.rotation ?? 0),
    props,
  });
}

export function updateShape(shape: ShapeRecord, c: Change) {
  const props = { ...shape.props };
  const result = {
    ...shape,
    x: c.x ?? shape.x,
    y: c.y ?? shape.y,
    rot: c.rotation === undefined ? shape.rot : radians(c.rotation),
    props,
  };
  const fields = new Set(['id', 'x', 'y', 'rotation']);
  const isPath = props.kind === 'vector-path';
  const isText = ['text', 'note'].includes(shape.type);
  if (shape.type !== 'image' && !['table', 'attachment', 'link'].includes(props.kind)) {
    fields.add('color');
    if (c.color) {
      props.color = c.color;
      if (props.ink) props.ink = { ...props.ink, color: c.color };
    }
  }
  if (!props.kind && !props.ink && shape.type !== 'image') {
    fields.add('size');
    if (c.size) props.size = c.size;
  }
  if (isText || (shape.type === 'geo' && !props.kind)) {
    fields.add('text');
    if (c.text !== undefined) props[isText ? 'text' : 'label'] = c.text;
  }
  if (shape.type === 'image' || shape.type === 'geo') {
    fields.add('w').add('h');
    if (c.w) props.w = c.w;
    if (c.h) props.h = c.h;
  }
  if (shape.type === 'geo' && !props.kind) {
    fields.add('fill');
    if (c.fill) {
      delete props.faceColor;
      if (c.fill.startsWith('#')) {
        props.fill = 'solid';
        props.faceColor = c.fill;
      } else props.fill = c.fill;
    }
  }
  if (isPath) {
    fields.add('fill').add('strokeWidth');
    if (c.fill === 'semi') throw new Error('Paths accept solid colors or none.');
    props.vectorPath = {
      ...props.vectorPath,
      fill: c.fill === 'solid' ? props.color : (c.fill ?? props.vectorPath.fill),
      strokeWidth: c.strokeWidth ?? props.vectorPath.strokeWidth,
    };
  }
  if (props.ink) {
    fields.add('strokeWidth');
    if (c.strokeWidth !== undefined) props.ink = { ...props.ink, width: c.strokeWidth };
  }
  if (props.kind === 'table') {
    fields.add('cells');
    if (c.cells) props.cells = c.cells;
  }
  if (props.bindings && (c.x !== undefined || c.y !== undefined || c.rotation !== undefined))
    throw new Error('Move the connector endpoints to reposition a bound connector.');
  if (Object.keys(c).length <= 1) throw new Error('Change must include at least one property.');
  applicable(c, fields);
  return assertValid(result);
}

/** Detailed reads are opt-in by ID. Page individual cells/samples to bound provider context. */
export function shapeContent(shape: ShapeRecord, offset: number) {
  const p = shape.props;
  function page(unit: string, total: number, count: number, data: unknown) {
    return {
      unit,
      offset,
      total,
      nextOffset: offset + count < total ? offset + count : null,
      data,
    };
  }
  if (p.kind === 'table') {
    const cells = p.cells as string[][];
    const width = cells[0].length,
      total = cells.length * width;
    const items = Array.from({ length: Math.min(16, Math.max(0, total - offset)) }, (_, i) => {
      const row = Math.floor((offset + i) / width),
        column = (offset + i) % width;
      return { row, column, text: cells[row][column] };
    });
    return page('cells', total, items.length, items);
  }
  if (p.vectorPath) {
    const d = p.vectorPath.d as string;
    return {
      ...page('path characters', d.length, 4096, d.slice(offset, offset + 4096)),
      localWidth: p.vectorPath.w,
      localHeight: p.vectorPath.h,
    };
  }
  if (shape.type === 'draw' || shape.type === 'highlight') {
    const total = Math.floor(p.pts.length / 3);
    const points = Array.from({ length: Math.min(64, Math.max(0, total - offset)) }, (_, i) => {
      const index = offset + i;
      const point = p.pts.slice(index * 3, index * 3 + 3);
      const sample = p.ink?.samples[index];
      return sample ? [...point, ...sample.slice(3)] : point;
    });
    return page('local samples', total, points.length, points);
  }
  if (p.kind === 'link')
    return { url: p.url, description: String(p.description ?? '').slice(0, 2048) };
  if (p.attachment)
    return {
      filename: String(p.attachment.name).slice(0, 512),
      mediaType: String(p.attachment.mime).slice(0, 128),
      description: String(p.description ?? '').slice(0, 2048),
    };
  if (shape.type === 'line' || shape.type === 'arrow')
    return { endX: shape.x + p.dx, endY: shape.y + p.dy, bend: p.bend ?? 0 };
  const text = String(p.text ?? p.label ?? '');
  return page('text characters', text.length, 4096, text.slice(offset, offset + 4096));
}
