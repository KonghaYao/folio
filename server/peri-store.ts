// Peri's WASM store and the SDK directory reader use the Hrana v3 JSON cursor.
// Each private store has a separate listener, bearer secret and SQLite database.
import { Database, constants, type SQLQueryBindings } from 'bun:sqlite';

type WireValue =
  | { type: 'null' }
  | { type: 'integer' | 'text'; value: string }
  | { type: 'float'; value: number }
  | { type: 'blob'; base64: string };

type Condition =
  | { type: 'is_autocommit' }
  | { type: 'ok' | 'error'; step: number }
  | { type: 'not'; cond: Condition }
  | { type: 'and' | 'or'; conds: Condition[] };

type Statement = {
  sql: string;
  args?: WireValue[];
  named_args?: { name: string; value: WireValue }[];
  want_rows?: boolean;
};
type Step = { stmt: Statement; condition?: Condition | null };
type Outcome = 'ok' | 'error' | 'skipped';

function matches(condition: Condition, prior: Outcome[], db: Database): boolean {
  switch (condition.type) {
    case 'is_autocommit':
      return !db.inTransaction;
    case 'ok':
    case 'error':
      return prior[condition.step] === condition.type;
    case 'not':
      return !matches(condition.cond, prior, db);
    case 'and':
      return condition.conds.every((item) => matches(item, prior, db));
    case 'or':
      return condition.conds.some((item) => matches(item, prior, db));
    default:
      throw new Error('Unsupported batch condition');
  }
}

function fromWire(value: WireValue): string | number | bigint | Uint8Array | null {
  switch (value.type) {
    case 'null':
      return null;
    case 'integer':
      return BigInt(value.value);
    case 'blob':
      return Buffer.from(value.base64, 'base64');
    case 'text':
    case 'float':
      return value.value;
    default:
      throw new Error('Unsupported SQLite value');
  }
}

function toWire(value: string | number | bigint | null | Uint8Array): WireValue {
  if (value == null) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
  if (typeof value === 'number') return { type: 'float', value };
  if (typeof value === 'string') return { type: 'text', value };
  return { type: 'blob', base64: Buffer.from(value).toString('base64') };
}

function execute(db: Database, stmt: Statement) {
  const query = db.prepare<unknown, SQLQueryBindings[]>(stmt.sql).safeIntegers(true);
  try {
    const args = stmt.named_args?.length
      ? [Object.fromEntries(stmt.named_args.map((arg) => [arg.name, fromWire(arg.value)]))]
      : (stmt.args ?? []).map(fromWire);
    const columns = query.columnNames;
    const cols = columns.map((name, i) => ({ name, decltype: query.declaredTypes[i] ?? null }));
    if (!cols.length) {
      const { changes, lastInsertRowid } = query.run(...args);
      return {
        cols,
        rows: [],
        affected_row_count: changes,
        last_insert_rowid: String(lastInsertRowid),
      };
    }
    const rows = query.values(...args);
    return {
      cols,
      rows: stmt.want_rows === false ? [] : rows.map((row) => row.map(toWire)),
      affected_row_count: 0,
      last_insert_rowid: null,
    };
  } finally {
    query.finalize();
  }
}

function sqlError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : 'SQLite query failed',
    code:
      typeof error === 'object' && error && 'code' in error ? String(error.code) : 'SQLITE_ERROR',
  };
}

function batch(db: Database, steps: Step[]) {
  const step_results: (ReturnType<typeof execute> | null)[] = [];
  const step_errors: (ReturnType<typeof sqlError> | null)[] = [];
  const prior: Outcome[] = [];
  for (const { stmt, condition } of steps) {
    let result: ReturnType<typeof execute> | null = null;
    let error: ReturnType<typeof sqlError> | null = null;
    if (condition && !matches(condition, prior, db)) prior.push('skipped');
    else {
      try {
        result = execute(db, stmt);
        prior.push('ok');
      } catch (cause) {
        error = sqlError(cause);
        prior.push('error');
      }
    }
    step_results.push(result);
    step_errors.push(error);
  }
  return { step_results, step_errors };
}

