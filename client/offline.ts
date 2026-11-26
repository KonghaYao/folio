import type { Board, BoardSummary } from './net';
import type { LibraryState } from '../server/library-store';

export interface DraftLease<T> {
  value?: T;
  durable: boolean;
  valid(): boolean;
  save(value: T | null): Promise<void>;
  checkpoint(value: T | null): void;
  release(): Promise<void>;
}
type DraftRow<T> = {
  scope: string;
  board: string;
  lane: string;
  value: T | null;
  created: number;
  sequence?: number;
};
const dbName = 'folio.offline.v1';
let connection: Promise<IDBDatabase> | undefined;
let epoch = 0;

export function currentCacheScope(): string | null {
  return document.cookie.match(/(?:^|;\s*)folio_cache=([a-f\d]{64})(?:;|$)/)?.[1] ?? null;
}

function db(): Promise<IDBDatabase> {
  if (!connection)
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        if (event.oldVersion === 0) {
          database.createObjectStore('boards', { keyPath: ['scope', 'id'] });
          database.createObjectStore('lists', { keyPath: 'scope' });
          database
            .createObjectStore('drafts', { keyPath: ['scope', 'board', 'lane'] })
            .createIndex('board', ['scope', 'board']);
        }
        database.createObjectStore('boardHeaders', { keyPath: ['scope', 'id'] });
        database.createObjectStore('boardChanges', { keyPath: ['scope', 'board', 'id'] });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          connection = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('offline database upgrade blocked'));
    }).catch((error) => {
      connection = undefined;
      throw error;
    });
  return connection;
}

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function committed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('offline transaction aborted'));
  });
}
async function transaction(stores: string[], mode: IDBTransactionMode, scope: string | null) {
  if (!scope || scope !== currentCacheScope()) return;
  const database = await db();
  if (scope !== currentCacheScope()) return;
  return database.transaction(stores, mode, { durability: 'strict' });
}

const boardStores = ['boards', 'boardHeaders', 'boardChanges'];
const boardRange = (scope: string, id: string) => IDBKeyRange.bound([scope, id], [scope, id, []]);

export async function cachedBoardHeader(
  id: string,
  scope = currentCacheScope(),
): Promise<BoardSummary | undefined> {
  const tx = await transaction(['boardHeaders'], 'readonly', scope);
  if (!tx || !scope) return;
  const row = await read(tx.objectStore('boardHeaders').get([scope, id]));
  if (scope === currentCacheScope()) return row?.value;
}

/** A single transaction reads a consistent base, overlay and revision, including v1 snapshots. */
export async function cachedBoard(
  id: string,
  scope = currentCacheScope(),
): Promise<Board | undefined> {
  const tx = await transaction(boardStores, 'readonly', scope);
  if (!tx || !scope) return;
  const [base, header, changes] = await Promise.all([
    read(tx.objectStore('boards').get([scope, id])),
    read(tx.objectStore('boardHeaders').get([scope, id])),
    read(tx.objectStore('boardChanges').getAll(boardRange(scope, id))),
  ]);
  if (scope !== currentCacheScope() || !base) return;
  const board: Board =
    base.snapshot instanceof Blob ? JSON.parse(await base.snapshot.text()) : base.value;
  if (scope !== currentCacheScope()) return;
  for (const { id, value } of changes) {
    if (value == null) delete board.items[id];
    else board.items[id] = value;
  }
  return Object.assign(board, header?.value);
}

/** Keep the existing full snapshot immutable and store only the latest value of each touched ID.
 * An overlapping delta is safe to replay. A gap requires a new base and atomically clears the overlay.
 */
