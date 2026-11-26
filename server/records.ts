/** Validation shared with the portable-board importer. This module has no runtime-specific imports. */
import { validVectorPath } from '../shared/vector-path';

const shapeTypes = ['draw', 'highlight', 'geo', 'arrow', 'line', 'text', 'note', 'image'];
const colors = [
  'black',
  'grey',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'yellow',
  'orange',
  'green',
  'light-green',
  'light-red',
  'red',
];
const assetPath = /^\/api\/boards\/[\w-]+\/assets\/[\w-]+$/;
const inlineImage = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const between = (v: unknown, min: number, max: number) => finite(v) && v >= min && v <= max;
const inList = (v: unknown, list: string[]) => typeof v === 'string' && list.includes(v);

function validInk(ink: unknown): boolean {
  if (
    !object(ink) ||
    ink.version !== 1 ||
    !inList(ink.brush, ['pen', 'pencil', 'marker']) ||
    !positive(ink.width) ||
    ink.width > 128 ||
    typeof ink.color !== 'string' ||
    !/^#[\da-f]{6}$/i.test(ink.color) ||
    !Array.isArray(ink.samples) ||
    !ink.samples.length
  )
    return false;
  return ink.samples.every(
    (sample) =>
      Array.isArray(sample) &&
      sample.length === 7 &&
      finite(sample[0]) &&
      finite(sample[1]) &&
      between(sample[2], 0, 1) &&
      between(sample[3], -90, 90) &&
      between(sample[4], -90, 90) &&
      between(sample[5], 0, 359) &&
      between(sample[6], -1, 1),
  );
}

function validProps(type: string, p: Record<string, unknown>): boolean {
  if (p.color !== undefined && !(inList(p.color, colors) || /^#[\da-f]{6}$/i.test(String(p.color))))
    return false;
  if (p.size !== undefined && !inList(p.size, ['s', 'm', 'l', 'xl'])) return false;
  if (p.font !== undefined && !inList(p.font, ['draw', 'sans', 'serif', 'mono'])) return false;
  if (p.label !== undefined && typeof p.label !== 'string') return false;
  if (p.kind === 'vector-path' && (type !== 'geo' || !validVectorPath(p.vectorPath))) return false;
  if (
    p.faceColor !== undefined &&
    (typeof p.faceColor !== 'string' || !/^#[\da-f]{6}$/i.test(p.faceColor))
  )
    return false;
  if (p.kind === 'table') {
    const cells = p.cells;
    if (!Array.isArray(cells) || !cells.length || cells.length > 24 || !Array.isArray(cells[0]))
      return false;
    const width = cells[0].length;
    if (
      !width ||
      width > 12 ||
      !cells.every(
        (row) =>
          Array.isArray(row) &&
          row.length === width &&
          row.every((cell) => typeof cell === 'string' && cell.length <= 1024),
      )
    )
      return false;
  }
  if (
    (p.description !== undefined && typeof p.description !== 'string') ||
    (p.groupId != null && typeof p.groupId !== 'string') ||
    (p.locked !== undefined && typeof p.locked !== 'boolean')
  )
    return false;
  if (p.kind === 'link') {
    if (typeof p.url !== 'string') return false;
    try {
      if (!['http:', 'https:'].includes(new URL(p.url).protocol)) return false;
    } catch {
      return false;
    }
  }
  const stroke = type === 'draw' || type === 'highlight';
  if (p.ink !== undefined && (!stroke || !validInk(p.ink))) return false;
  if (
    p.erasures !== undefined &&
    (!stroke ||
      !Array.isArray(p.erasures) ||
      !p.erasures.every(
        (mask) =>
          object(mask) &&
          object(mask.base) &&
          positive(mask.base.w) &&
          positive(mask.base.h) &&
          positive(mask.radius) &&
          mask.radius <= 80 &&
          Array.isArray(mask.points) &&
          mask.points.length >= 2 &&
          mask.points.length % 2 === 0 &&
          mask.points.every(finite),
      ))
  )
    return false;
  if (
    p.attachment !== undefined &&
    (!object(p.attachment) ||
      typeof p.attachment.name !== 'string' ||
      typeof p.attachment.mime !== 'string' ||
      typeof p.attachment.url !== 'string' ||
      !assetPath.test(p.attachment.url))
  )
    return false;
  switch (type) {
    case 'draw':
    case 'highlight':
      return (
        Array.isArray(p.pts) &&
        p.pts.length >= 3 &&
        p.pts.length % 3 === 0 &&
        p.pts.every((n, i) => (i % 3 === 2 ? between(n, 0, 1) : finite(n)))
      );
    case 'arrow':
    case 'line':
      return finite(p.dx) && finite(p.dy) && (p.bend === undefined || finite(p.bend));
    case 'geo':
      if (p.kind === 'table') {
        if (
          !Array.isArray(p.cells) ||
          p.cells.length < 1 ||
          p.cells.length > 24 ||
          !Array.isArray(p.cells[0])
        )
          return false;
        const width = p.cells[0].length;
        if (
          width < 1 ||
          width > 12 ||
          !p.cells.every(
            (row) =>
              Array.isArray(row) &&
              row.length === width &&
              row.every((cell) => typeof cell === 'string' && cell.length <= 1024),
          )
        )
          return false;
      }
      return positive(p.w) && positive(p.h);
    case 'image':
      if (p.crop !== undefined) {
        const c = p.crop;
        if (
          !object(c) ||
          typeof c.ellipse !== 'boolean' ||
          ![c.left, c.right, c.top, c.bottom].every((n) => between(n, 0, 100)) ||
          !(Number(c.left) < Number(c.right) && Number(c.top) < Number(c.bottom))
        )
          return false;
      }
      return positive(p.w) && positive(p.h) && typeof p.assetId === 'string';
    case 'text':
    case 'note':
      return typeof p.text === 'string';
    default:
      return false;
  }
}

export function validRecord(key: string, value: unknown): boolean {
  if (
    !object(value) ||
    value.id !== key ||
    !/^[\w.:~-]{1,160}$/.test(key) ||
    ['__proto__', 'constructor', 'prototype'].includes(key)
  )
    return false;
  switch (value.typeName) {
    case 'shape':
      return (
        inList(value.type, shapeTypes) &&
        [value.x, value.y, value.z, value.rot].every(finite) &&
        object(value.props) &&
        validProps(String(value.type), value.props)
      );
    case 'asset':
      return (
        positive(value.w) &&
        positive(value.h) &&
        typeof value.src === 'string' &&
        (assetPath.test(value.src) || inlineImage.test(value.src))
      );
    case 'scene':
      return (
        typeof value.title === 'string' &&
        finite(value.order) &&
        object(value.bounds) &&
        finite(value.bounds.x) &&
        finite(value.bounds.y) &&
        positive(value.bounds.w) &&
        positive(value.bounds.h)
      );
    default:
      return false;
  }
}
