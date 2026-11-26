import { afterEach, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { BoardStore } from '../canvas/store';
import type { BoardCanvas } from '../canvas';
import { createCanvasMcp } from './index';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function fixture(flush: () => Promise<void> = async () => {}) {
  const store = new BoardStore();
  const editor = {
    boardId: 'board-A',
    readonly: false,
    disposed: false,
    session: null as null | { type: string },
    selection: new Set<string>(),
    viewportPageBounds: () => ({ x: 0, y: 0, w: 800, h: 600 }),
    camera: { z: 1 },
    setSelection(ids: string[]) {
      this.selection = new Set(ids);
    },
  };
  const bridge = await createCanvasMcp({
    boardId: editor.boardId,
    canvas: { editor: editor as unknown as BoardCanvas['editor'], store },
    flush,
  });
  const transport: Transport = {
    async start() {},
    async close() {},
    async send(frame: JSONRPCMessage) {
      const response = await bridge.exchange(frame);
      if (response) this.onmessage?.(response);
    },
  };
  const client = new Client({ name: 'folio-test-agent', version: '1.0' });
  await client.connect(transport);
  cleanup.push(async () => {
    await client.close();
    await bridge.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    const content = reply.content as Array<{ type: string; text: string }>;
    if (reply.isError) throw new Error(content[0].text);
    return JSON.parse(content[0].text);
  };
  return { store, editor, client, bridge, call };
}
const rect = { kind: 'rectangle', x: 80, y: 40, w: 120, h: 30, text: 'Review', color: '#117755' };
test('MCP negotiates real tools, groups a creation in native history and exposes the live selection', async () => {
  let flushes = 0;
  const f = await fixture(async () => {
    flushes++;
  });
  expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual([
    'canvas_read',
    'canvas_create',
    'canvas_update',
    'canvas_delete',
    'canvas_select',
    'canvas_view',
  ]);
  const created = await f.call('canvas_create', {
    objects: [
      { ...rect, key: 'first' },
      { ...rect, key: 'second', x: 420 },
      { kind: 'arrow', x: 0, y: 0, fromId: 'first', toId: 'second' },
    ],
  });
  expect(flushes).toBe(1);
  expect(created.sync).toBe('synced');
  const [left, right, line] = created.created.map((s: { id: string }) => s.id);
  expect(f.store.shapes()).toHaveLength(3);
  const arrow = () => f.store.shapes().find((v) => v.id === line)!;
  expect(arrow().props.bindings.start.id).toBe(left);
  expect(arrow().props.dx).toBe(340);
  f.store.undo();
  expect(f.store.shapes()).toHaveLength(0);
  f.store.redo();
  await f.call('canvas_select', { ids: [right] });
  const read = await f.call('canvas_read', { scope: 'selection', query: 'review' });
  expect(read.selectedIds).toEqual([right]);
  expect(read.objects.map((v: { id: string }) => v.id)).toEqual([right]);
  await f.call('canvas_update', { changes: [{ id: left, x: 100 }] });
  expect(arrow().props.dx).toBe(320);
  await f.call('canvas_delete', { ids: [line] });
  expect(f.store.shapes()).toHaveLength(2);
});
test('failed batches are atomic; locked objects, gestures, cross-board data and inactive sessions are rejected', async () => {
  const f = await fixture();
  const {
    created: [{ id }],
  } = await f.call('canvas_create', { objects: [rect] });
  await expect(
    f.call('canvas_update', {
      changes: [
        { id, x: 200 },
        { id: 'missing', x: 40 },
      ],
    }),
  ).rejects.toThrow('Unknown object');
  expect(f.store.shapes()[0].x).toBe(80);
  await expect(
    f.call('canvas_create', {
      objects: [rect, { kind: 'stroke', x: 0, y: 0, points: [[0, 0, 8]] }],
    }),
  ).rejects.toThrow('Invalid');
  expect(f.store.shapes()).toHaveLength(1);
  f.store.update(id, { props: { locked: true } });
  await expect(f.call('canvas_delete', { ids: [id] })).rejects.toThrow('locked');
  await expect(f.call('canvas_read', { boardId: 'board-B' })).rejects.toThrow('Unrecognized');
  f.editor.session = { type: 'drawing' };
  await expect(f.call('canvas_create', { objects: [rect] })).rejects.toThrow(
    'active canvas gesture',
  );
  f.editor.session = null;
  f.editor.readonly = true;
  expect((await f.client.listTools()).tools.map((t) => t.name)).not.toContain('canvas_create');
  await expect(f.call('canvas_create', { objects: [rect] })).rejects.toThrow('View-only');
  f.editor.boardId = 'board-B';
  await expect(f.bridge.exchange({ jsonrpc: '2.0', method: 'ping', id: 500 })).rejects.toThrow(
    'no longer open',
  );
});
test('MCP redelivery does not duplicate a committed edit or its outbox entry', async () => {
  let attempts = 0;
  const f = await fixture(async () => {
    attempts++;
    throw new Error('offline');
  });
  const frame = {
    jsonrpc: '2.0',
    id: 'retry',
    method: 'tools/call',
    params: { name: 'canvas_create', arguments: { objects: [rect] } },
  };
  const [first, again] = await Promise.all([f.bridge.exchange(frame), f.bridge.exchange(frame)]);
  expect(JSON.stringify(first)).toContain('local-pending');
  expect(again).toEqual(first);
  expect(await f.bridge.exchange(frame)).toEqual(first);
  expect(f.store.shapes()).toHaveLength(1);
  expect(attempts).toBe(1);
});
test('curves and pressure/tilt strokes are editable validated vector records', async () => {
  const f = await fixture();
  await f.call('canvas_create', {
    objects: [
      {
        kind: 'path',
        x: 4,
        y: 2,
        d: 'M0 40Q20 0 40 40Z',
        w: 40,
        h: 40,
        strokeWidth: 2,
        color: '#993322',
        fill: '#aaaa22',
      },
      {
        kind: 'stroke',
        x: 3,
        y: 4,
        brush: 'pencil',
        points: [
          [0, 0, 0.1, 60, 12, 36, -0.4],
          [12, 22, 0.8, 50, 16, 55, 0.6],
        ],
      },
    ],
  });
  const [path, ink] = f.store.shapes();
  const detailed = await f.call('canvas_read', { ids: [ink.id], detailOffset: 1 });
  expect(detailed.objects[0].content.data).toEqual([[12, 22, 0.8, 50, 16, 55, 0.6]]);
  expect(path.props.vectorPath.fill).toBe('#aaaa22');
  expect(ink.props.ink.samples[1]).toEqual([12, 22, 0.8, 50, 16, 55, 0.6]);
  await f.call('canvas_update', { changes: [{ id: path.id, fill: '#222222', w: 60 }] });
  expect(f.store.shapes()[0].props.vectorPath.w).toBe(40);
  expect(f.store.shapes()[0].props.w).toBe(60);
  await expect(
    f.call('canvas_create', {
      objects: [{ kind: 'path', x: 0, y: 0, d: 'M0 2Q 4 Z', w: 4, h: 4 }],
    }),
  ).rejects.toThrow('Invalid');
});

test('single-object lookup returns bounded pages of table cells', async () => {
  const f = await fixture();
  const cells = Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 8 }, (_, c) => r + '-' + c),
  );
  const {
    created: [{ id }],
  } = await f.call('canvas_create', { objects: [{ kind: 'table', x: 0, y: 0, cells }] });
  const first = (await f.call('canvas_read', { ids: [id] })).objects[0].content;
  const last = (await f.call('canvas_read', { ids: [id], detailOffset: first.nextOffset }))
    .objects[0].content;
  expect(first.data.length).toBe(16);
  expect(last.nextOffset).toBeNull();
  expect(last.data[7]).toEqual({ row: 2, column: 7, text: '2-7' });
});

