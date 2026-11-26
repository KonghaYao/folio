import type { BoardRecord } from '@quickdrawjs/core';
import { rebaseEdits, type Edits } from './merge';

export interface Job {
  opId: string;
  baseRev: number;
  changes: Edits;
}
export interface Outbox {
  active?: Job;
  replay?: Job[];
  staged: Edits;
  stagedKey?: string;
  writer?: string;
  savedAt?: number;
}
export type Records = Record<string, BoardRecord>;

export function apply(items: Records, edits: Edits): void {
  for (const [id, { after }] of Object.entries(edits)) {
    if (after) items[id] = after;
    else delete items[id];
  }
}
export function hasPending(box: Outbox): boolean {
  return Boolean(box.active || box.replay?.length || Object.keys(box.staged).length);
}

/** The browser checkpoint and IndexedDB can hold different snapshots of the same writer. */
export function recoverOutbox(
  snapshots: Outbox[],
  currentWriter: string,
  split: (edits: Edits, rev: number) => Job,
  uuid: () => string,
): Outbox {
  const lanes = new Map<string, Outbox>();
  for (const [i, box] of snapshots.entries()) {
    if (!hasPending(box) && !box.writer) continue;
    const id = box.writer ?? 'legacy:' + (box.active?.opId ?? i);
    const previous = lanes.get(id);
    if (!previous || (previous.savedAt ?? 0) <= (box.savedAt ?? 0)) lanes.set(id, box);
  }
  const replay: Job[] = [];
  const seen = new Set<string>();
  const legacyStaged = new Set<string>();
  function append(job: Job) {
    if (seen.has(job.opId)) return;
    seen.add(job.opId);
    replay.push(job);
  }
  const ordered = [...lanes.values()].sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0));
  for (const lane of ordered) {
    if (lane.active) append(lane.active);
    for (const job of lane.replay ?? []) append(job);
    if (!Object.keys(lane.staged).length) continue;
    let stageKey = lane.stagedKey;
    if (!stageKey) {
      const key = JSON.stringify(lane.staged);
      if (legacyStaged.has(key)) continue;
      legacyStaged.add(key);
      stageKey = uuid();
    }
    // Unsent stages retain before-images, but may have been recorded against different revisions.
    // A conservative base forces the server to check touched records before accepting them.
    const remaining = { ...lane.staged };
    for (let index = 0; Object.keys(remaining).length; index++) {
      const job = split(remaining, 0);
      append({ ...job, opId: 'stage:' + stageKey + ':' + index });
    }
  }
  return { writer: currentWriter, active: replay.shift(), replay, staged: Object.create(null) };
}

/** An offline preview and a later HTTP conflict use the same copy ID for the same change. */
export function reconcileJob(job: Job, items: Records) {
  const result: Edits = Object.create(null);
  let conflicts = 0;
  let ordinal = 0;
  for (const [id, edit] of Object.entries(job.changes)) {
    const copy = 'recovered:' + job.opId + ':' + ordinal++;
    const rebased = rebaseEdits({ [id]: edit }, items, () => copy);
    Object.assign(result, rebased.result);
    conflicts += rebased.conflicts;
  }
  return { result, conflicts };
}

export function previewJobs(items: Records, box: Outbox): Records {
  const effective = { ...items };
  const jobs = [...(box.active ? [box.active] : []), ...(box.replay ?? [])];
  for (const job of jobs) apply(effective, reconcileJob(job, effective).result);
  return effective;
}
