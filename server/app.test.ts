import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createApp } from './app';
import { copyDatabase } from './backup';
import { BoardStore } from './database';
import { BoardEvents } from './events';

let store: BoardStore;
let events: BoardEvents;
let app: ReturnType<typeof createApp>;

class Browser {
  cookie = '';
  async send(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const binary = body instanceof Uint8Array;
    const response = await app.request('http://localhost' + path, {
      method,
      headers: {
        Cookie: this.cookie,
        'Content-Type': binary ? 'application/octet-stream' : 'application/json',
        ...headers,
      },
      body: binary ? new Uint8Array(body) : body === undefined ? undefined : JSON.stringify(body),
    });
    const cookies = new Map(
      this.cookie
        .split('; ')
        .filter(Boolean)
        .map((cookie) => [cookie.split('=')[0], cookie]),
    );
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0];
      cookies.set(pair.split('=')[0], pair);
    }
    this.cookie = [...cookies.values()].join('; ');
    return response;
  }
}
const note = (id: string, text: string) => ({
  id,
  typeName: 'shape',
  type: 'note',
  x: 1,
  y: 2,
  z: 0,
  rot: 0,
  props: { text, color: 'yellow', size: 'm', font: 'sans' },
});
const mutation = (
  opId: string,
  baseRev: number,
  put: Record<string, unknown>,
  remove: string[] = [],
) => ({ opId, baseRev, put, remove });
async function share(owner: Browser, id: string, role: 'editor' | 'viewer', peer = new Browser()) {
  const { token } = await (
    await owner.send('/api/boards/' + id + '/share', 'POST', { role })
  ).json();
  expect((await peer.send('/api/join', 'POST', { token })).status).toBe(200);
  return peer;
}

