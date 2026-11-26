import type { BoardRecord, Store } from '@quickdrawjs/core';
import { validRecord } from '../../server/records';
import {
  MAX_ASSET_BYTES,
  MAX_BOARD_ASSET_BYTES,
  MAX_BOARD_BYTES,
  MAX_MUTATION_BYTES,
} from '../../server/protocol';

type Items = Record<string, BoardRecord>;
interface Resource {
  path: string;
  name: string;
  type: string;
  base64: string;
}
interface Archive {
  format: 'folio.board';
  version: 1;
  title: string;
  items: Items;
  resources: Resource[];
}

const assetPath = /^\/api\/boards\/[\w-]+\/assets\/[\w-]+$/;
const encodedLimit = 4 * Math.ceil(MAX_ASSET_BYTES / 3);
export const archiveLimit = MAX_BOARD_BYTES + MAX_BOARD_ASSET_BYTES * 1.4 + 1024 * 1024;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface FileInfo {
  name: string;
  type?: string;
}
function findResources(items: Items): Map<string, FileInfo> {
  const paths = new Map<string, FileInfo>();
  for (const item of Object.values(items)) {
    if (item.typeName === 'asset' && assetPath.test(item.src) && !paths.has(item.src))
      paths.set(item.src, { name: 'image' });
    if (item.typeName === 'shape' && item.props.attachment) {
      const { url, name, mime } = item.props.attachment;
      if (typeof url === 'string' && assetPath.test(url))
        paths.set(url, { name: String(name), type: String(mime) });
    }
  }
  return paths;
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取附件'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(blob);
  });
}

export async function makeArchive(
  store: Store,
  title: string,
  boardId: string,
  readAsset: (path: string) => Promise<Blob>,
): Promise<Blob> {
  const items = store.getSnapshot().document.store;
  const resources: Resource[] = [];
  const prefix = '/api/boards/' + encodeURIComponent(boardId) + '/assets/';
  for (const [path, info] of findResources(items)) {
    if (!path.startsWith(prefix)) throw new Error('附件不属于当前画板');
    const blob = await readAsset(path);
    resources.push({
      path,
      name: info.name,
      type: info.type || blob.type,
      base64: await base64Of(blob),
    });
  }
  const archive: Archive = { format: 'folio.board', version: 1, title, items, resources };
  return new Blob([JSON.stringify(archive)], { type: 'application/json' });
}

export function parseArchive(raw: string): Archive {
  const data: unknown = JSON.parse(raw);
  if (
    !isObject(data) ||
    data.format !== 'folio.board' ||
    data.version !== 1 ||
    typeof data.title !== 'string' ||
    !isObject(data.items) ||
    !Array.isArray(data.resources) ||
    !Object.entries(data.items).every(([key, value]) => validRecord(key, value))
  ) {
    throw new Error('文件格式或画板内容无效');
  }
  const items = data.items as Items;
  const references = findResources(items);
  const resources: Resource[] = [];
  let totalBytes = 0;
  for (const value of data.resources) {
    if (
      !isObject(value) ||
      typeof value.path !== 'string' ||
      !references.delete(value.path) ||
      typeof value.name !== 'string' ||
      typeof value.type !== 'string' ||
      typeof value.base64 !== 'string' ||
      value.base64.length > encodedLimit ||
      value.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)
    )
      throw new Error('附件索引无效');
    const bytes =
      (value.base64.length / 4) * 3 -
      (value.base64.endsWith('==') ? 2 : value.base64.endsWith('=') ? 1 : 0);
    totalBytes += bytes;
    if (bytes > MAX_ASSET_BYTES || totalBytes > MAX_BOARD_ASSET_BYTES)
      throw new Error('附件超过画板限额');
    resources.push({ path: value.path, name: value.name, type: value.type, base64: value.base64 });
  }
  if (references.size) throw new Error('副本缺少附件');
  for (const item of Object.values(items)) {
    if (
      item.typeName === 'shape' &&
      item.type === 'image' &&
      items[item.props.assetId]?.typeName !== 'asset'
    )
      throw new Error('图片缺少资源');
  }
  return { format: 'folio.board', version: 1, title: data.title, items, resources };
}

export function relocate(items: Items, urls: Map<string, string>): Items {
  const out: Items = Object.create(null);
  for (const item of Object.values(items)) {
    if (item.typeName === 'asset' && urls.has(item.src)) {
      out[item.id] = { ...item, src: urls.get(item.src)! };
    } else if (item.typeName === 'shape' && urls.has(item.props.attachment?.url)) {
      const attachment = { ...item.props.attachment, url: urls.get(item.props.attachment.url)! };
      out[item.id] = { ...item, props: { ...item.props, attachment } };
    } else out[item.id] = item;
  }
  return out;
}

export function* chunkItems(items: Items): Generator<Items> {
  let batch: Items = Object.create(null);
  let count = 0;
  let bytes = 0;
  for (const [key, value] of Object.entries(items)) {
    const size = new Blob([JSON.stringify(value), JSON.stringify(key)]).size + 2;
    if (size > MAX_MUTATION_BYTES - 256) throw new Error('单个对象超过服务端大小限制');
    if (count && (bytes + size > MAX_MUTATION_BYTES - 256 || count === 4096)) {
      yield batch;
      batch = Object.create(null);
      count = bytes = 0;
    }
    batch[key] = value;
    count++;
    bytes += size;
  }
  if (count) yield batch;
}