export async function cacheBoard(
  board: Board,
  scope = currentCacheScope(),
  source?: Blob | { since: number; ids: Iterable<string> },
): Promise<void> {
  const tx = await transaction(boardStores, 'readwrite', scope);
  if (!tx || !scope) return;
  const done = committed(tx);
  const base = tx.objectStore('boards'),
    headers = tx.objectStore('boardHeaders'),
    changes = tx.objectStore('boardChanges');
  const delta = source instanceof Blob ? undefined : source;
  const { id, title, rev, updatedAt, role } = board;
  const key = [scope, id];
  const header = await read(headers.get(key));
  // A version-one base may have a newer revision than the tab performing the upgrade.
  const prior: BoardSummary | undefined = header?.value ?? (await read(base.get(key)))?.value;
  if (!prior || prior.rev <= rev) {
    if (prior?.rev !== rev) {
      if (prior && delta && delta.since <= prior.rev) {
        for (const recordId of delta.ids)
          changes.put({ scope, board: id, id: recordId, value: board.items[recordId] ?? null });
      } else {
        base.put(
          source instanceof Blob ? { scope, id, snapshot: source } : { scope, id, value: board },
        );
        changes.delete(boardRange(scope, id));
      }
    }
    headers.put({ scope, id, value: { id, title, rev, updatedAt, role } });
  }
  await done;
}
export async function cachedBoardList(
  scope = currentCacheScope(),
): Promise<BoardSummary[] | undefined> {
  const tx = await transaction(['lists'], 'readonly', scope);
  if (!tx || !scope) return;
  const row = await read(tx.objectStore('lists').get(scope));
  if (scope === currentCacheScope()) return row?.value as BoardSummary[] | undefined;
}
export async function cacheBoardList(
  rows: BoardSummary[],
  scope = currentCacheScope(),
): Promise<void> {
  const tx = await transaction(['lists'], 'readwrite', scope);
  if (!tx) return;
  const done = committed(tx);
  tx.objectStore('lists').put({ scope, value: rows });
  await done;
}
/** Update a single board without replacing concurrent updates to the cached list. */
export async function rememberSummary(
  board: BoardSummary,
  scope = currentCacheScope(),
): Promise<void> {
  const tx = await transaction(['lists'], 'readwrite', scope);
  if (!tx || !scope) return;
  const done = committed(tx);
  const store = tx.objectStore('lists');
  const previous = await read(store.get(scope));
  const rows = (previous?.value ?? []) as BoardSummary[];
  const old = rows.find((entry) => entry.id === board.id);
  if (!old || old.rev <= board.rev) {
    const { id, title, rev, updatedAt, role } = board;
    const next = [{ id, title, rev, updatedAt, role }, ...rows.filter((entry) => entry.id !== id)];
    next.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    store.put({ scope, value: next });
  }
  await done;
}
export async function cacheLibrary(
  state: LibraryState,
  scope = currentCacheScope(),
): Promise<void> {
  const tx = await transaction(['lists'], 'readwrite', scope);
  if (!tx || !scope) return;
  const done = committed(tx);
  tx.objectStore('lists').put({ scope: scope + ':library', value: state });
  await done;
}
export async function cachedLibrary(
  scope = currentCacheScope(),
): Promise<LibraryState | undefined> {
  const tx = await transaction(['lists'], 'readonly', scope);
  if (!tx || !scope) return;
  const store = tx.objectStore('lists');
  const [library, summaries] = await Promise.all([
    read(store.get(scope + ':library')),
    read(store.get(scope)),
  ]);
  if (scope !== currentCacheScope()) return;
  if (library) return library.value as LibraryState;
  if (summaries) {
    const boards = (summaries.value as BoardSummary[]).map((board) => ({
      ...board,
      folderId: null,
      trashedAt: null,
      favorite: false,
    }));
    return { folders: [], boards };
  }
}
export async function forgetBoard(id: string, scope = currentCacheScope()): Promise<void> {
  const tx = await transaction([...boardStores, 'lists', 'drafts'], 'readwrite', scope);
  if (!tx || !scope) return;
  const done = committed(tx);
  tx.objectStore('boards').delete([scope, id]);
  tx.objectStore('boardHeaders').delete([scope, id]);
  tx.objectStore('boardChanges').delete(boardRange(scope, id));
  const lists = tx.objectStore('lists');
  const drafts = tx.objectStore('drafts');
  const [list, library, keys] = await Promise.all([
    read(lists.get(scope)),
    read(lists.get(scope + ':library')),
    read(drafts.index('board').getAllKeys([scope, id])),
  ]);
  if (library)
    lists.put({
      scope: scope + ':library',
      value: {
        ...library.value,
        boards: (library.value as LibraryState).boards.filter((b) => b.id !== id),
      },
    });
  if (list) lists.put({ scope, value: (list.value as BoardSummary[]).filter((b) => b.id !== id) });
  for (const key of keys) drafts.delete(key);
  await done;
  for (const key of checkpointKeys('folio.checkpoint:' + scope + ':' + id + ':')) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
}

// Identity changes invalidate running writers. A previous workspace's drafts stay keyed by its
// server-issued scope and become available again when that identity is explicitly restored.
export async function clearOfflineCache(): Promise<void> {
  epoch++;
  try {
    localStorage.setItem('folio.workspaceEpoch', crypto.randomUUID());
  } catch {}
}
window.addEventListener('storage', (event) => {
  if (event.key === 'folio.workspaceEpoch') {
    epoch++;
    window.dispatchEvent(new Event('folio-workspace-changed'));
  }
});

