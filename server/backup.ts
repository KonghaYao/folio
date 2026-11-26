import { Database } from 'bun:sqlite';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** VACUUM INTO snapshots committed WAL pages and attachment BLOBs while the service is running. */
export function copyDatabase(source: string, destination: string): void {
  const target = resolve(destination);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  if (existsSync(target + '-wal') || existsSync(target + '-shm')) {
    throw new Error('Destination has SQLite sidecar files; choose a fresh path');
  }
  const staging = mkdtempSync(join(dir, '.folio-snapshot-'));
  const temporary = join(staging, 'snapshot.sqlite');
  try {
    const db = new Database(source, { readonly: true, strict: true });
    try {
      db.run('PRAGMA busy_timeout=10000');
      const version = db
        .query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version;
      if (
        version !== 1 ||
        !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='boards'").get()
      ) {
        throw new Error('Source is not a supported Folio database');
      }
      db.query('VACUUM INTO ?').run(temporary);
    } finally {
      db.close();
    }

    const result = new Database(temporary, { readonly: true });
    try {
      const checks = result.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
      if (
        checks.length !== 1 ||
        checks[0].integrity_check !== 'ok' ||
        result.query('PRAGMA foreign_key_check').get() !== null
      ) {
        throw new Error('Snapshot did not pass SQLite integrity verification');
      }
    } finally {
      result.close();
    }
    // Both paths are on the same filesystem. Publish atomically without overwriting an existing database.
    chmodSync(temporary, 0o600);
    const file = openSync(temporary, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    linkSync(temporary, target);
    const directory = openSync(dir, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [action, source, destination, ...extra] = Bun.argv.slice(2);
  if (!['backup', 'restore'].includes(action) || !source || !destination || extra.length) {
    console.error(
      'Usage: bun server/backup.ts <backup|restore> <source.sqlite> <new-destination.sqlite>',
    );
    process.exitCode = 2;
  } else {
    try {
      copyDatabase(source, destination);
      console.log(`Verified ${action}: ${resolve(destination)}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Database transfer failed');
      process.exitCode = 1;
    }
  }
}