test('targeted reads intersect filters, drop missing/duplicate IDs and keep stacking order', async () => {
  const f = await fixture();
  const base = {
    typeName: 'shape' as const,
    type: 'geo' as const,
    x: 0,
    y: 0,
    rot: 0,
    z: 5,
    props: { geo: 'rectangle', w: 10, h: 10, label: 'target' },
  };
  for (const [id, x, z] of [
    ['alpha', 10, 5],
    ['bravo', 800, 4],
    ['charlie', -1000, 5],
  ] as const) {
    f.store.put({ ...base, id, x, z }, 'remote');
  }
  f.editor.setSelection(['charlie', 'alpha']);
  // Looking up a handful of records never enumerates the whole board.
  f.store.shapes = () => {
    throw Error('Unexpected full-board scan');
  };
  let r = await f.call('canvas_read', { ids: ['charlie', 'missing', 'alpha', 'bravo', 'alpha'] });
  expect(r.objects.map((o: { id: string }) => o.id)).toEqual(['bravo', 'alpha', 'charlie']);
  r = await f.call('canvas_read', {
    scope: 'visible',
    ids: ['charlie', 'bravo', 'alpha'],
    query: 'TARGET',
  });
  expect(r.objects.map((o: { id: string }) => o.id)).toEqual(['bravo', 'alpha']);
  r = await f.call('canvas_read', { scope: 'selection', ids: ['charlie', 'bravo'] });
  expect(r.objects.map((o: { id: string }) => o.id)).toEqual(['charlie']);
  expect((await f.call('canvas_read', { ids: [] })).matched).toBe(0);
});