function cursor(db: Database, steps: Step[], baton: string) {
  const lines: unknown[] = [{ baton, base_url: null }];
  const { step_results, step_errors } = batch(db, steps);
  step_results.forEach((result, step) => {
    if (result) {
      const { cols, rows, ...summary } = result;
      lines.push({ type: 'step_begin', step, cols });
      for (const row of rows) lines.push({ type: 'row', row });
      lines.push({ type: 'step_end', ...summary });
    } else if (step_errors[step])
      lines.push({ type: 'step_error', step, error: step_errors[step] });
  });
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', {
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

export function startPeriStore(databasePath = ':memory:') {
  const ephemeral = databasePath === ':memory:';
  // The shared-memory URI is unique to the turn. A single anchor connection
  // keeps its pages alive while individual OS-local Hrana streams come and go.
  const path = ephemeral
    ? 'file:folio-' + crypto.randomUUID() + '?mode=memory&cache=shared'
    : databasePath;
  const flags =
    constants.SQLITE_OPEN_CREATE |
    constants.SQLITE_OPEN_READWRITE |
    (ephemeral ? constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_SHAREDCACHE : 0);
  let anchor: Database | undefined;
  let closed = false;
  function connection() {
    if (ephemeral && !anchor) anchor = new Database(path, flags);
    const db = new Database(path, flags);
    db.exec('PRAGMA foreign_keys=ON');
    return db;
  }
  const streams = new Map<string, Database>();
  const authToken = crypto.randomUUID();
  const service = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        request.headers.get('authorization') !== 'Bearer ' + authToken
      ) {
        return new Response(null, { status: 403 });
      }
      const route = new URL(request.url).pathname;
      if (route !== '/v3/cursor' && route !== '/v3/pipeline')
        return new Response(null, { status: 404 });
      try {
        const frame = (await request.json()) as {
          baton?: string | null;
          batch?: { steps: Step[] };
          requests?: { type: string; stmt?: Statement; batch?: { steps: Step[] } }[];
        };
        if (closed) return new Response(null, { status: 410 });
        const validBody =
          route === '/v3/cursor'
            ? Array.isArray(frame.batch?.steps)
            : Array.isArray(frame.requests);
        if (!validBody) return new Response(null, { status: 400 });
        if (frame.baton && !streams.has(frame.baton)) return new Response(null, { status: 410 });
        if (!frame.baton && streams.size >= 64) return new Response(null, { status: 503 });
        const baton = crypto.randomUUID();
        const db = frame.baton ? streams.get(frame.baton)! : connection();
        if (frame.baton) streams.delete(frame.baton);
        streams.set(baton, db);
        if (route === '/v3/cursor' && frame.batch) return cursor(db, frame.batch.steps, baton);
        const results = (frame.requests ?? []).map((op) => {
          try {
            if (!streams.has(baton)) throw new Error('Stream is closed');
            switch (op.type) {
              case 'close':
                db.close();
                streams.delete(baton);
                return { type: 'ok', response: { type: 'close' } };
              case 'get_autocommit':
                return {
                  type: 'ok',
                  response: { type: op.type, is_autocommit: !db.inTransaction },
                };
              case 'batch':
                return {
                  type: 'ok',
                  response: { type: op.type, result: batch(db, op.batch!.steps) },
                };
              case 'execute':
                return { type: 'ok', response: { type: op.type, result: execute(db, op.stmt!) } };
              default:
                throw new Error('Unsupported Peri stream request');
            }
          } catch (error) {
            return { type: 'error', error: sqlError(error) };
          }
        });
        return Response.json({ baton: streams.has(baton) ? baton : null, base_url: null, results });
      } catch {
        return new Response('Invalid store request', { status: 400 });
      }
    },
  });
  return {
    url: service.url.origin,
    authToken,
    close() {
      if (closed) return;
      closed = true;
      service.stop(true);
      for (const db of streams.values()) db.close();
      streams.clear();
      anchor?.close();
      anchor = undefined;
    },
  };
}
