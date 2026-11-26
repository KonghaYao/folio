import type { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from './protocol';

const PAIR_TTL = 5 * 60 * 1000;
export const secret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

interface Workspace {
  id: string;
  boardCount: number;
}

export class Devices {
  private readonly shared?: string;

  constructor(private readonly db: Database) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS device_workspaces (
          device TEXT NOT NULL, id TEXT NOT NULL, principal TEXT NOT NULL, active INTEGER NOT NULL,
          PRIMARY KEY(device,id), UNIQUE(device,principal)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS device_one_active ON device_workspaces(device) WHERE active=1;
        CREATE TABLE IF NOT EXISTS device_pairings (
          token_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS device_pairings_expiry ON device_pairings(expires_at);
        CREATE INDEX IF NOT EXISTS workspaces_by_principal ON device_workspaces(principal);
        CREATE TABLE IF NOT EXISTS device_profiles(device TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen INTEGER NOT NULL);
      `);
    }).immediate();
    const shared = process.env.FOLIO_SHARED_WORKSPACE?.trim();
    this.shared = shared ? 'shared:' + shared : undefined;
    if (this.shared) this.adopt(this.shared);
  }

  /** Share one workspace across every device, adopting boards created before the switch. */
  private adopt(principal: string) {
    this.db
      .prepare(
        `INSERT INTO members(board_id, principal, role)
        SELECT id, ?1, 'owner' FROM boards
        WHERE NOT EXISTS (
          SELECT 1 FROM members m WHERE m.board_id = boards.id AND m.principal = ?1
        )`,
      )
      .run(principal);
  }

  /** The first workspace uses the legacy cookie-derived principal, preserving existing boards. */
  principal(device: string): string {
    const shared = this.shared;
    if (shared) {
      const row = this.db
        .query<
          { principal: string },
          [string]
        >('SELECT principal FROM device_workspaces WHERE device=? AND active=1')
        .get(device);
      if (row?.principal !== shared) {
        this.db
          .transaction(() => {
            this.db.run('UPDATE device_workspaces SET active=0 WHERE device=? AND active=1', [
              device,
            ]);
            this.db.run(
              `INSERT INTO device_workspaces VALUES(?,?,?,1)
            ON CONFLICT(device,principal) DO UPDATE SET active=1`,
              [device, randomUUID(), shared],
            );
          })
          .immediate();
      }
      return shared;
    }
    const row = this.db
      .query<
        { principal: string },
        [string]
      >('SELECT principal FROM device_workspaces WHERE device=? AND active=1')
      .get(device);
    if (row) return row.principal;
    this.db.run('INSERT OR IGNORE INTO device_workspaces VALUES(?,?,?,1)', [
      device,
      randomUUID(),
      device,
    ]);
    return device;
  }

  observe(device: string, agent: string) {
    const now = Date.now();
    const last = this.db
      .query<
        { last_seen: number },
        [string]
      >('SELECT last_seen FROM device_profiles WHERE device=?')
      .get(device);
    if (last && now - last.last_seen < 60_000) return;
    const os = /iPad/i.test(agent)
      ? 'iPad'
      : /iPhone/i.test(agent)
        ? 'iPhone'
        : /Android/i.test(agent)
          ? 'Android'
          : /Macintosh/i.test(agent)
            ? 'Mac'
            : /Windows/i.test(agent)
              ? 'Windows'
              : /Linux/i.test(agent)
                ? 'Linux'
                : '设备';
    const browser = /Edg\//.test(agent)
      ? 'Edge'
      : /Firefox|FxiOS/.test(agent)
        ? 'Firefox'
        : /Chrome|CriOS/.test(agent)
          ? 'Chrome'
          : /Safari/.test(agent)
            ? 'Safari'
            : '浏览器';
    this.db.run(
      `INSERT INTO device_profiles VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET
      name=excluded.name,last_seen=excluded.last_seen`,
      [device, os + ' · ' + browser, now],
    );
  }

  linked(device: string, principal: string) {
    const rows = this.db
      .query<{ id: string; name: string; current: number; lastSeen: number }, [string, string]>(
        `
      SELECT w.id,coalesce(p.name,'浏览器') AS name,(w.device=?1) AS current,coalesce(p.last_seen,0) AS lastSeen
      FROM device_workspaces w LEFT JOIN device_profiles p ON p.device=w.device
      WHERE w.principal=?2 ORDER BY current DESC,lastSeen DESC,w.id`,
      )
      .all(device, principal);
    return { devices: rows.map((row) => ({ ...row, current: !!row.current })) };
  }

  unlink(device: string, principal: string, handle: string) {
    return this.db
      .transaction(() => {
        const target = this.db
          .query<
            { device: string; active: number },
            [string, string]
          >('SELECT device,active FROM device_workspaces WHERE principal=? AND id=?')
          .get(principal, handle);
        if (!target) throw new ApiError(404, 'device_not_linked');
        if (target.device === device) throw new ApiError(409, 'cannot_unlink_current_device');
        this.db.run('DELETE FROM device_workspaces WHERE principal=? AND id=?', [
          principal,
          handle,
        ]);
        if (target.active) {
          const other = this.db
            .query<
              { id: string },
              [string]
            >('SELECT id FROM device_workspaces WHERE device=? ORDER BY id LIMIT 1')
            .get(target.device);
          if (other)
            this.db.run('UPDATE device_workspaces SET active=1 WHERE device=? AND id=?', [
              target.device,
              other.id,
            ]);
          else
            this.db.run('INSERT INTO device_workspaces VALUES(?,?,?,1)', [
              target.device,
              randomUUID(),
              digest(secret()),
            ]);
        }
        this.db.run('DELETE FROM device_pairings WHERE principal=?', [principal]);
        return target.device;
      })
      .immediate();
  }

  list(device: string) {
    const rows = this.db
      .query<Workspace & { active: number }, [string]>(
        `
      SELECT w.id,w.active,(SELECT count(*) FROM members m WHERE m.principal=w.principal) AS boardCount
      FROM device_workspaces w WHERE w.device=? ORDER BY w.active DESC,w.id
    `,
      )
      .all(device);
    return {
      active: rows.find((row) => row.active)!.id,
      workspaces: rows.map(({ id, boardCount }) => ({ id, boardCount })),
    };
  }

  pair(principal: string) {
    return this.db
      .transaction(() => {
        const now = Date.now();
        this.db.run('DELETE FROM device_pairings WHERE expires_at<=?', [now]);
        const expiresAt = now + PAIR_TTL;
        const token = secret();
        this.db.run('INSERT INTO device_pairings VALUES(?,?,?)', [
          digest(token),
          principal,
          expiresAt,
        ]);
        return { token, expiresAt };
      })
      .immediate();
  }

  claim(device: string, token: string) {
    return this.db
      .transaction(() => {
        const hash = digest(token);
        const target = this.db
          .query<
            { principal: string; expires_at: number },
            [string]
          >('SELECT principal,expires_at FROM device_pairings WHERE token_hash=?')
          .get(hash);
        if (!target || target.expires_at <= Date.now())
          throw new ApiError(410, 'pairing_expired_or_used');
        this.db.run('DELETE FROM device_pairings WHERE token_hash=?', [hash]);
        this.db.run('UPDATE device_workspaces SET active=0 WHERE device=? AND active=1', [device]);
        this.db.run(
          `INSERT INTO device_workspaces VALUES(?,?,?,1)
        ON CONFLICT(device,principal) DO UPDATE SET active=1`,
          [device, randomUUID(), target.principal],
        );
        return { paired: true };
      })
      .immediate();
  }

  switch(device: string, workspaceId: string) {
    return this.db
      .transaction(() => {
        if (
          !this.db
            .query('SELECT 1 FROM device_workspaces WHERE device=? AND id=?')
            .get(device, workspaceId)
        ) {
          throw new ApiError(404, 'workspace_not_found');
        }
        this.db.run('UPDATE device_workspaces SET active=0 WHERE device=? AND active=1', [device]);
        this.db.run('UPDATE device_workspaces SET active=1 WHERE device=? AND id=?', [
          device,
          workspaceId,
        ]);
        return { active: workspaceId };
      })
      .immediate();
  }
}
