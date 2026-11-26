import { pageBounds, type Bounds, type ShapeRecord } from '@quickdrawjs/core';
import quickselect from 'quickselect';
import type { BoardStore } from '../canvas/store';

const stackingOrder = (a: ShapeRecord, b: ShapeRecord) => a.z - b.z || a.id.localeCompare(b.id);

function intersects(a: Bounds, b: Bounds) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

function matches(shape: ShapeRecord, needle: string) {
  if (!needle) return true;
  const props = shape.props;
  const contains = (value: unknown) =>
    typeof value === 'string' && value.toLowerCase().includes(needle);
  return (
    contains(shape.id) ||
    contains(shape.type) ||
    contains(props.kind) ||
    contains(props.geo) ||
    contains(props.text) ||
    contains(props.label) ||
    contains(props.attachment?.name) ||
    (props.kind === 'table' && props.cells.some((row: string[]) => row.some(contains)))
  );
}

export function selectionSummary(selection: Set<string>) {
  const selectedIds: string[] = [];
  for (const id of selection) {
    if (selectedIds.length === 96) break;
    selectedIds.push(id);
  }
  return { selectedIds, selectedCount: selection.size };
}

interface PageSet {
  generation: number;
  needle: string;
  viewport?: Bounds;
  matched: number;
  start: number;
  ids: string[];
}

/** Select the requested interval in linear time, then sort just the page the model will see. */
function firstPage(rows: ShapeRecord[], start: number, end: number) {
  if (start >= rows.length) return [];
  if (start > 0) quickselect(rows, start, 0, rows.length - 1, stackingOrder);
  if (end < rows.length) quickselect(rows, end - 1, start, rows.length - 1, stackingOrder);
  return rows.slice(start, end).sort(stackingOrder);
}

/** The viewport is part of a visible page's identity even when the board itself has not changed. */
function sameViewport(a: Bounds | undefined, b: Bounds | undefined) {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
}

/** A single ordered result is retained per turn. Its IDs resolve to live records at read time. */
export function createShapeQuery(store: BoardStore) {
  let lastPageSet: PageSet | undefined;

  function readBoardPage(
    needle: string,
    viewport: Bounds | undefined,
    offset: number,
    limit: number,
  ) {
    if (!needle && !viewport && offset >= store.shapeCount)
      return { matched: store.shapeCount, page: [] };
    const generation = needle || viewport ? store.generation : store.orderGeneration;
    const cached =
      lastPageSet?.generation === generation &&
      lastPageSet.needle === needle &&
      sameViewport(lastPageSet.viewport, viewport)
        ? lastPageSet
        : undefined;
    const end = offset + limit;
    if (cached && offset >= cached.matched) return { matched: cached.matched, page: [] };
    if (
      cached &&
      offset >= cached.start &&
      Math.min(end, cached.matched) <= cached.start + cached.ids.length
    ) {
      const start = offset - cached.start;
      const page = cached.ids.slice(start, start + limit).map((id) => store.get(id) as ShapeRecord);
      return { matched: cached.matched, page };
    }

    const source = viewport ? store.shapesInBounds(viewport) : store.shapes();
    const rows =
      viewport || needle
        ? source.filter(
            (shape) =>
              (!viewport || intersects(viewport, pageBounds(shape))) && matches(shape, needle),
          )
        : source;
    // A first request for a large query retains only the IDs returned. A second disjoint
    // page materializes the order once for subsequent cursors.
    const partial = !cached && rows.length > 1024;
    const ordered = partial
      ? firstPage(rows, offset, Math.min(end, rows.length))
      : rows.sort(stackingOrder);
    lastPageSet = {
      generation,
      needle,
      viewport,
      matched: rows.length,
      start: partial ? offset : 0,
      ids: ordered.map((shape) => shape.id),
    };
    return { matched: rows.length, page: partial ? ordered : ordered.slice(offset, end) };
  }

  return (
    scope: 'all' | 'visible' | 'selection',
    ids: string[] | undefined,
    query: string,
    selection: Set<string>,
    rect: Bounds,
    offset: number,
    limit: number,
  ) => {
    const needle = query.toLowerCase();
    if (!ids && scope !== 'selection')
      return readBoardPage(needle, scope === 'visible' ? rect : undefined, offset, limit);

    // Direct ID lookup preserves the same filter intersection and ordering as a board scan.
    const rows: ShapeRecord[] = [];
    for (const id of ids ? new Set(ids) : selection) {
      if (scope === 'selection' && !selection.has(id)) continue;
      const shape = store.get(id);
      if (shape?.typeName !== 'shape' || !matches(shape, needle)) continue;
      if (scope === 'visible' && !intersects(rect, pageBounds(shape))) continue;
      rows.push(shape);
    }
    const page =
      rows.length > 1024
        ? firstPage(rows, offset, Math.min(offset + limit, rows.length))
        : rows.sort(stackingOrder).slice(offset, offset + limit);
    return { matched: rows.length, page };
  };
}