function acquireLane(name: string): Promise<(() => void) | undefined> {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(undefined);
          return;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}

function checkpointKeys(prefix: string): string[] {
  try {
    return Object.keys(localStorage).filter((key) => key.startsWith(prefix));
  } catch {
    return [];
  }
}

export async function claimDrafts<T>(board: string): Promise<DraftLease<T>[]> {
  const scope = currentCacheScope();
  const startEpoch = epoch;
  const validScope = () => startEpoch === epoch && scope === currentCacheScope();
  if (!scope || !navigator.locks || !window.indexedDB) {
    return [
      { durable: false, valid: validScope, async save() {}, checkpoint() {}, async release() {} },
    ];
  }
  const prefix = 'folio.draft:' + scope + ':' + board + ':';
  const checkpointPrefix = 'folio.checkpoint:' + scope + ':' + board + ':';
  return navigator.locks.request(prefix + 'assign', async () => {
    const tx = await transaction(['drafts'], 'readonly', scope);
    if (!tx) throw new Error('workspace_changed');
    const rows = await read<DraftRow<T>[]>(
      tx.objectStore('drafts').index('board').getAll([scope, board]),
    );
    const known = new Map(rows.map((row) => [row.lane, row]));
    for (const key of checkpointKeys(checkpointPrefix)) {
      try {
        const local = JSON.parse(localStorage.getItem(key) ?? 'null') as DraftRow<T>;
        const prior = known.get(local.lane);
        if (
          local.scope === scope &&
          local.board === board &&
          key === checkpointPrefix + local.lane &&
          (!prior || (local.sequence ?? 0) > (prior.sequence ?? 0))
        )
          known.set(local.lane, local);
      } catch {
        /* Keep a valid IDB journal when the synchronous fallback is unavailable. */
      }
    }
    const ordered = [...known.values()].sort(
      (a, b) => a.created - b.created || a.lane.localeCompare(b.lane),
    );
    const leases: DraftLease<T>[] = [];
    async function claim(lane: string, created: number, initial?: T | null, sequence = 0) {
      const unlock = await acquireLane(prefix + lane);
      if (!unlock) return;
      let active = true;
      let writes = Promise.resolve();
      const lease: DraftLease<T> = {
        value: initial ?? undefined,
        durable: true,
        checkpoint(value) {
          if (!lease.valid()) return;
          const key = checkpointPrefix + lane;
          // Called synchronously on pagehide. A false-negative ACK may safely be replayed using the same opId.
          try {
            if (value === null && !localStorage.getItem(key)) return;
            const row = { scope, board, lane, created, sequence: ++sequence, value };
            localStorage.setItem(key, JSON.stringify(row));
          } catch {
            /* IndexedDB remains the primary journal when the emergency quota is exhausted. */
          }
        },
        valid: () => active && validScope(),
        save(value) {
          if (!lease.valid()) return Promise.reject(new Error('workspace_changed'));
          const copy = value === null ? null : structuredClone(value);
          const serial = ++sequence;
          writes = writes
            .catch(() => {})
            .then(async () => {
              if (!validScope()) throw new Error('workspace_changed');
              const tx = await transaction(['boards', 'drafts'], 'readwrite', scope);
              if (!tx) throw new Error('workspace_changed');
              const done = committed(tx);
              const drafts = tx.objectStore('drafts');
              if (copy === null) drafts.delete([scope!, board, lane]);
              else if (await read(tx.objectStore('boards').getKey([scope!, board]))) {
                drafts.put({ scope, board, lane, created, sequence: serial, value: copy });
              } else {
                await done;
                throw new Error('board_cache_missing');
              }
              await done;
              try {
                const key = checkpointPrefix + lane;
                const local = JSON.parse(localStorage.getItem(key) ?? 'null');
                if (local && local.sequence <= serial) localStorage.removeItem(key);
              } catch {}
            });
          return writes;
        },
        async release() {
          active = false;
          try {
            await writes;
          } finally {
            unlock();
          }
        },
      };
      leases.push(lease);
      if (initial === null) await lease.save(null);
    }
    try {
      for (const row of ordered) await claim(row.lane, row.created, row.value, row.sequence);
      if (!leases.length) await claim(crypto.randomUUID(), Date.now());
      return leases;
    } catch (error) {
      await Promise.allSettled(leases.map((lease) => lease.release()));
      throw error;
    }
  });
}

if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener(
    'load',
    () =>
      void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {}),
  );
}
