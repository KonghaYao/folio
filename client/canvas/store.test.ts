import { expect, test } from 'bun:test';
import type { BoardRecord, ShapeRecord } from '@quickdrawjs/core';
import { BoardStore } from './store';
import { cloneSelection } from './clone';

function shape(id: string): ShapeRecord {
  return {
    id,
    type: 'geo',
    typeName: 'shape',
    x: 0,
    y: 0,
    rot: 0,
    z: 1,
    props: { geo: 'rectangle', size: 's', w: 100, h: 50, color: 'green', groupId: 'group:a' },
  };
}
test('bound connectors follow a rotated and moved rectangle, then undo in one action', () => {
  const store = new BoardStore(),
    node = shape('shape:a');
  const edge = {
    ...shape('shape:edge'),
    type: 'arrow' as const,
    x: 100,
    y: 25,
    props: { dx: 200, dy: 0, bindings: { start: { id: node.id, u: 1, v: 0.5 } } },
  };
  store.put(node);
  store.put(edge);
  store.update(node.id, { x: 20, rot: Math.PI / 2 });
  const result = store.get(edge.id) as ShapeRecord;
  expect(result.x).toBeCloseTo(70);
  expect(result.y).toBeCloseTo(75);
  expect(result.x + result.props.dx).toBeCloseTo(300);
  store.undo();
  expect(store.get(edge.id)).toEqual(edge);
});

test('copying a group remaps its connector endpoints and never selects the original group', () => {
  const store = new BoardStore(),
    a = shape('shape:a'),
    b = { ...shape('shape:b'), x: 200 };
  const line = {
    ...shape('shape:l'),
    type: 'arrow' as const,
    props: {
      groupId: 'group:a',
      dx: 200,
      dy: 0,
      bindings: { start: { id: a.id, u: 0.5, v: 0.5 }, end: { id: b.id, u: 0.5, v: 0.5 } },
    },
  };
  [a, b, line].forEach((s) => store.put(s));
  const ids = cloneSelection(store, { shapes: [a, b, line] }, 16);
  const [ca, cb, cl] = ids.map((id) => store.get(id) as ShapeRecord);
  expect(ca.props.groupId).toEqual(cb.props.groupId);
  expect(ca.props.groupId).not.toEqual(a.props.groupId);
  expect(cl.props.bindings.start.id).toEqual(ca.id);
  expect(cl.props.bindings.end.id).toEqual(cb.id);
});
test('scene metadata stays out of spatial queries, locks allow unlock and remote changes', () => {
  const store = new BoardStore(),
    s = shape('s');
  store.put({ id: 'scene:a', typeName: 'scene' } as unknown as BoardRecord);
  store.put({ ...s, props: { ...s.props, locked: true } });
  store.update(s.id, { x: 1 });
  store.remove([s.id]);
  expect(store.shapes()).toHaveLength(1);
  expect(store.shapes()[0].x).toBe(0);
  store.update(s.id, { x: 2 }, 'remote');
  expect(store.shapes()[0].x).toBe(2);
  store.update(s.id, { props: { locked: false } });
  store.remove([s.id]);
  expect(store.shapes()).toHaveLength(0);
  expect(store.has('scene:a')).toBe(true);
});
