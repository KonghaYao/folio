import { expect, test } from 'bun:test';
import { startPeriStore } from './peri-store';

test('Peri streams isolate transactions, preserve 64-bit integers and reject stale batons', async () => {
  const store = startPeriStore();
  async function post(frame: unknown, token: string = store.authToken) {
    return fetch(store.url + '/v3/pipeline', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(frame),
    });
  }
  const sql = (sql: string) => ({ type: 'execute', stmt: { sql, want_rows: true } });
  try {
    expect((await post({}, 'wrong')).status).toBe(403);
    const first = await (await post({ requests: [sql('CREATE TABLE value (n INTEGER)')] })).json();
    const write = await (
      await post({
        baton: first.baton,
        requests: [sql('BEGIN IMMEDIATE'), sql('INSERT INTO value VALUES(9007199254740993)')],
      })
    ).json();
    expect(write.results.every((r: { type: string }) => r.type === 'ok')).toBe(true);
    expect((await post({ baton: first.baton, requests: [sql('SELECT 1')] })).status).toBe(410);
    const other = await (await post({ requests: [sql('SELECT n FROM value')] })).json();
    // SQLite may report SQLITE_LOCKED. It must never reveal uncommitted rows.
    expect(other.results[0].response?.result?.rows ?? []).toHaveLength(0);
    await post({ baton: write.baton, requests: [sql('COMMIT'), { type: 'close' }] });
    const read = await (
      await post({ baton: other.baton, requests: [sql('SELECT n FROM value')] })
    ).json();
    expect(read.results[0].response.result.rows).toEqual([
      [{ type: 'integer', value: '9007199254740993' }],
    ]);
  } finally {
    store.close();
  }
});

test('simultaneous Peri activations have distinct database contents and bearer credentials', async () => {
  const a = startPeriStore();
  const b = startPeriStore();
  async function select(store: ReturnType<typeof startPeriStore>, sql: string) {
    const response = await fetch(store.url + '/v3/cursor', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + store.authToken, 'content-type': 'application/json' },
      body: JSON.stringify({ batch: { steps: [{ stmt: { sql } }] } }),
    });
    return (await response.text())
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
  }
  try {
    expect(a.authToken).not.toBe(b.authToken);
    await select(a, 'CREATE TABLE private_canvas (id TEXT)');
    expect((await select(a, 'SELECT id FROM private_canvas'))[1].type).toBe('step_begin');
    expect((await select(b, 'SELECT id FROM private_canvas'))[1].type).toBe('step_error');
  } finally {
    a.close();
    b.close();
  }
});
