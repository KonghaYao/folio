import type { BoardRecord } from '@quickdrawjs/core';

export type Edit = { before: BoardRecord | null; after: BoardRecord | null };
export type Edits = Record<string, Edit>;

export function appendEdit(edits: Edits, id: string, edit: Edit) {
  const before = edits[id]?.before === undefined ? edit.before : edits[id].before;
  if (before === edit.after || (before === null && edit.after === null)) delete edits[id];
  else edits[id] = { before, after: edit.after };
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const collision = Symbol('concurrent edits');

// Arrays (ink samples, cell matrices) are atomic. Plain records merge at field level.
function mergeField(base: unknown, mine: unknown, peer: unknown): unknown {
  if (same(mine, peer) || same(peer, base)) return mine;
  if (same(mine, base)) return peer;
  if (!object(base) || !object(mine) || !object(peer)) return collision;
  const merged: Record<string, unknown> = Object.create(null);
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(peer)])) {
    const value = mergeField(base[key], mine[key], peer[key]);
    if (value === collision) return collision;
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** Preserve both authors when they change the same field of a shape. */
export function rebaseEdits(
  edits: Edits,
  current: Record<string, BoardRecord>,
  uuid: () => string,
) {
  const result: Edits = Object.create(null);
  let conflicts = 0;
  for (const [id, { before, after }] of Object.entries(edits)) {
    const peer = current[id] ?? null;
    const merged = mergeField(before, after, peer);
    if (merged !== collision) {
      if (!same(merged, peer)) result[id] = { before: peer, after: merged as BoardRecord | null };
      continue;
    }
    conflicts++;
    // A deletion racing another author's edit leaves that author's version intact.
    if (after?.typeName === 'shape') {
      const copyId = 'shape:' + uuid();
      result[copyId] = {
        before: null,
        after: {
          ...after,
          id: copyId,
          x: after.x + 16,
          y: after.y + 16,
          props: { ...after.props, conflictOf: id },
        },
      };
    } else if (after && !peer) result[id] = { before: null, after };
  }
  return { result, conflicts };
}
