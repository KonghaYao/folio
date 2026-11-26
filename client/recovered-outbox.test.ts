import { expect, test } from 'bun:test';
import type { ShapeRecord } from '@quickdrawjs/core';
import {
  previewJobs,
  reconcileJob,
  recoverOutbox,
  type Job,
  type Outbox,
} from './recovered-outbox';
import type { Edits } from './merge';

const base: ShapeRecord = {
  id: 'shape:note',
  typeName: 'shape',
  type: 'note',
  x: 0,
  y: 0,
  rot: 0,
  z: 1,
  props: { text: 'base' },
};
const edits = (value: string): Edits => ({
  [base.id]: { before: base, after: { ...base, props: { text: value } } },
});
const job = (opId: string, value: string): Job => ({ opId, baseRev: 4, changes: edits(value) });
function split(remaining: Edits, baseRev: number) {
  const changes = { ...remaining };
  for (const key of Object.keys(remaining)) delete remaining[key];
  return { opId: 'unused', baseRev, changes };
}

test('recover each ambiguous operation with its exact ID and body, retaining divergent authors', () => {
  const a = job('a', 'first'),
    b = job('b', 'second');
  const snapshot = recoverOutbox(
    [
      { active: a, staged: {}, writer: 'a', savedAt: 1 },
      { active: b, staged: {}, writer: 'b', savedAt: 2 },
    ],
    'new',
    split,
    () => 'uuid',
  );
  expect(snapshot.active).toBe(a);
  expect(snapshot.replay).toEqual([b]);
  const preview = previewJobs({ [base.id]: base }, snapshot);
  expect(
    Object.values(preview)
      .map((r) => (r as ShapeRecord).props.text)
      .sort(),
  ).toEqual(['first', 'second']);
  const responseToConflict = reconcileJob(b, { [base.id]: a.changes[base.id]!.after! });
  expect(responseToConflict.conflicts).toBe(1);
  expect(Object.keys(responseToConflict.result)).toEqual(
    Object.keys(preview).filter((id) => id !== base.id),
  );
  expect(previewJobs({ [base.id]: a.changes[base.id]!.after! }, snapshot)).toEqual(preview);
});

test('the newest checkpoint per writer supersedes earlier stages and repeated recovery is idempotent', () => {
  const newest: Outbox = { writer: 'tab', savedAt: 2, stagedKey: 'batch', staged: edits('newest') };
  const snapshot = recoverOutbox(
    [{ ...newest, savedAt: 1, staged: edits('stale') }, newest],
    'first-recovery',
    split,
    () => 'uuid',
  );
  expect(snapshot.active?.opId).toBe('stage:batch:0');
  const recovered = recoverOutbox([snapshot, newest], 'second-recovery', split, () => 'uuid');
  expect(recovered.replay).toEqual([]);
  expect((recovered.active?.changes[base.id]?.after as ShapeRecord).props.text).toBe('newest');
});
