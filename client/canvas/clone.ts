import { newId, type AssetRecord, type ShapeRecord } from '@quickdrawjs/core';
import { validRecord } from '../../server/records';
import { BoardStore } from './store';

export interface ClipboardData {
  shapes: ShapeRecord[];
  assets?: Record<string, AssetRecord>;
}

/** Duplicates a selection as an independent subgraph. External anchors detach;
 * cloned groups, internal connectors, and asset references stay together. */
export function cloneSelection(store: BoardStore, data: ClipboardData, offset: number) {
  const shapes = data.shapes.filter((s) => s?.typeName === 'shape' && validRecord(s.id, s));
  const ids = new Map(shapes.map((s) => [s.id, newId()]));
  const assets = new Map<string, string>(),
    groups = new Map<string, string>();
  let z = store.maxZ();
  store.transact(() => {
    for (const a of Object.values(data.assets ?? {})) {
      if (a?.typeName !== 'asset' || !validRecord(a.id, a)) continue;
      const id = newId('asset');
      assets.set(a.id, id);
      store.put({ ...a, id });
    }
    for (const s of shapes) {
      const props = { ...s.props };
      if (props.assetId) props.assetId = assets.get(props.assetId) ?? props.assetId;
      if (props.groupId) {
        if (!groups.has(props.groupId)) groups.set(props.groupId, newId('group'));
        props.groupId = groups.get(props.groupId);
      }
      if (props.bindings) {
        props.bindings = {};
        for (const name of ['start', 'end']) {
          const anchor = s.props.bindings[name],
            target = ids.get(anchor?.id);
          if (target) props.bindings[name] = { ...anchor, id: target };
        }
      }
      store.put({ ...s, props, id: ids.get(s.id)!, x: s.x + offset, y: s.y + offset, z: ++z });
    }
  });
  return [...ids.values()];
}

/** A board's viewers may lack access to the source. The server checks both
 * grants and atomically adopts the blob into the destination before insertion. */
export async function adoptClipboardFiles(
  data: ClipboardData,
  boardId?: string,
): Promise<ClipboardData> {
  if (!boardId) return data;
  const prefix = '/api/boards/' + encodeURIComponent(boardId) + '/assets/',
    migrated = new Map<string, string>();
  const paths = new Set<string>();
  for (const a of Object.values(data.assets ?? {})) if (a?.src) paths.add(a.src);
  for (const s of data.shapes) if (s?.props?.attachment?.url) paths.add(s.props.attachment.url);
  for (const url of paths) {
    if (!/^\/api\/boards\/[\w-]+\/assets\/[\w-]+$/.test(url) || url.startsWith(prefix)) continue;
    const res = await fetch(prefix + 'adopt', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error('Attachment adoption failed');
    const to = (await res.json()) as { url: string };
    if (!to.url.startsWith(prefix)) throw new Error('Invalid adopted asset');
    migrated.set(url, to.url);
  }
  if (!migrated.size) return data;
  const assets = Object.fromEntries(
    Object.entries(data.assets ?? {}).map(([id, a]) => [
      id,
      { ...a, src: migrated.get(a.src) ?? a.src },
    ]),
  );
  const shapes = data.shapes.map((s) => {
    const attachment = s.props.attachment;
    return attachment && migrated.has(attachment.url)
      ? {
          ...s,
          props: { ...s.props, attachment: { ...attachment, url: migrated.get(attachment.url) } },
        }
      : s;
  });
  return { assets, shapes };
}
