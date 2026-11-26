import { newId } from '@quickdrawjs/core';
import type { BoardRecord, Bounds, Camera, Editor, Store } from '@quickdrawjs/core';

export interface Scene {
  id: string;
  typeName: 'scene';
  title: string;
  order: number;
  bounds: Bounds;
}

export function isScene(value: unknown): value is Scene {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Scene>;
  const b = item.bounds;
  return (
    item.typeName === 'scene' &&
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    Number.isFinite(item.order) &&
    !!b &&
    [b.x, b.y, b.w, b.h].every(Number.isFinite) &&
    b.w > 0 &&
    b.h > 0
  );
}

export function scenesOf(store: Store): Scene[] {
  const records: unknown[] = store.all();
  return records.filter(isScene).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// The Folio editor uses a Store subclass whose shape index excludes scene metadata.
// The upstream store accepts document records at runtime but declares only shapes/assets.
export function saveScene(store: Store, scene: Scene): void {
  store.put(scene as unknown as BoardRecord);
}

export function createScene(editor: Editor, title: string): Scene {
  const previous = scenesOf(editor.store).at(-1);
  const scene: Scene = {
    id: 'scene:' + newId('view'),
    typeName: 'scene',
    title: title.trim().slice(0, 120) || '未命名场景',
    order: (previous?.order ?? -1) + 1,
    bounds: editor.viewportPageBounds(),
  };
  saveScene(editor.store, scene);
  return scene;
}

export function swapScenes(store: Store, first: Scene, second: Scene): void {
  const scenes = scenesOf(store);
  const a = scenes.findIndex((scene) => scene.id === first.id);
  const b = scenes.findIndex((scene) => scene.id === second.id);
  if (a < 0 || b < 0 || a === b) return;
  [scenes[a], scenes[b]] = [scenes[b], scenes[a]];
  // Ranks may coincide after concurrent appends. Normalize only when reordering.
  store.transact(() =>
    scenes.forEach((scene, order) => {
      if (scene.order !== order) saveScene(store, { ...scene, order });
    }),
  );
}

export function cameraFor(bounds: Bounds, width: number, height: number): Camera {
  const z = Math.min(width / bounds.w, height / bounds.h);
  return {
    z,
    x: width / (2 * z) - bounds.x - bounds.w / 2,
    y: height / (2 * z) - bounds.y - bounds.h / 2,
  };
}

export function goToScene(editor: Editor, scene: Scene): void {
  const { w, h } = editor.viewSize();
  editor.setCamera(cameraFor(scene.bounds, w, h));
}

export function boardBounds(editor: Editor): Bounds {
  const bounds = editor.contentBounds();
  if (!bounds) return editor.viewportPageBounds();
  const margin = Math.max(24, Math.min(100, Math.max(bounds.w, bounds.h) * 0.045));
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    w: bounds.w + 2 * margin,
    h: bounds.h + 2 * margin,
  };
}
