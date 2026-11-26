import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Devices } from './devices';

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE members (
      board_id TEXT NOT NULL, principal TEXT NOT NULL, role TEXT NOT NULL,
      PRIMARY KEY(board_id, principal)
    );
  `);
  return db;
}

function withShared<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.FOLIO_SHARED_WORKSPACE;
  if (value === undefined) delete process.env.FOLIO_SHARED_WORKSPACE;
  else process.env.FOLIO_SHARED_WORKSPACE = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FOLIO_SHARED_WORKSPACE;
    else process.env.FOLIO_SHARED_WORKSPACE = previous;
  }
}

describe('shared workspace', () => {
  test('keeps devices isolated by default', () => {
    withShared(undefined, () => {
      const devices = new Devices(database());
      expect(devices.principal('device-a')).not.toBe(devices.principal('device-b'));
    });
  });

  test('resolves every device to one workspace and adopts existing boards', () => {
    withShared('team', () => {
      const db = database();
      db.run("INSERT INTO boards VALUES('board-1', 'Sketch', 0, 0)");
      db.run("INSERT INTO members VALUES('board-1', 'old-principal', 'owner')");
      const devices = new Devices(db);
      expect(devices.principal('device-a')).toBe('shared:team');
      expect(devices.principal('device-b')).toBe('shared:team');
      expect(devices.list('device-a').active).toBeTruthy();
      expect(
        db
          .query('SELECT principal FROM members WHERE board_id=? ORDER BY principal')
          .all('board-1'),
      ).toEqual([{ principal: 'old-principal' }, { principal: 'shared:team' }]);
    });
  });
});
