import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { ApiError, type BoardMeta, type Role } from './protocol';

export interface LibraryFolder {
  id: string;
  name: string;
  trashedAt: number | null;
}

export interface LibraryBoard extends BoardMeta {
  role: Role;
  favorite: boolean;
  folderId: string | null;
  trashedAt: number | null;
}

export interface LibraryState {
  folders: LibraryFolder[];
  boards: LibraryBoard[];
}

export interface BoardPreferences {
  favorite?: boolean;
  folderId?: string | null;
  trashed?: boolean;
}

/** Organization is private to a member, including for boards shared with others. */
export function initializeLibrary(db: Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_folders (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, name TEXT NOT NULL, trashed_at INTEGER,
        UNIQUE(id,principal)
      );
      CREATE INDEX IF NOT EXISTS library_folders_by_member ON library_folders(principal);
      CREATE TABLE IF NOT EXISTS library_entries (
        board_id TEXT NOT NULL, principal TEXT NOT NULL, folder_id TEXT,
        favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)), trashed_at INTEGER,
        PRIMARY KEY(board_id,principal),
        FOREIGN KEY(board_id,principal) REFERENCES members(board_id,principal) ON DELETE CASCADE,
        FOREIGN KEY(folder_id,principal) REFERENCES library_folders(id,principal)
      );
    `);
  }).immediate();
}

// Restrict search to human-readable fields. This avoids searching image data URLs and ink samples.
// json_extract keeps the stored snapshot authoritative across imports, undo and remote changes.
const searchableFields = [
  '$.title',
  '$.text',
  '$.name',
  '$.label',
  '$.url',
  '$.props.text',
  '$.props.label',
  '$.props.title',
  '$.props.description',
  '$.props.cells',
  '$.props.url',
  '$.props.name',
  '$.props.attachment.name',
  '$.props.attachment.url',
];
const itemSearch = searchableFields
  .map((path) => `coalesce(json_extract(i.body,'${path}'),'')`)
  .join('||char(10)||');

export class LibraryStore {
  constructor(private readonly db: Database) {}

  read(principal: string, query: string): LibraryState {
    const folders = this.db
      .query<
        LibraryFolder,
        [string]
      >('SELECT id,name,trashed_at AS trashedAt FROM library_folders WHERE principal=? ORDER BY name COLLATE NOCASE,id')
      .all(principal);
    const search = query.trim();
    const filter = search
      ? `AND (instr(lower(b.title),lower(?2))>0 OR EXISTS (
      SELECT 1 FROM items i WHERE i.board_id=b.id AND i.body IS NOT NULL
        AND instr(lower(${itemSearch}),lower(?2))>0))`
      : '';
    const rows = this.db
      .query<Omit<LibraryBoard, 'favorite'> & { favorite: number }, string[]>(
        `
      SELECT b.id,b.title,b.rev,b.updated_at AS updatedAt,m.role,coalesce(e.favorite,0) AS favorite,
             e.folder_id AS folderId,coalesce(e.trashed_at,f.trashed_at) AS trashedAt
      FROM members m JOIN boards b ON b.id=m.board_id
      LEFT JOIN library_entries e ON e.board_id=b.id AND e.principal=m.principal
      LEFT JOIN library_folders f ON f.id=e.folder_id AND f.principal=m.principal
      WHERE m.principal=?1 ${filter} ORDER BY b.updated_at DESC,b.id
    `,
      )
      .all(...(search ? [principal, search] : [principal]));
    return { folders, boards: rows.map((row) => ({ ...row, favorite: Boolean(row.favorite) })) };
  }

  createFolder(principal: string, name: string): LibraryFolder {
    const id = randomUUID();
    this.db.run('INSERT INTO library_folders(id,principal,name) VALUES(?,?,?)', [
      id,
      principal,
      name,
    ]);
    return { id, name, trashedAt: null };
  }

  updateFolder(principal: string, id: string, patch: { name?: string; trashed?: boolean }): void {
    this.db
      .transaction(() => {
        this.requireFolder(principal, id);
        if (patch.name !== undefined)
          this.db.run('UPDATE library_folders SET name=? WHERE principal=? AND id=?', [
            patch.name,
            principal,
            id,
          ]);
        if (patch.trashed !== undefined)
          this.db.run('UPDATE library_folders SET trashed_at=? WHERE principal=? AND id=?', [
            patch.trashed ? Date.now() : null,
            principal,
            id,
          ]);
      })
      .immediate();
  }

  setPreferences(principal: string, boardId: string, patch: BoardPreferences): void {
    this.db
      .transaction(() => {
        const member = this.db
          .query('SELECT 1 FROM members WHERE board_id=? AND principal=?')
          .get(boardId, principal);
        if (!member) throw new ApiError(404, 'board_not_found');
        if (patch.folderId && this.requireFolder(principal, patch.folderId).trashedAt !== null) {
          throw new ApiError(409, 'folder_in_trash');
        }
        this.db.run('INSERT OR IGNORE INTO library_entries(board_id,principal) VALUES(?,?)', [
          boardId,
          principal,
        ]);
        if (patch.folderId !== undefined)
          this.db.run('UPDATE library_entries SET folder_id=? WHERE board_id=? AND principal=?', [
            patch.folderId,
            boardId,
            principal,
          ]);
        if (patch.favorite !== undefined)
          this.db.run('UPDATE library_entries SET favorite=? WHERE board_id=? AND principal=?', [
            Number(patch.favorite),
            boardId,
            principal,
          ]);
        if (patch.trashed === true)
          this.db.run('UPDATE library_entries SET trashed_at=? WHERE board_id=? AND principal=?', [
            Date.now(),
            boardId,
            principal,
          ]);
        if (patch.trashed === false)
          this.db.run(
            `
        UPDATE library_entries SET trashed_at=NULL, folder_id=CASE
          WHEN folder_id IN(SELECT id FROM library_folders WHERE principal=? AND trashed_at IS NOT NULL)
          THEN NULL ELSE folder_id END WHERE board_id=? AND principal=?`,
            [principal, boardId, principal],
          );
      })
      .immediate();
  }

  private requireFolder(principal: string, id: string): LibraryFolder {
    const folder = this.db
      .query<
        LibraryFolder,
        [string, string]
      >('SELECT id,name,trashed_at AS trashedAt FROM library_folders WHERE principal=? AND id=?')
      .get(principal, id);
    if (!folder) throw new ApiError(404, 'folder_not_found');
    return folder;
  }
}
