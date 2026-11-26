import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { BoardStore } from '../server/database';
import type { LibraryState } from '../server/library-store';

const tempPaths: string[] = [];
const opened: BoardStore[] = [];
function open(path = ':memory:') {
  const store = new BoardStore(path);
  opened.push(store);
  return createApp(store);
}
function member(app: ReturnType<typeof createApp>, key: string) {
  return async (method: string, path: string, payload?: object): Promise<Response> => {
    return app.request(path, {
      method,
      headers: { cookie: 'folio_session=' + key.repeat(43), 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  };
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('personal board library', () => {
  test('private organization, folder recovery and preferences survive reopening SQLite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folio-library-'));
    tempPaths.push(root);
    const path = join(root, 'library.sqlite');
    const app = open(path);
    const owner = member(app, 'a');
    const viewer = member(app, 'b');
    const ownerState = async () =>
      (await (await owner('GET', '/api/library')).json()) as LibraryState;
    const { id } = (await (await owner('POST', '/api/boards', { title: '骑车的鹈鹕' })).json()) as {
      id: string;
    };
    const { id: other } = (await (
      await owner('POST', '/api/boards', { title: '第二张' })
    ).json()) as {
      id: string;
    };
    const { id: folder } = (await (
      await owner('POST', '/api/library/folders', { name: '海鸟写生' })
    ).json()) as { id: string };
    expect((await viewer('PATCH', '/api/library/boards/' + id, { favorite: true })).status).toBe(
      404,
    );
    const { token } = (await (
      await owner('POST', `/api/boards/${id}/share`, { role: 'viewer' })
    ).json()) as {
      token: string;
    };
    expect((await viewer('POST', '/api/join', { token })).status).toBe(200);
    expect((await viewer('PATCH', '/api/library/boards/' + id, { folderId: folder })).status).toBe(
      404,
    );
    expect(
      (await viewer('PATCH', '/api/library/folders/' + folder, { name: '别人文件夹' })).status,
    ).toBe(404);
    expect((await viewer('PATCH', '/api/library/boards/' + id, { favorite: true })).status).toBe(
      204,
    );
    expect((await ownerState()).boards.find((b) => b.id === id)?.favorite).toBe(false);
    expect(
      (await owner('PATCH', '/api/library/boards/' + id, { folderId: folder, favorite: true }))
        .status,
    ).toBe(204);
    await owner('PATCH', '/api/library/boards/' + other, { folderId: folder, trashed: true });
    await owner('PATCH', '/api/library/folders/' + folder, { trashed: true });
    expect((await ownerState()).boards.every((b) => b.trashedAt !== null)).toBe(true);
    expect(
      ((await (await owner('GET', '/api/boards')).json()) as { boards: unknown[] }).boards,
    ).toHaveLength(0);
    expect(
      ((await (await viewer('GET', '/api/boards')).json()) as { boards: unknown[] }).boards,
    ).toHaveLength(1);
    expect((await owner('PATCH', '/api/library/boards/' + id, { folderId: folder })).status).toBe(
      409,
    );
    await owner('PATCH', '/api/library/folders/' + folder, { trashed: false, name: '画稿' });
    const restored = await ownerState();
    expect(restored.boards.find((b) => b.id === id)).toMatchObject({
      folderId: folder,
      trashedAt: null,
      favorite: true,
    });
    expect(restored.boards.find((b) => b.id === other)?.trashedAt).not.toBeNull();
    await owner('PATCH', '/api/library/folders/' + folder, { trashed: true });
    await owner('PATCH', '/api/library/boards/' + id, { trashed: false });
    opened.pop()!.close();
    const reopened = member(open(path), 'a');
    const state = (await (await reopened('GET', '/api/library')).json()) as LibraryState;
    expect(state.folders).toMatchObject([{ name: '画稿' }]);
    expect(state.boards.find((b) => b.id === id)).toMatchObject({
      folderId: null,
      trashedAt: null,
      favorite: true,
    });
  });

  test('searches accessible titles and actual contents, honoring mutation and validation', async () => {
    const app = open();
    const owner = member(app, 'c'),
      other = member(app, 'd');
    const { id } = (await (await owner('POST', '/api/boards', { title: 'Birds' })).json()) as {
      id: string;
    };
    const item = {
      id: 'note-1',
      typeName: 'shape',
      type: 'note',
      x: 0,
      y: 0,
      z: 0,
      rot: 0,
      props: { text: '翅膀与脚蹼' },
    };
    expect(
      (
        await owner('POST', `/api/boards/${id}/ops`, {
          opId: 'add',
          baseRev: 0,
          put: { 'note-1': item },
          remove: [],
        })
      ).status,
    ).toBe(200);
    const search = async (who: typeof owner, q: string) =>
      ((await (await who('GET', '/api/library?q=' + encodeURIComponent(q))).json()) as LibraryState)
        .boards;
    expect(await search(owner, 'bIrDs')).toHaveLength(1);
    expect(await search(owner, '脚蹼')).toHaveLength(1);
    expect(await search(other, '脚蹼')).toHaveLength(0);
    expect(await search(owner, '%')).toHaveLength(0);
    await owner('POST', `/api/boards/${id}/ops`, {
      opId: 'remove',
      baseRev: 1,
      put: {},
      remove: ['note-1'],
    });
    expect(await search(owner, '脚蹼')).toHaveLength(0);
    expect((await owner('PATCH', '/api/library/boards/' + id, { favorite: 'true' })).status).toBe(
      400,
    );
    expect((await owner('PATCH', '/api/library/boards/' + id, { folderId: '' })).status).toBe(400);
    expect((await owner('POST', '/api/library/folders', { name: '  ' })).status).toBe(400);
    expect((await owner('GET', '/api/library?q=' + 'x'.repeat(121))).status).toBe(400);
  });
});
