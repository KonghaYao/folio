import { expect, test } from 'bun:test';
import type { Bounds, ShapeRecord } from '@quickdrawjs/core';
import { BoardStore } from './store';
import { paintOrder, shapeBounds } from './spatial';

function geo(id: string, x: number, y: number, z: number): ShapeRecord {
  return {
    id,
    typeName: 'shape',
    type: 'geo',
    x,
    y,
    z,
    rot: 0,
    props: {
      geo: 'rectangle',
      color: 'black',
      size: 'm',
      w: 35,
      h: 25,
      fill: 'solid',
      dash: 'solid',
    },
  };
}
const overlaps = (a: Bounds, b: Bounds) =>
  a.x <= b.x + b.w && a.y <= b.y + b.h && a.x + a.w >= b.x && a.y + a.h >= b.y;

test('spatial queries agree with exhaustive intersection after remote loads, changes, deletion, history and snapshot replacement', () => {
  const store = new BoardStore();
  const initial: Record<string, ShapeRecord> = {};
  for (let i = 0; i < 1200; i++) {
    const s = geo('s' + i, ((i * 73) % 4100) - 400, ((i * 57) % 2200) - 200, i % 7);
    s.rot = (i % 4) * 0.42;
    initial[s.id] = s;
  }
  store.loadSnapshot({ document: { store: initial } });
  const verify = () => {
    expect(store.shapeCount).toBe(store.shapes().length);
    for (let n = 0; n < 12; n++) {
      const rect = { x: n * 62 - 100, y: n * 48 - 100, w: 361, h: 292 };
      const expected = store
        .shapes()
        .filter((s) => overlaps(shapeBounds(s), rect))
        .map((s) => s.id)
        .sort();
      expect(
        store
          .shapesInBounds(rect)
          .map((s) => s.id)
          .sort(),
      ).toEqual(expected);
    }
  };
  verify();
  const order = store.orderGeneration;
  store.transact(() => {
    for (let i = 0; i < 100; i++) store.update('s' + i, { x: i * 2, y: 20 });
  });
  expect(store.orderGeneration).toBe(order);
  verify();
  store.remove(['s0', 's0', 's1', 's2']);
  verify();
  store.undo();
  verify();
  store.undo();
  verify();
  store.loadSnapshot({ document: { store: { only: geo('only', -25, -25, -9) } } });
  verify();
  expect(store.maxZ()).toBe(0);
  expect(store.minZ()).toBe(-9);
});

test('reflowed arrows and intra-transaction moves use fresh bounds; highlights remain below ink', () => {
  const store = new BoardStore();
  const a = geo('a', 20, 10, 1),
    b = geo('b', 110, 10, 3);
  const line: ShapeRecord = {
    ...geo('line', 50, 20, 4),
    type: 'arrow',
    props: {
      dx: 90,
      dy: 0,
      size: 'm',
      bindings: { start: { id: 'a', u: 0.5, v: 0.5 }, end: { id: 'b', u: 0.5, v: 0.5 } },
    },
  };
  store.transact(() => [a, b, line].forEach((s) => store.put(s)));
  expect(store.shapesInBounds({ x: 800, y: 15, w: 5, h: 20 })).toHaveLength(0);
  store.transact(() => {
    store.update('a', { x: 810 });
    expect(
      store
        .shapesInBounds({ x: 817, y: 20, w: 2, h: 2 })
        .map((s) => s.id)
        .sort(),
    ).toEqual(['a', 'line']);
  });
  store.undo();
  expect(store.shapesInBounds({ x: 817, y: 20, w: 2, h: 2 })).toHaveLength(0);
  const highlight: ShapeRecord = {
    ...geo('h', 0, 0, 200),
    type: 'highlight',
    props: { pts: [0, 0, 0.4, 1, 1, 0.6], size: 's' },
  };
  expect([b, highlight, a].sort(paintOrder).map((s) => s.id)).toEqual(['h', 'a', 'b']);
});

test('equal-z anchors keep insertion order and distant curved path geometry remains queryable after resizing', () => {
  const store = new BoardStore();
  store.put(geo('z-first', 0, 0, 20));
  store.put(geo('a-second', 0, 0, 20));
  expect(store.anchorAt({ x: 20, y: 10 }, 0)?.id).toBe('z-first');
  const path = geo('curve', 100, 0, 30);
  path.props = {
    ...path.props,
    kind: 'vector-path',
    w: 80,
    h: 10,
    vectorPath: { w: 40, h: 10, strokeWidth: 2, fill: 'none', d: 'M 0 5 q 20 -65 40 0 t 40 0' },
  };
  store.put(path);
  expect(store.drawingBounds()).toEqual({ x: -2, y: -2, w: 184, h: 29 });
  expect(store.shapesInBounds({ x: 169, y: -26, w: 4, h: 2 }).map((s) => s.id)).toContain('curve');
  expect(store.shapesInBounds({ x: 215, y: 35, w: 5, h: 2 }).map((s) => s.id)).toContain('curve');
});
