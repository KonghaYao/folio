import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { digest, secret } from './devices';
import { ApiError, type Role, type ShareRole } from './protocol';

/** Separate invitation grants let an owner revoke exactly the access conferred by one link. */
export class Invitations {
  constructor(private readonly db: Database) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sharing_links (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE REFERENCES invitations(token_hash) ON DELETE CASCADE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sharing_grants (
          token_hash TEXT NOT NULL REFERENCES invitations(token_hash) ON DELETE CASCADE,
          principal TEXT NOT NULL, PRIMARY KEY(token_hash,principal)
        );
        CREATE INDEX IF NOT EXISTS sharing_grants_by_principal ON sharing_grants(principal);
        CREATE TABLE IF NOT EXISTS sharing_baselines (
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, principal TEXT NOT NULL, role TEXT NOT NULL,
          PRIMARY KEY(board_id,principal)
        );
        INSERT OR IGNORE INTO sharing_links(id,token_hash,created_at)
          SELECT lower(hex(randomblob(16))), token_hash,0 FROM invitations
          WHERE NOT EXISTS(SELECT 1 FROM sharing_links s WHERE s.token_hash=invitations.token_hash);
      `);
    }).immediate();
  }

  list(id: string) {
    return this.db
      .query<{ id: string; role: ShareRole; createdAt: number; joinedCount: number }, [string]>(
        `
      SELECT s.id,i.role,s.created_at AS createdAt,count(g.principal) AS joinedCount
      FROM invitations i JOIN sharing_links s ON s.token_hash=i.token_hash
      LEFT JOIN sharing_grants g ON g.token_hash=i.token_hash WHERE i.board_id=?
      GROUP BY s.id ORDER BY s.created_at DESC,s.id
    `,
      )
      .all(id);
  }

  create(board: string, role: ShareRole) {
    const token = secret();
    const hash = digest(token);
    const id = randomUUID();
    const createdAt = Date.now();
    this.db.run('INSERT INTO invitations VALUES(?,?,?)', [hash, board, role]);
    this.db.run('INSERT INTO sharing_links VALUES(?,?,?)', [id, hash, createdAt]);
    return { token, id, role, createdAt };
  }

  redeem(token: string, principal: string) {
    return this.db
      .transaction(() => {
        const hash = digest(token);
        const grant = this.db
          .query<
            { id: string; role: ShareRole },
            [string]
          >('SELECT board_id AS id,role FROM invitations WHERE token_hash=?')
          .get(hash);
        if (!grant) throw new ApiError(404, 'invitation_not_found');
        const member = this.db
          .query<
            { role: Role },
            [string, string]
          >('SELECT role FROM members WHERE board_id=? AND principal=?')
          .get(grant.id, principal);
        if (member?.role === 'owner') return { id: grant.id, role: 'owner' as const };

        // Preserve existing direct memberships from stores predating link-level attribution.
        if (
          member &&
          !this.db
            .query(
              `SELECT 1 FROM sharing_grants g JOIN invitations i ON i.token_hash=g.token_hash
          WHERE i.board_id=? AND g.principal=? LIMIT 1`,
            )
            .get(grant.id, principal)
        ) {
          this.db.run('INSERT OR IGNORE INTO sharing_baselines VALUES(?,?,?)', [
            grant.id,
            principal,
            member.role,
          ]);
        }
        this.db.run('INSERT OR IGNORE INTO sharing_grants VALUES(?,?)', [hash, principal]);
        const role = member?.role === 'editor' ? 'editor' : grant.role;
        this.db.run(
          'INSERT INTO members VALUES(?,?,?) ON CONFLICT(board_id,principal) DO UPDATE SET role=excluded.role',
          [grant.id, principal, role],
        );
        return { id: grant.id, role };
      })
      .immediate();
  }

  revoke(board: string, id: string): void {
    const invitation = this.db
      .query<{ hash: string }, [string, string]>(
        `SELECT i.token_hash AS hash FROM invitations i
      JOIN sharing_links s ON i.token_hash=s.token_hash WHERE i.board_id=? AND s.id=?`,
      )
      .get(board, id);
    if (!invitation) throw new ApiError(404, 'invitation_not_found');
    const affected = this.db
      .query<
        { principal: string },
        [string]
      >('SELECT principal FROM sharing_grants WHERE token_hash=?')
      .all(invitation.hash);
    this.db.run('DELETE FROM invitations WHERE token_hash=?', [invitation.hash]);
    const surviving = this.db.query<{ role: ShareRole }, [string, string]>(`
      SELECT role FROM (
        SELECT i.role FROM invitations i JOIN sharing_grants g ON i.token_hash=g.token_hash
          WHERE i.board_id=?1 AND g.principal=?2
        UNION ALL SELECT role FROM sharing_baselines WHERE board_id=?1 AND principal=?2
      ) ORDER BY CASE role WHEN 'editor' THEN 0 ELSE 1 END LIMIT 1
    `);
    for (const { principal } of affected) {
      const grant = surviving.get(board, principal);
      if (grant)
        this.db.run(
          "UPDATE members SET role=? WHERE board_id=? AND principal=? AND role!='owner'",
          [grant.role, board, principal],
        );
      else
        this.db.run("DELETE FROM members WHERE board_id=? AND principal=? AND role!='owner'", [
          board,
          principal,
        ]);
    }
  }
}
