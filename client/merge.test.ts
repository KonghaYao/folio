import { expect, test } from 'bun:test';
import type { ShapeRecord } from '@quickdrawjs/core';
import { appendEdit, rebaseEdits, type Edits } from './merge';
const base: ShapeRecord = {
  id: 's1',
  typeName: 'shape',
  type: 'note',
  x: 0,
  y: 1,
  z: 1,
  rot: 0,
  props: { text: 'a', color: 'black' },
};
test('a move merges with a peer text edit without overwriting it', () => {
  const peer = { ...base, props: { ...base.props, text: 'b' } };
  const { result, conflicts } = rebaseEdits(
    { s1: { before: base, after: { ...base, x: 2 } } },
    { s1: peer },
    () => 'copy',
  );
  expect(conflicts).toBe(0);
  expect(result.s1.after).toEqual({ ...peer, x: 2 });
});
test('divergent text edits retain a separate shape and leave peer record intact', () => {
  const mine = { ...base, props: { text: 'c' } };
  const { result, conflicts } = rebaseEdits(
    { s1: { before: base, after: mine } },
    { s1: { ...base, props: { text: 'b' } } },
    () => 'copy',
  );
  expect(conflicts).toBe(1);
  expect(result.s1).toBeUndefined();
  expect((result['shape:copy'].after as ShapeRecord).props.text).toBe('c');
});
test('combine local add, edit and delete before first acknowledgement', () => {
  const edits: Edits = {};
  appendEdit(edits, 's1', { before: null, after: base });
  appendEdit(edits, 's1', { before: base, after: { ...base, x: 10 } });
  expect(edits.s1.before).toBeNull();
  appendEdit(edits, 's1', { before: { ...base, x: 10 }, after: null });
  expect(edits).toEqual({});
});
