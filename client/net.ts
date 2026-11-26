import { forgetBoardAssets } from './asset-cache';
import {
  cacheBoard,
  claimDrafts,
  currentCacheScope,
  forgetBoard,
  type DraftLease,
} from './offline';
import type { BoardRecord, Diff, Store } from '@quickdrawjs/core';
import { appendEdit, rebaseEdits, type Edits } from './merge';
import {
  apply,
  hasPending,
  previewJobs,
  reconcileJob,
  recoverOutbox,
  type Job,
  type Outbox,
} from './recovered-outbox';
import {
  applyDelta,
  getChanges,
  boardPath as path,
  request,
  RequestError,
  type Role,
  type Board,
} from './api';
export * from './api';

type Status = 'saved' | 'saving' | 'offline' | 'conflict';
interface Callbacks {
  onStatus?(status: Status): void;
  onTitle?(title: string): void;
  onRole?(role: Role): void;
  onRevoked?(): void;
  onError?(message: string): void;
}
const uuid = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const empty = (): Edits => Object.create(null);
const has = (edits: Edits) => Object.keys(edits).length > 0;
function toJob(staged: Edits, rev: number): Job {
  const changes = empty();
  let bytes = 0,
    count = 0;
  for (const [id, edit] of Object.entries(staged)) {
    const size = new Blob([JSON.stringify(edit.after)]).size + id.length + 12;
    if (count && (bytes + size > 3_600_000 || count >= 3000)) break;
    changes[id] = edit;
    delete staged[id];
    bytes += size;
    count++;
  }
  return { opId: uuid(), baseRev: rev, changes };
}
function payload(job: Job) {
  const put: Record<string, BoardRecord> = Object.create(null),
    remove: string[] = [];
  for (const [id, { after }] of Object.entries(job.changes)) {
    if (after) put[id] = after;
    else remove.push(id);
  }
  return { opId: job.opId, baseRev: job.baseRev, put, remove };
}

/** One serial writer per open board. SSE notifications trigger authoritative reads. */
export class BoardSync {
  private serverItems: Record<string, BoardRecord>;
  private revision: number;
  private wanted = 0;
  private forceRead = true;
  private box: Outbox = { staged: empty() };
  private readonly writer = uuid();
  private reconcileAll = false;
  private readonly scope = currentCacheScope();
  private readonly cacheKey: string;
  private lease?: DraftLease<Outbox>;
  private readonly ready: Promise<void>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly source: EventSource;
  private readonly off: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private disposed = false;
  private backoff = 400;
  private warned = false;

