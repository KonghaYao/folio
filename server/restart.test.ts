import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverMain = new URL('./index.ts', import.meta.url).pathname;
const backupMain = new URL('./backup.ts', import.meta.url).pathname;

async function start(database: string) {
  const child = Bun.spawn([process.execPath, serverMain], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', FOLIO_DB: database },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  try {
    const line = await child.stdout.getReader().read();
    const url = new TextDecoder().decode(line.value).match(/http:\/\/[^\s/]+/)?.[0];
    if (!url || !(await fetch(url + '/api/health')).ok)
      throw new Error('Service did not pass readiness check');
    return { child, url };
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  }
}

test('a killed Bun server recovers acknowledged edits, and a live backup boots under a new process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-process-'));
  const db = join(directory, 'original.sqlite'),
    snapshot = join(directory, 'backup.sqlite'),
    recovered = join(directory, 'restored.sqlite');
  let live: Awaited<ReturnType<typeof start>> | undefined;
  try {
    live = await start(db);
    const response = await fetch(live.url + '/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Lab"}',
    });
    const { id } = await response.json();
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    const shape = {
      id: 'shape:1',
      typeName: 'shape',
      type: 'note',
      x: 0,
      y: 0,
      rot: 0,
      z: 1,
      props: { text: 'Acknowledged', color: 'yellow', size: 'm', font: 'sans' },
    };
    const put = await fetch(live.url + '/api/boards/' + id + '/ops', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ opId: 'ack', baseRev: 0, put: { [shape.id]: shape } }),
    });
    expect(await put.json()).toEqual({ rev: 1, duplicate: false });
    expect(
      await Bun.spawn([process.execPath, backupMain, 'backup', db, snapshot], {
        stdout: 'pipe',
        stderr: 'inherit',
      }).exited,
    ).toBe(0);
    live.child.kill('SIGKILL');
    await live.child.exited;
    live = await start(db);
    const get = async () =>
      (await fetch(live!.url + '/api/boards/' + id, { headers: { Cookie: cookie } })).json();
    expect(await get()).toMatchObject({ rev: 1, role: 'owner', items: { [shape.id]: shape } });
    live.child.kill('SIGTERM');
    expect(await live.child.exited).toBe(0);
    expect(
      await Bun.spawn([process.execPath, backupMain, 'restore', snapshot, recovered], {
        stdout: 'pipe',
        stderr: 'inherit',
      }).exited,
    ).toBe(0);
    live = await start(recovered);
    expect(await get()).toMatchObject({
      title: 'Lab',
      rev: 1,
      role: 'owner',
      items: { [shape.id]: shape },
    });
    live.child.kill('SIGTERM');
    expect(await live.child.exited).toBe(0);
  } finally {
    if (live && live.child.exitCode === null) {
      live.child.kill('SIGKILL');
      await live.child.exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