test('paged reads sort tied z, cache by normalized query, and refresh after remote and history changes', async () => {
  const f = await fixture();
  const base = {
    typeName: 'shape' as const,
    type: 'geo' as const,
    x: 0,
    y: 0,
    rot: 0,
    props: { geo: 'rectangle', kind: 'table', w: 50, h: 50, cells: [['aBc']] },
    z: 1,
  };
  for (const id of ['C', 'A', 'B']) f.store.put({ ...base, id }, 'remote');
  const nativeShapes = f.store.shapes.bind(f.store);
  let scans = 0;
  f.store.shapes = () => {
    scans++;
    return nativeShapes();
  };
  const page = async (offset: number, query: string) =>
    await f.call('canvas_read', { offset, limit: 1, query });
  expect((await page(0, 'abc')).objects[0].id).toBe('A');
  expect((await page(1, 'ABC')).objects[0].id).toBe('B');
  expect(scans).toBe(1);
  f.store.put({ ...base, id: 'C', z: 0 }, 'remote');
  expect((await page(0, 'abc')).objects[0].id).toBe('C');
  f.store.remove(['C']);
  expect((await page(0, 'abc')).objects[0].id).toBe('A');
  f.store.undo();
  expect((await page(0, 'abc')).objects[0].id).toBe('C');
  expect((await page(2, 'other')).matched).toBe(0);
  expect((await page(3, 'abc')).objects).toEqual([]);
});

test('large dense-viewport pages match a full stable sort after camera and position changes', async () => {
  const f = await fixture();
  let left = 0;
  f.editor.viewportPageBounds = () => ({ x: left, y: 0, w: 800, h: 600 });
  const source = Array.from({ length: 2400 }, (_, i) => ({
    id: 'rank-' + i.toString().padStart(5, '0'),
    typeName: 'shape' as const,
    type: 'geo' as const,
    x: i % 5 === 0 ? 1000 : 100,
    y: 50,
    rot: 0,
    z: (i * 137) % 31,
    props: { geo: 'rectangle', w: 20, h: 30 },
  }));
  f.store.transact(() => {
    for (const shape of source) f.store.put(shape, 'remote');
  }, 'remote');
  const expected = (offset: number, limit: number) =>
    f.store
      .shapes()
      .filter((s) => s.x <= left + 800 && left <= s.x + 20)
      .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
      .slice(offset, offset + limit)
      .map((s) => s.id);
  async function check(offset: number, limit: number) {
    const r = await f.call('canvas_read', { scope: 'visible', offset, limit });
    expect(r.objects.map((s: { id: string }) => s.id)).toEqual(expected(offset, limit));
  }
  await check(617, 31);
  await check(620, 10);
  await check(11, 50);
  left = 500;
  await check(11, 50);
  left = 0;
  f.store.put({ ...source[0], x: 100, z: -500 }, 'remote');
  await check(0, 25);
  f.store.put(
    { ...source[0], x: 100, z: -500, props: { ...source[0].props, label: 'changed' } },
    'remote',
  );
  const r = await f.call('canvas_read', { limit: 1 });
  expect(r.objects[0].text).toBe('changed');
  f.editor.selection = new Set(source.map((s) => s.id));
  const sel = await f.call('canvas_read', { scope: 'selection', limit: 1 });
  expect(sel.selectedCount).toBe(2400);
  expect(sel.selectedIds).toEqual(source.slice(0, 96).map((s) => s.id));
  expect(sel.objects[0].id).toBe(source[0].id);
});