  constructor(
    private board: Board,
    private store: Store,
    private callbacks: Callbacks = {},
  ) {
    this.revision = board.rev;
    this.serverItems = board.items;
    this.cacheKey = 'folio:pending:3:' + this.scope + ':' + board.id;
    try {
      const saved = sessionStorage.getItem(this.cacheKey);
      if (saved && board.role !== 'viewer') this.box = JSON.parse(saved);
    } catch {
      this.callbacks.onError?.('此浏览器无法恢复临时草稿。');
    }
    const items = hasPending(this.box) ? previewJobs(this.serverItems, this.box) : this.serverItems;
    if (items !== this.serverItems) apply(items, this.box.staged);
    store.loadSnapshot({ document: { store: items } });
    this.ready = this.recoverDrafts();
    this.off = store.listen((diff) => this.changed(diff), { source: 'user' });
    this.source = new EventSource(path(board.id) + '/events');
    this.source.addEventListener('presence', (event) => {
      const { peers } = JSON.parse((event as MessageEvent).data);
      window.dispatchEvent(
        new CustomEvent('folio:presence', { detail: { boardId: board.id, peers } }),
      );
    });
    this.source.addEventListener('change', (event) => {
      const rev = JSON.parse((event as MessageEvent).data).rev;
      if (typeof rev === 'number' && rev > this.revision) {
        this.wanted = Math.max(this.wanted, rev);
        this.schedule(70);
      }
    });
    this.source.onopen = () => {
      this.forceRead = true;
      this.schedule(20);
    };
    this.source.onerror = () => {
      this.callbacks.onStatus?.('offline');
    };
    window.addEventListener('online', this.resume);
    window.addEventListener('pagehide', this.persist);
    this.schedule(10);
  }
  private async recoverDrafts() {
    if (this.board.role === 'viewer' || !this.scope) return;
    await cacheBoard(this.board, this.scope).catch(() => {});
    const leases = await claimDrafts<Outbox>(this.board.id).catch(() => []);
    const [owner, ...other] = leases;
    if (!owner) return;
    if (this.disposed) {
      await Promise.all(leases.map((lane) => lane.release()));
      return;
    }
    this.lease = owner;
    // The synchronous pagehide checkpoint may be newer than the journal's last commit.
    const recovered = [owner, ...other].flatMap((lane) => (lane.value ? [lane.value] : []));
    if (recovered.length || hasPending(this.box)) {
      this.box = recoverOutbox([...recovered, this.box], this.writer, toJob, uuid);
      const merged = previewJobs(this.serverItems, this.box);
      this.store.loadSnapshot({ document: { store: merged } });
      await this.writeDraft();
      try {
        await this.writeChain;
      } catch {
        await Promise.allSettled(other.map((lane) => lane.release()));
        return;
      }
    }
    this.box.writer = this.writer;
    for (const lane of other) {
      await lane.save(null);
      await lane.release();
    }
    this.schedule(0);
  }
  private writeDraft() {
    const lease = this.lease;
    if (!lease || !lease.valid()) return Promise.resolve();
    this.box.savedAt = Date.now();
    // DraftLease captures a stable snapshot synchronously before queuing its write.
    const snapshot = hasPending(this.box) ? this.box : null;
    this.writeChain = lease.save(snapshot);
    return this.writeChain.catch(() => {
      if (!this.warned) this.callbacks.onError?.('浏览器未能写入离线草稿。');
      this.warned = true;
    });
  }
  private cacheSnapshot(delta?: { since: number; ids: Iterable<string> }) {
    return cacheBoard(
      { ...this.board, rev: this.revision, items: this.serverItems },
      this.scope,
      delta,
    ).catch(() => {});
  }
  private changed(diff: Diff) {
    if (!this.checkWorkspace()) return;
    for (const [id, after] of Object.entries(diff.added))
      appendEdit(this.box.staged, id, { before: null, after });
    for (const [id, [before, after]] of Object.entries(diff.updated))
      appendEdit(this.box.staged, id, { before, after });
    for (const [id, before] of Object.entries(diff.removed))
      appendEdit(this.box.staged, id, { before, after: null });
    if (has(this.box.staged)) this.box.stagedKey ??= uuid();
    this.box.savedAt = Date.now();
    this.lease?.checkpoint(this.box);
    if (!this.persistTimer)
      this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined;
        void this.writeDraft();
      }, 65);
    this.callbacks.onStatus?.('saving');
    this.schedule(120);
  }
  private persist = () => {
    if (this.scope !== currentCacheScope()) return;
    this.box.savedAt = Date.now();
    void this.writeDraft();
    try {
      if (hasPending(this.box)) sessionStorage.setItem(this.cacheKey, JSON.stringify(this.box));
      else sessionStorage.removeItem(this.cacheKey);
    } catch {
      if (!this.warned) this.callbacks.onError?.('临时草稿空间不足，保存完成前请保持页面打开。');
      this.warned = true;
    }
  };
  private resume = () => {
    this.forceRead = true;
    this.schedule(0);
  };
  private schedule(delay: number) {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, delay);
  }

  private async refresh(conflict = false) {
    const since = this.revision;
    let latest: Board;
    let changed: Set<string>;
    let incremental = true;
    try {
      const delta = await getChanges(this.board.id, since);
      if (this.disposed) return;
      changed = new Set([...Object.keys(delta.put), ...delta.remove]);
      latest = applyDelta({ ...this.board, items: this.serverItems }, delta);
    } catch (err) {
      if (!(err instanceof RequestError) || err.status !== 409) throw err;
      latest = await request<Board>(path(this.board.id));
      if (this.disposed) return;
      incremental = false;
      changed = new Set([...Object.keys(this.serverItems), ...Object.keys(latest.items)]);
    }
    const metadataChanged =
      latest.title !== this.board.title ||
      latest.role !== this.board.role ||
      latest.updatedAt !== this.board.updatedAt;
    this.callbacks.onTitle?.(latest.title);
    if (latest.role !== this.board.role) {
      this.callbacks.onRole?.(latest.role);
      if (latest.role === 'viewer') {
        this.box = { staged: empty() };
        // Reconcile any local optimistic writes before holding a read-only snapshot.
        for (const recordId of this.store.ids()) changed.add(recordId);
        for (const recordId of Object.keys(latest.items)) changed.add(recordId);
      }
    }
    this.board = latest;
    this.revision = latest.rev;
    this.serverItems = latest.items;
    // Replay every original request unchanged until the server rejects it or confirms its receipt.
    // A rejected job is then rebased independently, before any of the later unconfirmed jobs.
    let conflicts = 0;
    if (conflict && this.box.active) {
      const { result, conflicts: count } = reconcileJob(this.box.active, latest.items);
      conflicts += count;
      this.box.active = has(result) ? toJob(result, latest.rev) : undefined;
      if (has(result)) {
        const extra: Job[] = [];
        while (has(result)) extra.push(toJob(result, latest.rev));
        this.box.replay = [...extra, ...(this.box.replay ?? [])];
      }
    }
    const local = this.box.staged;
    const full = conflict || Boolean(this.box.replay?.length) || this.reconcileAll;
    this.reconcileAll = false;
    // Only an ambiguous/replayed ACK needs comparison of the entire optimistic document.
    // An ordinary peer delta has no active job. Rebase staged edits against just the touched IDs.
    let effective = latest.items;
    let dirtyIds: Set<string>;
    if (full) {
      effective = previewJobs(latest.items, this.box);
      const staged = rebaseEdits(local, effective, uuid);
      this.box.staged = staged.result;
      conflicts += staged.conflicts;
      apply(effective, staged.result);
      dirtyIds = new Set([...this.store.ids(), ...Object.keys(effective)]);
    } else if (has(local)) {
      const staged = rebaseEdits(local, latest.items, uuid);
      this.box.staged = staged.result;
      conflicts += staged.conflicts;
      dirtyIds = new Set([...changed, ...Object.keys(local), ...Object.keys(staged.result)]);
      effective = Object.create(null);
      for (const id of dirtyIds) effective[id] = latest.items[id];
      apply(effective, staged.result);
    } else {
      dirtyIds = changed;
    }
    this.store.transact(() => {
      for (const id of dirtyIds) {
        const record = effective[id];
        if (!record) this.store.remove([id], 'remote');
        else if (
          this.store.get(id) !== record &&
          JSON.stringify(this.store.get(id)) !== JSON.stringify(record)
        )
          this.store.put(record, 'remote');
      }
    }, 'remote');
    if (changed.size) {
      // Undoing a superseded local edit must never roll a peer's subsequent work back.
      const valid = (d: Diff) =>
        ![...Object.keys(d.added), ...Object.keys(d.updated), ...Object.keys(d.removed)].some(
          (id) => changed.has(id),
        );
      this.store.undos = this.store.undos.filter(valid);
      this.store.redos = this.store.redos.filter(valid);
    }
    if (conflicts) {
      this.callbacks.onStatus?.('conflict');
      this.callbacks.onError?.(
        '多人同时修改了同一内容。保留了对方的编辑，可保留的本地形状已另存为副本。',
      );
    }
    if (!incremental || since !== latest.rev || metadataChanged)
      await this.cacheSnapshot(incremental ? { since, ids: changed } : undefined);
    if (full || has(local) || hasPending(this.box)) this.persist();
  }

  private async drain() {
    await this.ready;
    while (!this.disposed) {
      if (this.scope !== currentCacheScope() || (this.lease && !this.lease.valid()))
        throw new Error('Workspace changed');
      if (!this.box.active && (this.forceRead || this.wanted > this.revision)) {
        this.forceRead = false;
        await this.refresh();
        continue;
      }
      if (!this.box.active && this.box.replay?.length) {
        this.box.active = this.box.replay.shift();
        this.persist();
      }
      if (!this.box.active && has(this.box.staged)) {
        this.box.active = toJob(this.box.staged, this.revision);
        this.box.stagedKey = undefined;
        this.persist();
      }
      const job = this.box.active;
      if (!job) break;
      let ack: { rev: number; duplicate: boolean };
      try {
        await this.writeChain.catch(() => {});
        ack = await request(path(this.board.id) + '/ops', 'POST', payload(job));
      } catch (err) {
        if (!(err instanceof RequestError) || err.status !== 409) throw err;
        await this.refresh(true);
        continue;
      }
      if (this.disposed) return;
      if (ack.duplicate || ack.rev !== this.revision + 1) {
        this.forceRead = true;
        this.reconcileAll = true;
      } else {
        apply(this.serverItems, job.changes);
        const since = this.revision;
        this.revision = ack.rev;
        // Keep the replayable job until the acknowledged base is committed locally.
        await this.cacheSnapshot({ since, ids: Object.keys(job.changes) });
      }
      if (this.disposed) return;
      delete this.box.active;
      this.persist();
    }
    this.backoff = 400;
    if (!this.disposed) this.callbacks.onStatus?.('saved');
  }
  private checkWorkspace = (): boolean => {
    if (this.disposed) return false;
    if (this.scope === currentCacheScope() && (!this.lease || this.lease.valid())) return true;
    // A deliberate device switch keeps its dormant, scope-bound journal. The mounted pixels and
    // transport must be cleared immediately, even when this tab has no pending mutation.
    void this.revokeCurrent(false);
    return false;
  };
  private async revokeCurrent(purge: boolean) {
    if (this.disposed) return;
    if (purge) this.box = { staged: empty() };
    this.close();
    this.store.loadSnapshot({ document: { store: {} } });
    this.callbacks.onRevoked?.();
    if (purge)
      await Promise.allSettled([
        forgetBoard(this.board.id, this.scope),
        forgetBoardAssets(this.board.id, this.scope),
      ]);
  }

  async flush() {
    if (this.disposed) return;
    if (this.flight) return this.flight;
    this.flight = this.drain()
      .catch(async (err: unknown) => {
        if (this.disposed) return;
        if (err instanceof RequestError && (err.status === 403 || err.status === 404)) {
          try {
            const canonical = await request<Board>(path(this.board.id));
            if (!this.checkWorkspace()) return;
            if (canonical.role === 'viewer') {
              this.box = { staged: empty() };
              this.store.loadSnapshot({ document: { store: canonical.items } });
              this.serverItems = canonical.items;
              this.board = canonical;
              this.revision = canonical.rev;
              this.callbacks.onRole?.('viewer');
              this.persist();
              await this.cacheSnapshot();
              this.callbacks.onStatus?.('saved');
              return;
            }
          } catch (check) {
            if (check instanceof RequestError && (check.status === 404 || check.status === 403)) {
              this.box = { staged: empty() };
              this.close();
              await Promise.all([
                forgetBoard(this.board.id, this.scope),
                forgetBoardAssets(this.board.id, this.scope).catch(() => {}),
              ]);
              this.store.loadSnapshot({ document: { store: {} } });
              this.callbacks.onRevoked?.();
              return;
            }
          }
        }
        this.persist();
        this.callbacks.onStatus?.('offline');
        if (err instanceof RequestError && err.status >= 400 && err.status < 500) {
          this.callbacks.onError?.('保存失败：' + err.code);
        } else {
          this.schedule(this.backoff);
          this.backoff = Math.min(this.backoff * 2, 15000);
        }
        throw err;
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.persistTimer);
    this.persist();
    void this.writeChain.finally(() => this.lease?.release()).catch(() => {});
    this.source.close();
    this.off();
    window.removeEventListener('online', this.resume);
    window.removeEventListener('pagehide', this.persist);
  }
}
