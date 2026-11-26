import { currentCacheScope } from './offline';

const LIMIT_BYTES = 64 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;
function db() {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('folio.media.v1', 1);
      opening.onupgradeneeded = () => {
        const store = opening.result.createObjectStore('assets', { keyPath: ['scope', 'path'] });
        store.createIndex('time', 'stored');
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  return database;
}
type CachedAsset = { scope: string; path: string; data: Blob; size: number; stored: number };
function value<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function finish(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
async function put(scope: string, path: string, data: Blob) {
  const base = await db();
  if (scope !== currentCacheScope() || data.size > LIMIT_BYTES) return;
  const tx = base.transaction('assets', 'readwrite'),
    done = finish(tx);
  const assets = tx.objectStore('assets');
  assets.put({ scope, path, data, size: data.size, stored: Date.now() } satisfies CachedAsset);
  // The cursor reads blob handles, not decoded bytes. Keep recent entries under the device cap.
  const rows = await value<CachedAsset[]>(assets.index('time').getAll());
  let bytes = rows.reduce((total, row) => total + row.size, 0);
  for (const row of rows) {
    if (bytes <= LIMIT_BYTES) break;
    assets.delete([row.scope, row.path]);
    bytes -= row.size;
  }
  await done;
}
export async function forgetBoardAssets(id: string, scope = currentCacheScope()) {
  if (!scope) return;
  const base = await db(),
    tx = base.transaction('assets', 'readwrite'),
    done = finish(tx),
    store = tx.objectStore('assets');
  const prefix = '/api/boards/' + encodeURIComponent(id) + '/assets/';
  const keys = await value(
    store.getAllKeys(IDBKeyRange.bound([scope, prefix], [scope, prefix + '\uffff'])),
  );
  for (const key of keys) store.delete(key);
  await done;
}
/** Online reads always check the server grant. Only transport failures can use a cached blob. */
export async function readAsset(path: string): Promise<Blob> {
  if (!/^\/api\/boards\/[\w-]+\/assets\/[\w-]+$/.test(path)) throw new Error('invalid_asset_path');
  const scope = currentCacheScope();
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  } catch (error) {
    if (!scope) throw error;
    const base = await db(),
      row = await value<CachedAsset | undefined>(
        base.transaction('assets').objectStore('assets').get([scope, path]),
      );
    if (!row || currentCacheScope() !== scope) throw error;
    return row.data;
  }
  if (!response.ok) {
    if (response.status === 403 || response.status === 404)
      await forgetBoardAssets(path.split('/')[3], scope).catch(() => {});
    throw new Error('asset_http_' + response.status);
  }
  const blob = await response.blob();
  if (scope && currentCacheScope() !== scope) throw new Error('workspace_changed');
  if (scope) await put(scope, path, blob).catch(() => {});
  return blob;
}
