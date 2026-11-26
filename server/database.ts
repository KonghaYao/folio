import { Database } from 'bun:sqlite';
import { initializeLibrary } from './library-store';
import { randomUUID } from 'node:crypto';
import { Devices, digest } from './devices';
import { Invitations } from './invitations';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ApiError,
  isObject,
  MAX_BOARD_ASSET_BYTES,
  MAX_BOARD_BYTES,
  type BoardMeta,
  type BoardSnapshot,
  type Mutation,
  type Role,
  type ShareRole,
} from './protocol';

interface AccessibleBoard extends BoardMeta {
  role: Role;
}
interface Asset {
  id: string;
  name: string;
  type: string;
  size: number;
}

/** Single-writer transactions assign all revisions, including object tombstones. */
export class BoardStore {
  readonly db: Database;
  readonly devices: Devices;
  private readonly invitations: Invitations;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
    );
    this.db
      .transaction(() => {
        const version = this.db
          .query<{ user_version: number }, []>('PRAGMA user_version')
          .get()?.user_version;
        if (version === 1) return;
        if (version !== 0) throw new Error('Unsupported board database version');
        this.db.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          item_bytes INTEGER NOT NULL DEFAULT 0, asset_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE members (
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          principal TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
          PRIMARY KEY(board_id,principal)
        );
        CREATE INDEX members_by_principal ON members(principal);
        CREATE TABLE items (
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          id TEXT NOT NULL, rev INTEGER NOT NULL, body TEXT, byte_count INTEGER NOT NULL,
          PRIMARY KEY(board_id,id)
        );
        CREATE TABLE receipts (
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          principal TEXT NOT NULL, op_id TEXT NOT NULL, rev INTEGER NOT NULL, fingerprint TEXT NOT NULL,
          PRIMARY KEY(board_id,principal,op_id)
        );
        CREATE TABLE invitations (
          token_hash TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('editor','viewer'))
        );
        CREATE TABLE assets (
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL,
          PRIMARY KEY(board_id,id)
        );
        PRAGMA user_version=1;
      `);
      })
      .immediate();
    this.db.exec('CREATE INDEX IF NOT EXISTS items_by_revision ON items(board_id,rev)');
    initializeLibrary(this.db);
    this.devices = new Devices(this.db);
    this.invitations = new Invitations(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adopted_assets (
        board_id TEXT NOT NULL, source_board TEXT NOT NULL, source_asset TEXT NOT NULL, asset_id TEXT NOT NULL,
        PRIMARY KEY(board_id,source_board,source_asset),
        FOREIGN KEY(board_id,asset_id) REFERENCES assets(board_id,id) ON DELETE CASCADE
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  list(principal: string): AccessibleBoard[] {
    return this.db
      .query<AccessibleBoard, [string]>(
        `
      SELECT b.id,b.title,b.rev,b.updated_at AS updatedAt,m.role FROM boards b
      JOIN members m ON m.board_id=b.id
      LEFT JOIN library_entries e ON e.board_id=b.id AND e.principal=m.principal
      LEFT JOIN library_folders f ON f.id=e.folder_id AND f.principal=m.principal
      WHERE m.principal=? AND e.trashed_at IS NULL AND f.trashed_at IS NULL ORDER BY b.updated_at DESC,b.id
    `,
      )
      .all(principal);
  }

  board(
    id: string,
    principal: string,
    capability: 'read' | 'write' | 'own' = 'read',
  ): AccessibleBoard {
    const board = this.db
      .query<AccessibleBoard, [string, string]>(
        `
      SELECT b.id,b.title,b.rev,b.updated_at AS updatedAt,m.role FROM boards b
      JOIN members m ON m.board_id=b.id WHERE b.id=? AND m.principal=?
    `,
      )
      .get(id, principal);
    if (!board) throw new ApiError(404, 'board_not_found');
    if (
      (capability === 'write' && board.role === 'viewer') ||
      (capability === 'own' && board.role !== 'owner')
    ) {
      throw new ApiError(403, 'permission_denied');
    }
    return board;
  }

  create(title: string, principal: string): BoardSnapshot {
    return this.db
      .transaction(() => {
        const id = randomUUID();
        const updatedAt = Date.now();
        this.db.run('INSERT INTO boards(id,title,rev,updated_at) VALUES(?,?,0,?)', [
          id,
          title,
          updatedAt,
        ]);
        this.db.run("INSERT INTO members VALUES(?,?,'owner')", [id, principal]);
        return { id, title, rev: 0, updatedAt, role: 'owner' as const, items: {} };
      })
      .immediate();
  }

  // Programmatic consumers receive materialized records; HTTP sends the encoded bytes directly.
  snapshot(id: string, principal: string): BoardSnapshot {
    return JSON.parse(new TextDecoder().decode(this.readDocument(id, principal)));
  }

  changes(
    id: string,
    principal: string,
    since: number,
  ): AccessibleBoard & {
    put: BoardSnapshot['items'];
    remove: string[];
  } {
    return JSON.parse(new TextDecoder().decode(this.readDocument(id, principal, since)));
  }

  /** Read a single revision as UTF-8 for HTTP. Bodies were validated and JSON-encoded
   * at commit. Keep them in SQLite's native representation while assembling the map.
   */
  readDocument(id: string, principal: string, since?: number): Uint8Array<ArrayBuffer> {
    return this.db.transaction(() => {
      const board = this.board(id, principal);
      if (since !== undefined && since > board.rev) {
        throw new ApiError(409, 'future_revision', { rev: board.rev });
      }
      const header = JSON.stringify(board).slice(0, -1);
      if (since === undefined) {
        return this.db
          .query<{ bytes: Uint8Array<ArrayBuffer> }, [string, string]>(
            `SELECT CAST(? || ',"items":{' ||
               COALESCE(group_concat(json_quote(id) || ':' || body), '') || '}}' AS BLOB) AS bytes
             FROM (SELECT id,body FROM items WHERE board_id=? AND body IS NOT NULL ORDER BY id)`,
          )
          .get(header, id)!.bytes;
      }
      return this.db
        .query<{ bytes: Uint8Array<ArrayBuffer> }, [string, string, number]>(
          `SELECT CAST(? || ',"put":{' ||
             COALESCE(group_concat(json_quote(id) || ':' || body) FILTER (WHERE body IS NOT NULL), '') ||
             '},"remove":[' || COALESCE(group_concat(json_quote(id)) FILTER (WHERE body IS NULL), '') ||
             ']}' AS BLOB) AS bytes
           FROM (SELECT id,body FROM items WHERE board_id=? AND rev>? ORDER BY rev,id)`,
        )
        .get(header, id, since)!.bytes;
    })();
  }

  rename(id: string, principal: string, title: string): AccessibleBoard {
    return this.db
      .transaction(() => {
        this.board(id, principal, 'write');
        this.db.run('UPDATE boards SET title=?,rev=rev+1,updated_at=? WHERE id=?', [
          title,
          Date.now(),
          id,
        ]);
        return this.board(id, principal);
      })
      .immediate();
  }

  delete(id: string, principal: string): number {
    return this.db
      .transaction(() => {
        const board = this.board(id, principal, 'own');
        this.db.run('DELETE FROM boards WHERE id=?', [id]);
        return board.rev + 1;
      })
      .immediate();
  }

  apply(id: string, principal: string, change: Mutation) {
    return this.db
      .transaction(() => {
        const board = this.board(id, principal, 'write');
        const fingerprint = digest(JSON.stringify(change));
        const receipt = this.db
          .query<
            { rev: number; fingerprint: string },
            [string, string, string]
          >('SELECT rev,fingerprint FROM receipts WHERE board_id=? AND principal=? AND op_id=?')
          .get(id, principal, change.opId);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            throw new ApiError(409, 'operation_id_reused', { rev: board.rev });
          return { rev: receipt.rev, duplicate: true };
        }
        if (change.baseRev > board.rev) throw new ApiError(409, 'conflict', { rev: board.rev });
        const rev = board.rev + 1;
        const read = this.db.query<{ rev: number; byte_count: number }, [string, string]>(
          'SELECT rev,byte_count FROM items WHERE board_id=? AND id=?',
        );
        const write = this.db.query(`
        INSERT INTO items VALUES(?,?,?,?,?) ON CONFLICT(board_id,id) DO UPDATE SET
          rev=excluded.rev,body=excluded.body,byte_count=excluded.byte_count
      `);
        let delta = 0;
        for (const key of [...Object.keys(change.put), ...change.remove]) {
          const existing = read.get(id, key);
          if (existing && existing.rev > change.baseRev) {
            throw new ApiError(409, 'conflict', { rev: board.rev, itemId: key });
          }
          const record = Object.hasOwn(change.put, key) ? change.put[key] : null;
          if (record) {
            const attachment =
              isObject(record.props) && isObject(record.props.attachment)
                ? record.props.attachment.url
                : null;
            const reference = record.typeName === 'asset' ? record.src : attachment;
            if (typeof reference === 'string' && reference.startsWith('/api/boards/')) {
              const prefix = '/api/boards/' + id + '/assets/';
              if (
                !reference.startsWith(prefix) ||
                !this.db
                  .query('SELECT 1 FROM assets WHERE board_id=? AND id=?')
                  .get(id, reference.slice(prefix.length))
              )
                throw new ApiError(400, 'invalid_board_asset');
            }
          }
          const body = record === null ? null : JSON.stringify(record);
          const bytes = body === null ? 0 : Buffer.byteLength(body);
          delta += bytes - (existing?.byte_count ?? 0);
          write.run(id, key, rev, body, bytes);
        }
        const totals = this.db
          .query<{ item_bytes: number }, [string]>('SELECT item_bytes FROM boards WHERE id=?')
          .get(id)!;
        if (totals.item_bytes + delta > MAX_BOARD_BYTES)
          throw new ApiError(413, 'board_size_limit');
        this.db.run('UPDATE boards SET rev=?,item_bytes=item_bytes+?,updated_at=? WHERE id=?', [
          rev,
          delta,
          Date.now(),
          id,
        ]);
        this.db.run('INSERT INTO receipts VALUES(?,?,?,?,?)', [
          id,
          principal,
          change.opId,
          rev,
          fingerprint,
        ]);
        return { rev, duplicate: false };
      })
      .immediate();
  }

  links(id: string, principal: string) {
    this.board(id, principal, 'own');
    return this.invitations.list(id);
  }

  invite(id: string, principal: string, role: ShareRole) {
    return this.db
      .transaction(() => {
        this.board(id, principal, 'own');
        return this.invitations.create(id, role);
      })
      .immediate();
  }

  join(token: string, principal: string) {
    return this.invitations.redeem(token, principal);
  }

  revoke(id: string, principal: string, invitation: string) {
    return this.db
      .transaction(() => {
        const board = this.board(id, principal, 'own');
        this.invitations.revoke(id, invitation);
        this.db.run('UPDATE boards SET rev=rev+1,updated_at=? WHERE id=?', [Date.now(), id]);
        return board.rev + 1;
      })
      .immediate();
  }

  attach(id: string, principal: string, name: string, type: string, bytes: Uint8Array): Asset {
    return this.db
      .transaction(() => {
        this.board(id, principal, 'write');
        this.reserveAssetBytes(id, bytes.length);
        const asset = { id: randomUUID(), name, type, size: bytes.length };
        this.db.run('INSERT INTO assets VALUES(?,?,?,?,?,?)', [
          id,
          asset.id,
          name,
          type,
          asset.size,
          bytes,
        ]);
        return asset;
      })
      .immediate();
  }

  private reserveAssetBytes(id: string, size: number) {
    const changed = this.db.run(
      'UPDATE boards SET asset_bytes=asset_bytes+? WHERE id=? AND asset_bytes+?<=?',
      [size, id, size, MAX_BOARD_ASSET_BYTES],
    );
    if (!changed.changes) throw new ApiError(413, 'board_asset_limit');
  }

  asset(id: string, principal: string, assetId: string): Asset {
    this.board(id, principal);
    const asset = this.db
      .query<
        Asset,
        [string, string]
      >('SELECT id,name,type,size FROM assets WHERE board_id=? AND id=?')
      .get(id, assetId);
    if (!asset) throw new ApiError(404, 'asset_not_found');
    return asset;
  }

  assetBytes(
    id: string,
    principal: string,
    assetId: string,
    start: number,
    length: number,
  ): Uint8Array<ArrayBuffer> {
    this.board(id, principal);
    const found = this.db
      .query<
        { bytes: Uint8Array<ArrayBuffer> },
        [number, number, string, string]
      >('SELECT substr(bytes,?,?) AS bytes FROM assets WHERE board_id=? AND id=?')
      .get(start + 1, length, id, assetId);
    if (!found) throw new ApiError(404, 'asset_not_found');
    return found.bytes;
  }

  adopt(id: string, principal: string, sourceId: string, sourceAsset: string): Asset {
    return this.db
      .transaction(() => {
        this.board(id, principal, 'write');
        const source = this.asset(sourceId, principal, sourceAsset);
        if (sourceId === id) return source;
        const existing = this.db
          .query<
            { asset_id: string },
            [string, string, string]
          >('SELECT asset_id FROM adopted_assets WHERE board_id=? AND source_board=? AND source_asset=?')
          .get(id, sourceId, sourceAsset);
        if (existing) return this.asset(id, principal, existing.asset_id);
        this.reserveAssetBytes(id, source.size);
        const assetId = randomUUID();
        this.db.run(
          `INSERT INTO assets(board_id,id,name,type,size,bytes)
        SELECT ?,?,name,type,size,bytes FROM assets WHERE board_id=? AND id=?`,
          [id, assetId, sourceId, sourceAsset],
        );
        this.db.run('INSERT INTO adopted_assets VALUES(?,?,?,?)', [
          id,
          sourceId,
          sourceAsset,
          assetId,
        ]);
        return { ...source, id: assetId };
      })
      .immediate();
  }
}