describe('board HTTP service', () => {
  beforeEach(() => {
    store = new BoardStore(':memory:');
    events = new BoardEvents();
    app = createApp(store, events);
  });
  afterEach(() => {
    events.close();
    store.close();
  });

  test('reopens the durable board with the original session, preserving ink telemetry and revision', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'folio-sqlite-'));
    const file = join(temp, 'nested', 'data.db');
    try {
      store.close();
      store = new BoardStore(file);
      app = createApp(store, events);
      const owner = new Browser();
      const path =
        '/api/boards/' +
        (await (await owner.send('/api/boards', 'POST', { title: 'Ink' })).json()).id;
      const pen = {
        id: 'pen:1',
        typeName: 'shape',
        type: 'draw',
        x: 100,
        y: 80,
        z: 1,
        rot: 0,
        props: {
          color: 'black',
          size: 'm',
          pts: [0, 0, 0, 4, -1, 0.7],
          ink: {
            version: 1,
            brush: 'pencil',
            width: 4,
            color: '#334455',
            samples: [
              [0, 0, 0, 0, 90, 0, 0],
              [4, -1, 0.7, -45, 52, 94, -0.2],
            ],
          },
        },
      };
      expect(
        (await owner.send(path + '/ops', 'POST', mutation('first', 0, { [pen.id]: pen }))).status,
      ).toBe(200);
      store.close();
      store = new BoardStore(file);
      app = createApp(store, events);
      const reloaded = await (await owner.send(path)).json();
      expect(reloaded).toMatchObject({
        title: 'Ink',
        rev: 1,
        role: 'owner',
        items: { [pen.id]: pen },
      });
      expect((await (await owner.send('/api/boards')).json()).boards[0].id).toBe(reloaded.id);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('rebases disjoint concurrent edits, deduplicates retries and rolls back entire conflicting batch', async () => {
    const owner = new Browser();
    const { id } = await (await owner.send('/api/boards', 'POST', {})).json();
    const peer = await share(owner, id, 'editor');
    const board = '/api/boards/' + id;
    const ops = board + '/ops';
    const first = mutation('a', 0, { a: note('a', 'first') });
    expect(await (await owner.send(ops, 'POST', first)).json()).toEqual({
      rev: 1,
      duplicate: false,
    });
    expect(
      await (await peer.send(ops, 'POST', mutation('b', 0, { b: note('b', 'second') }))).json(),
    ).toEqual({ rev: 2, duplicate: false });
    expect(await (await owner.send(ops, 'POST', first)).json()).toEqual({
      rev: 1,
      duplicate: true,
    });
    expect(
      (await owner.send(ops, 'POST', mutation('a', 0, { a: note('a', 'other') }))).status,
    ).toBe(409);
    const overlap = await peer.send(
      ops,
      'POST',
      mutation('c', 0, { new: note('new', 'no leak'), a: note('a', 'stale') }),
    );
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toMatchObject({ error: 'conflict', rev: 2, itemId: 'a' });
    expect((await (await owner.send(board)).json()).items.new).toBeUndefined();
    expect((await owner.send(ops, 'POST', mutation('d', 2, {}, ['a']))).status).toBe(200);
    expect(
      (await peer.send(ops, 'POST', mutation('restore-stale', 2, { a: note('a', 'revive') })))
        .status,
    ).toBe(409);
    expect(
      (await owner.send(ops, 'POST', mutation('restore', 3, { a: note('a', 'restored') }))).status,
    ).toBe(200);
  });

  test('large snapshots and deltas negotiate gzip and preserve JSON escapes, Unicode and nulls', async () => {
    const owner = new Browser();
    const title = '图板 "A"\n🪶';
    const board = await (await owner.send('/api/boards', 'POST', { title })).json();
    const path = '/api/boards/' + board.id;
    const key = 'shape:note.~-1';
    const record = note(key, '引用 "标注" \u0000/\\\n🪶'.repeat(4000));
    expect(
      (await owner.send(path + '/ops', 'POST', mutation('large', 0, { [key]: record }))).status,
    ).toBe(200);
    for (const suffix of ['', '/changes?since=0']) {
      const raw = await owner.send(path + suffix, 'GET', undefined, {
        'Accept-Encoding': 'gzip;q=0, br',
      });
      expect(raw.headers.get('content-encoding')).toBeNull();
      const expected = await raw.json();
      const compressed = await owner.send(path + suffix, 'GET', undefined, {
        'Accept-Encoding': 'br, gzip;q=0.5',
      });
      expect(compressed.headers.get('vary')).toContain('Accept-Encoding');
      expect(compressed.headers.get('content-encoding')).toBe('gzip');
      const decoded = JSON.parse(gunzipSync(await compressed.arrayBuffer()).toString());
      expect(decoded).toEqual(expected);
      expect(decoded.title).toBe(title);
      expect((decoded.items ?? decoded.put)[key]).toEqual(record);
    }
    expect(
      (
        await owner.send(path + '/changes?since=1', 'GET', undefined, { 'Accept-Encoding': 'gzip' })
      ).headers.get('content-encoding'),
    ).toBeNull();
  });

  test('incremental reads return final values and tombstones at the same revision as board metadata', async () => {
    const browser = new Browser();
    const { id } = await (await browser.send('/api/boards', 'POST', {})).json();
    const board = '/api/boards/' + id;
    await browser.send(
      board + '/ops',
      'POST',
      mutation('1', 0, { a: note('a', 'one'), b: note('b', 'two') }),
    );
    await browser.send(board + '/ops', 'POST', mutation('2', 1, { a: note('a', 'latest') }, ['b']));
    await browser.send(board, 'PATCH', { title: 'New title' });
    expect(await (await browser.send(board + '/changes?since=1')).json()).toMatchObject({
      id,
      rev: 3,
      title: 'New title',
      role: 'owner',
      put: { a: note('a', 'latest') },
      remove: ['b'],
    });
    expect(await (await browser.send(board + '/changes?since=2')).json()).toMatchObject({
      rev: 3,
      put: {},
      remove: [],
    });
    expect((await browser.send(board + '/changes?since=5')).status).toBe(409);
    expect((await browser.send(board + '/changes?since=2.5')).status).toBe(400);
    expect((await new Browser().send(board + '/changes?since=0')).status).toBe(404);
  });

  test('validates record structure, coordinates, pen and ID before committing', async () => {
    const owner = new Browser();
    const { id } = await (await owner.send('/api/boards', 'POST', {})).json();
    const path = '/api/boards/' + id + '/ops';
    for (const invalid of [
      {},
      note('different', 'oops'),
      { ...note('a', 'bad'), rot: null },
      { ...note('a', 'bad'), props: { text: 'bad', color: 'unknown' } },
      { ...note('a', 'bad'), type: 'draw', props: { pts: [1, 2, 4] } },
      { id: 'a', typeName: 'asset', src: 'https://other.invalid/i', w: 4, h: 4 },
    ]) {
      expect((await owner.send(path, 'POST', mutation('invalid', 0, { a: invalid }))).status).toBe(
        400,
      );
    }
    expect((await (await owner.send('/api/boards/' + id)).json()).rev).toBe(0);
  });

  test('viewer can read shared resources, cannot edit or invite, and foreign sessions cannot read the board', async () => {
    const owner = new Browser();
    const { id } = await (await owner.send('/api/boards', 'POST', {})).json();
    const board = '/api/boards/' + id;
    const peer = await share(owner, id, 'viewer');
    const stranger = new Browser();
    expect((await (await peer.send(board)).json()).role).toBe('viewer');
    expect(
      (await peer.send(board + '/ops', 'POST', mutation('n', 0, { n: note('n', 'read-only') })))
        .status,
    ).toBe(403);
    expect((await peer.send(board + '/share', 'POST', { role: 'editor' })).status).toBe(403);
    expect((await peer.send(board, 'DELETE')).status).toBe(403);
    expect((await stranger.send(board)).status).toBe(404);
    expect((await (await stranger.send('/api/boards')).json()).boards).toEqual([]);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const asset = await (
      await owner.send(board + '/assets?name=demo.mp4', 'POST', bytes, {
        'Content-Type': 'video/mp4',
      })
    ).json();
    expect(asset).toMatchObject({ name: 'demo.mp4', type: 'video/mp4', size: 5 });
    expect((await stranger.send(asset.url)).status).toBe(404);
    expect((await peer.send(board + '/assets', 'POST', bytes)).status).toBe(403);
    const subrange = await peer.send(asset.url, 'GET', undefined, { Range: 'bytes=1-3' });
    expect(subrange.status).toBe(206);
    expect([...new Uint8Array(await subrange.arrayBuffer())]).toEqual([2, 3, 4]);
    expect(subrange.headers.get('Content-Range')).toBe('bytes 1-3/5');
    expect((await peer.send(asset.url, 'GET', undefined, { Range: 'bytes=6-' })).status).toBe(416);
    expect((await owner.send(board, 'DELETE')).status).toBe(204);
    expect((await peer.send(asset.url)).status).toBe(404);
  });

  test('revocation expires a link and preserves only grants from surviving invitations', async () => {
    const owner = new Browser(),
      peer = new Browser();
    const { id } = await (await owner.send('/api/boards', 'POST', {})).json();
    const board = '/api/boards/' + id,
      links = board + '/share';
    const viewer = await (await owner.send(links, 'POST', { role: 'viewer' })).json();
    const editor = await (await owner.send(links, 'POST', { role: 'editor' })).json();
    await peer.send('/api/join', 'POST', { token: viewer.token });
    await peer.send('/api/join', 'POST', { token: editor.token });
    expect((await (await peer.send(board)).json()).role).toBe('editor');
    expect(
      (await (await owner.send(links)).json()).invitations.map(
        (i: { joinedCount: number }) => i.joinedCount,
      ),
    ).toEqual([1, 1]);
    expect((await peer.send(links + '/' + viewer.id, 'DELETE')).status).toBe(403);
    expect((await owner.send(links + '/' + editor.id, 'DELETE')).status).toBe(204);
    expect((await peer.send('/api/join', 'POST', { token: editor.token })).status).toBe(404);
    expect((await (await peer.send(board)).json()).role).toBe('viewer');
    expect(
      (await peer.send(board + '/ops', 'POST', mutation('v', 1, { v: note('v', 'blocked') })))
        .status,
    ).toBe(403);
    const reader = (await peer.send(board + '/events')).body!.getReader();
    await reader.read();
    expect((await owner.send(links + '/' + viewer.id, 'DELETE')).status).toBe(204);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"deleted"');
    expect((await reader.read()).done).toBe(true);
    expect((await peer.send(board)).status).toBe(404);
  });

  test('cross-board paste adopts an independent resource exactly once after checking both board permissions', async () => {
    const owner = new Browser(),
      peer = new Browser();
    const source = '/api/boards/' + (await (await owner.send('/api/boards', 'POST', {})).json()).id;
    const { id } = await (await peer.send('/api/boards', 'POST', {})).json();
    const dest = '/api/boards/' + id,
      adopt = dest + '/assets/adopt';
    const file = await (
      await owner.send(source + '/assets?name=waves.mp4', 'POST', new Uint8Array([7, 9]), {
        'Content-Type': 'video/mp4',
      })
    ).json();
    expect((await peer.send(adopt, 'POST', { url: file.url })).status).toBe(404);
    await share(owner, source.split('/').pop()!, 'viewer', peer);
    const copied = await (await peer.send(adopt, 'POST', { url: file.url })).json();
    expect(copied).toMatchObject({ name: 'waves.mp4', type: 'video/mp4', size: 2 });
    expect(copied.url).toStartWith(dest + '/assets/');
    expect((await (await peer.send(adopt, 'POST', { url: file.url })).json()).id).toBe(copied.id);
    const guest = await share(peer, id, 'viewer');
    expect((await guest.send(adopt, 'POST', { url: file.url })).status).toBe(403);
    expect((await (await guest.send(copied.url)).arrayBuffer()).byteLength).toBe(2);
    expect((await guest.send(file.url)).status).toBe(404);
    await owner.send(source, 'DELETE');
    expect([...new Uint8Array(await (await peer.send(copied.url)).arrayBuffer())]).toEqual([7, 9]);
  });

  test('live updates include the current revision, commits and the terminal deletion', async () => {
    const owner = new Browser();
    const { id } = await (await owner.send('/api/boards', 'POST', {})).json();
    const board = '/api/boards/' + id;
    const stream = await owner.send(board + '/events');
    const reader = stream.body!.getReader();
    const next = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await next()).toContain('{"rev":0,"kind":"snapshot"}');
    await owner.send(board + '/ops', 'POST', mutation('item', 0, { a: note('a', 'event') }));
    expect(await next()).toContain('{"rev":1,"kind":"items"}');
    await owner.send(board, 'PATCH', { title: 'Renamed' });
    expect(await next()).toContain('{"rev":2,"kind":"title"}');
    await owner.send(board, 'DELETE');
    expect(await next()).toContain('{"rev":3,"kind":"deleted"}');
    expect((await reader.read()).done).toBe(true);
  });

  test('pairs devices once, preserves both prior workspaces and expires unredeemed tokens', async () => {
    const source = new Browser(),
      target = new Browser(),
      outsider = new Browser();
    const sourceId = (await (await source.send('/api/boards', 'POST', { title: 'Source' })).json())
      .id;
    const targetId = (
      await (await target.send('/api/boards', 'POST', { title: 'Existing device board' })).json()
    ).id;
    const { active: original } = await (await target.send('/api/devices/workspaces')).json();
    const { token } = await (await source.send('/api/devices/pair', 'POST', {})).json();
    const sessionKey = (browser: Browser) => browser.cookie.match(/folio_session=([^;]+)/)?.[1];
    const oldCookie = sessionKey(target);
    const oldScope = target.cookie.match(/folio_cache=([^;]+)/)?.[1];
    expect((await target.send('/api/devices/claim', 'POST', { token })).status).toBe(200);
    expect(sessionKey(target)).toBe(oldCookie);
    expect(target.cookie.match(/folio_cache=([^;]+)/)?.[1]).not.toBe(oldScope);
    expect(target.cookie).not.toBe(source.cookie);
    expect((await outsider.send('/api/devices/claim', 'POST', { token })).status).toBe(410);
    expect((await (await target.send('/api/boards/' + sourceId)).json()).role).toBe('owner');
    const folder = await (
      await source.send('/api/library/folders', 'POST', { name: 'Field notes' })
    ).json();
    expect((await (await target.send('/api/library')).json()).folders[0].id).toBe(folder.id);
    await target.send(
      '/api/boards/' + sourceId + '/ops',
      'POST',
      mutation('sync', 0, { n: note('n', 'From tablet') }),
    );
    expect((await (await source.send('/api/boards/' + sourceId)).json()).items.n.props.text).toBe(
      'From tablet',
    );
    const previous = await (await target.send('/api/devices/workspaces')).json();
    expect(previous.workspaces).toHaveLength(2);
    expect(
      (await outsider.send('/api/devices/switch', 'POST', { workspaceId: original })).status,
    ).toBe(404);
    await target.send('/api/devices/switch', 'POST', { workspaceId: original });
    expect((await (await target.send('/api/boards/' + targetId)).json()).title).toBe(
      'Existing device board',
    );
    expect((await target.send('/api/boards/' + sourceId)).status).toBe(404);
    const expiring = await (await source.send('/api/devices/pair', 'POST', {})).json();
    store.db.run('UPDATE device_pairings SET expires_at=0');
    expect(
      (await target.send('/api/devices/claim', 'POST', { token: expiring.token })).status,
    ).toBe(410);
  });

  test('a paired tablet revokes the original laptop, closes streams and invalidates pending pairings', async () => {
    const laptop = new Browser(),
      tablet = new Browser(),
      outsider = new Browser();
    const board =
      '/api/boards/' +
      (await (await laptop.send('/api/boards', 'POST', { title: 'Shared workspace' })).json()).id;
    const { token } = await (await laptop.send('/api/devices/pair', 'POST')).json();
    await tablet.send('/api/devices/claim', 'POST', { token });
    const spare = await (await laptop.send('/api/devices/pair', 'POST')).json();
    const { devices } = await (await tablet.send('/api/devices/linked')).json();
    expect(devices.length).toBe(2);
    expect(devices[0].current).toBe(true);
    expect((await tablet.send('/api/devices/linked/' + devices[0].id, 'DELETE')).status).toBe(409);
    expect((await outsider.send('/api/devices/linked/' + devices[1].id, 'DELETE')).status).toBe(
      404,
    );
    const reader = (await laptop.send(board + '/events')).body!.getReader();
    await reader.read();
    expect((await tablet.send('/api/devices/linked/' + devices[1].id, 'DELETE')).status).toBe(204);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"deleted"');
    expect((await reader.read()).done).toBe(true);
    expect((await laptop.send(board)).status).toBe(404);
    expect((await (await laptop.send('/api/boards')).json()).boards).toEqual([]);
    expect((await tablet.send(board)).status).toBe(200);
    expect((await laptop.send('/api/devices/claim', 'POST', { token: spare.token })).status).toBe(
      410,
    );
  });

  test('ephemeral cursors respect board ACLs and expiry and never advance revision', async () => {
    const owner = new Browser(),
      outsider = new Browser();
    const { id } = await (await owner.send('/api/boards', 'POST', {})).json();
    const board = '/api/boards/' + id,
      endpoint = board + '/presence';
    const packet = {
      tab: 'example-tab-123456789',
      cursor: { x: 10, y: 20 },
      view: { x: 0, y: 0, w: 640, h: 480 },
    };
    expect((await outsider.send(endpoint, 'POST', packet)).status).toBe(404);
    expect((await owner.send(endpoint, 'POST', { ...packet, view: {} })).status).toBe(400);
    const { self } = await (await owner.send(endpoint, 'POST', packet)).json();
    expect(self).toHaveLength(16);
    expect((await owner.send(endpoint, 'POST', packet)).status).toBe(429);
    const viewer = await share(owner, id, 'viewer');
    const reader = (await viewer.send(board + '/events')).body!.getReader();
    await reader.read();
    const message = new TextDecoder().decode((await reader.read()).value);
    expect(message).toContain('event: presence');
    expect(message).toContain(self);
    expect(message).not.toContain(packet.tab);
    events.presence.prune(id, undefined, Date.now() + 26000);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"peers":[]');
    expect((await (await owner.send(board)).json()).rev).toBe(0);
    await reader.cancel();
  });

  test('live backup and restore yield a new verified database with editable ink, ACL and original bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'folio-backup-'));
    const source = join(dir, 'source.db'),
      backup = join(dir, 'snapshot.db'),
      restored = join(dir, 'restored.db');
    try {
      store.close();
      store = new BoardStore(source);
      app = createApp(store, events);
      const owner = new Browser();
      const { id } = await (await owner.send('/api/boards', 'POST', { title: 'Shore' })).json();
      const board = '/api/boards/' + id;
      const peer = await share(owner, id, 'viewer');
      const { url } = await (
        await owner.send(board + '/assets?name=pelican.png', 'POST', new Uint8Array([6, 5, 4]))
      ).json();
      await owner.send(board + '/ops', 'POST', mutation('before', 0, { a: note('a', 'First') }));
      copyDatabase(source, backup);
      expect(() => copyDatabase(source, backup)).toThrow();
      await owner.send(board + '/ops', 'POST', mutation('later', 1, { a: note('a', 'Later') }));
      copyDatabase(backup, restored);
      store.close();
      store = new BoardStore(restored);
      app = createApp(store, events);
      const snapshot = await (await peer.send(board)).json();
      expect(snapshot).toMatchObject({ rev: 1, role: 'viewer', items: { a: note('a', 'First') } });
      expect([...new Uint8Array(await (await peer.send(url)).arrayBuffer())]).toEqual([6, 5, 4]);
      expect(
        (
          await owner.send(
            board + '/ops',
            'POST',
            mutation('restored', 1, { b: note('b', 'Works') }),
          )
        ).status,
      ).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects cross-origin writes and malformed values, and reports health', async () => {
    const browser = new Browser();
    expect((await browser.send('/api/health')).status).toBe(200);
    expect(
      (await browser.send('/api/boards', 'POST', {}, { Origin: 'https://elsewhere.invalid' }))
        .status,
    ).toBe(403);
    expect((await browser.send('/api/boards', 'POST', { title: '   ' })).status).toBe(400);
    expect((await browser.send('/api/join', 'POST', { token: 'bad' })).status).toBe(400);
  });
});
