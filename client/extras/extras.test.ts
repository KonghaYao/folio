import { describe, expect, test } from 'bun:test';
import { Store, type BoardRecord, type Editor } from '@quickdrawjs/core';
import { parseArchive, chunkItems } from './archive';
import { cameraFor, createScene, isScene, saveScene, scenesOf, swapScenes } from './scenes';
import { exportSize } from './render';

const bounds = { x: -20, y: 30, w: 400, h: 200 };

describe('shared scenes', () => {
  test('preserves page framing across devices and captures original view', () => {
    expect(cameraFor(bounds, 800, 800)).toEqual({ x: 20, y: 70, z: 2 });
    const store = new Store();
    const editor = { store, viewportPageBounds: () => bounds } as unknown as Editor;
    const scene = createScene(editor, ' 海岸 ');
    expect(isScene(scene)).toBe(true);
    expect(scenesOf(store)).toEqual([{ ...scene, title: '海岸', bounds, order: 0 }]);
    store.undo();
    expect(scenesOf(store)).toEqual([]);
  });
  test('normalizes duplicate ranks and undoes reorder as a single transaction', () => {
    const store = new Store();
    const a = { typeName: 'scene' as const, id: 'scene:a', title: '甲', order: 0, bounds };
    const b = { ...a, id: 'scene:b', title: '乙' };
    saveScene(store, a);
    saveScene(store, b);
    swapScenes(store, a, b);
    expect(scenesOf(store).map((s) => s.id)).toEqual([b.id, a.id]);
    store.undo();
    expect(scenesOf(store)).toEqual([a, b]);
  });
});

describe('portable board files', () => {
  const path = '/api/boards/A/assets/B';
  const asset = { id: 'asset:a', typeName: 'asset' as const, w: 5, h: 5, src: path };
  const image = {
    id: 'shape:a',
    typeName: 'shape' as const,
    type: 'image' as const,
    x: 0,
    y: 0,
    z: 1,
    rot: 0,
    props: { w: 5, h: 5, assetId: asset.id },
  };
  const archive = {
    format: 'folio.board' as const,
    version: 1 as const,
    title: '画板',
    items: { [image.id]: image, [asset.id]: asset },
    resources: [{ path, name: 'a.png', type: 'image/png', base64: 'AQ==' }],
  };
  test('accepts a complete archive and rejects missing, external, and duplicate resources', () => {
    expect(parseArchive(JSON.stringify(archive))).toEqual(archive);
    for (const resources of [
      [],
      [archive.resources[0], archive.resources[0]],
      [{ ...archive.resources[0], path: 'https://example.org/x' }],
    ]) {
      expect(() => parseArchive(JSON.stringify({ ...archive, resources }))).toThrow();
    }
    expect(() =>
      parseArchive(JSON.stringify({ ...archive, items: { [image.id]: image }, resources: [] })),
    ).toThrow();
  });
  test('chunks operations at 4096 records', () => {
    const items: Record<string, BoardRecord> = {};
    for (let i = 0; i < 4097; i++) items[String(i)] = { ...image, id: String(i) };
    expect([...chunkItems(items)].map((group) => Object.keys(group).length)).toEqual([4096, 1]);
  });
});

test('limits raster dimensions even for extreme aspect ratios', () => {
  expect(exportSize({ x: 0, y: 0, w: 10000000, h: 1 })).toEqual({ width: 3072, height: 1 });
  const square = exportSize({ x: 0, y: 0, w: 10000, h: 10000 });
  expect(square.width).toBeLessThanOrEqual(2450);
});

import { replaceText, searchBoard } from './find';

test('literal, case-insensitive matches, targeted replacement, locked and noneditable fields', () => {
  const store = new Store();
  const record = { typeName: 'shape' as const, type: 'text' as const, x: -10, y: 20, z: 1, rot: 0 };
  store.put({ ...record, id: 'shape:a', props: { text: 'A.B  a.b', description: 'a.b' } });
  store.put({ ...record, id: 'shape:b', props: { text: 'a.b', locked: true } });
  store.put({
    ...record,
    id: 'shape:c',
    type: 'geo',
    props: {
      w: 120,
      h: 60,
      kind: 'table',
      cells: [
        ['a.b', 'x'],
        ['xaB', 'A.b'],
      ],
    },
  });
  store.put({
    ...record,
    id: 'shape:d',
    props: { url: 'https://a.b', attachment: { name: 'a.b' } },
  });
  expect(searchBoard(store, 'a.b').total).toBe(8);
  expect(searchBoard(store, 'a.b').editable).toBe(5);
  expect(replaceText(store, 'a.b', '$&', 1)).toBe(1);
  expect(searchBoard(store, '$&').total).toBe(1);
  expect(replaceText(store, 'a.b', '鸟')).toBe(4);
  expect(searchBoard(store, 'a.b').total).toBe(3);
  store.undo();
  expect(searchBoard(store, 'a.b').total).toBe(7);
  expect(() => replaceText(store, 'a.b', '长'.repeat(1500))).toThrow();
  expect(searchBoard(store, 'a.b').total).toBe(7);
});
