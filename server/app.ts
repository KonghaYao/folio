import { Hono, type Context } from 'hono';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { AgentTurn } from '../shared/chat';
import { installChatRoutes } from './chat/routes';
import { BoardStore } from './database';
import { BoardEvents } from './events';
import { clientKey } from './presence';
import { installLibraryRoutes } from './library';
import {
  ApiError,
  MAX_ASSET_BYTES,
  MAX_MUTATION_BYTES,
  isObject,
  parseMutation,
  parseShareRole,
  parseTitle,
} from './protocol';
import { session, type SessionEnv } from './session';

const compress = promisify(gzip);
function acceptsGzip(header = '') {
  return header.split(',').some((entry) => {
    const [encoding, quality] = entry
      .trim()
      .toLowerCase()
      .split(/\s*;\s*/);
    return (
      encoding === 'gzip' &&
      (quality === undefined ||
        (/^q=(?:1(?:\.0{0,3})?|0\.\d{1,3})$/.test(quality) && Number(quality.slice(2)) > 0))
    );
  });
}

async function boundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('Content-Length')) > limit)
    throw new ApiError(413, 'request_too_large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, 'request_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function jsonBody(c: Context, limit = 8192) {
  const bytes = await boundedBody(c.req.raw, limit);
  c.get('validateSession')();
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isObject(data)) return data;
  } catch {
    /* Return a consistent protocol error. */
  }
  throw new ApiError(400, 'invalid_json_object');
}

const inlineTypes = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

export function createApp(
  store: BoardStore,
  events = new BoardEvents(),
  runAgent?: (turn: AgentTurn) => Promise<void>,
) {
  const app = new Hono<SessionEnv>();
  app.onError((error, c) => {
    if (error instanceof ApiError)
      return c.json({ error: error.code, ...error.details }, error.status);
    console.error('Unhandled board request error', error);
    return c.json({ error: 'internal_error' }, 500);
  });
  app.get('/api/health', (c) => {
    store.db.query('SELECT 1').get();
    return c.json({ status: 'ok' });
  });
  app.use('/api/*', session(store.devices));
  app.get('/api/devices/linked', (c) =>
    c.json(store.devices.linked(c.get('device'), c.get('principal'))),
  );
  app.delete('/api/devices/linked/:handle', (c) => {
    const principal = c.get('principal');
    const removed = store.devices.unlink(c.get('device'), principal, c.req.param('handle'));
    events.disconnect(removed, principal);
    return c.body(null, 204);
  });
  app.get('/api/devices/workspaces', (c) => c.json(store.devices.list(c.get('device'))));
  app.post('/api/devices/pair', (c) => c.json(store.devices.pair(c.get('principal')), 201));
  app.post('/api/devices/claim', async (c) => {
    const { token } = await jsonBody(c);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ApiError(400, 'invalid_token');
    const device = c.get('device'),
      previous = c.get('principal');
    const result = store.devices.claim(device, token);
    if (store.devices.principal(device) !== previous) events.disconnect(device, previous);
    return c.json(result);
  });
  app.post('/api/devices/switch', async (c) => {
    const { workspaceId } = await jsonBody(c);
    if (typeof workspaceId !== 'string') throw new ApiError(400, 'invalid_workspace');
    const device = c.get('device'),
      previous = c.get('principal');
    const result = store.devices.switch(device, workspaceId);
    if (store.devices.principal(device) !== previous) events.disconnect(device, previous);
    return c.json(result);
  });
  app.get('/api/boards', (c) => c.json({ boards: store.list(c.get('principal')) }));
  app.post('/api/boards', async (c) => {
    const body = await jsonBody(c);
    return c.json(
      store.create(parseTitle(body.title ?? 'Untitled board'), c.get('principal')),
      201,
    );
  });
  const boardDocument = async (c: Context<SessionEnv>, since?: number) => {
    const bytes = store.readDocument(c.req.param('id')!, c.get('principal'), since);
    c.header('Content-Type', 'application/json');
    c.header('Vary', 'Accept-Encoding');
    if (bytes.byteLength < 32 * 1024 || !acceptsGzip(c.req.header('Accept-Encoding'))) {
      return c.body(bytes);
    }
    // Compress large snapshots off the JS thread; ordinary incremental updates stay cheap.
    c.header('Content-Encoding', 'gzip');
    return c.body(await compress(bytes, { level: 1 }));
  };
  app.get('/api/boards/:id', (c) => boardDocument(c));
  app.get('/api/boards/:id/changes', (c) => {
    const raw = c.req.query('since');
    const since = Number(raw);
    if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(since))
      throw new ApiError(400, 'invalid_revision');
    return boardDocument(c, since);
  });
  app.patch('/api/boards/:id', async (c) => {
    const body = await jsonBody(c);
    const board = store.rename(c.req.param('id'), c.get('principal'), parseTitle(body.title));
    events.publish(board.id, { rev: board.rev, kind: 'title' });
    return c.json(board);
  });
  app.delete('/api/boards/:id', (c) => {
    const id = c.req.param('id');
    const rev = store.delete(id, c.get('principal'));
    events.publish(id, { rev, kind: 'deleted' });
    events.presence.clear(id);
    return c.body(null, 204);
  });
  app.post('/api/boards/:id/ops', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');
    store.board(id, principal, 'write');
    const result = store.apply(id, principal, parseMutation(await jsonBody(c, MAX_MUTATION_BYTES)));
    if (!result.duplicate) events.publish(id, { rev: result.rev, kind: 'items' });
    return c.json(result);
  });
  app.post('/api/boards/:id/presence', async (c) => {
    const id = c.req.param('id'),
      principal = c.get('principal');
    const body = await jsonBody(c, 1024);
    const { role } = store.board(id, principal);
    return c.json(events.presence.update(id, c.get('device'), principal, role, body));
  });
  app.delete('/api/boards/:id/presence/:tab', (c) => {
    const id = c.req.param('id');
    store.board(id, c.get('principal'));
    events.presence.leave(id, c.get('device'), clientKey(c.req.param('tab')));
    return c.body(null, 204);
  });
  app.get('/api/boards/:id/events', (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');
    const device = c.get('device');
    const current = () => {
      if (store.devices.principal(device) !== principal)
        throw new ApiError(403, 'inactive_workspace');
      return store.board(id, principal).rev;
    };
    return events.open(id, current(), c.req.raw.signal, current, device, principal);
  });
  app.get('/api/boards/:id/share', (c) =>
    c.json({ invitations: store.links(c.req.param('id'), c.get('principal')) }),
  );
  app.delete('/api/boards/:id/share/:invitation', (c) => {
    const id = c.req.param('id');
    const rev = store.revoke(id, c.get('principal'), c.req.param('invitation'));
    events.publish(id, { rev, kind: 'access' });
    events.presence.prune(id, (principal) => {
      try {
        store.board(id, principal);
        return true;
      } catch {
        return false;
      }
    });
    return c.body(null, 204);
  });
  app.post('/api/boards/:id/share', async (c) => {
    const body = await jsonBody(c);
    return c.json(
      store.invite(c.req.param('id'), c.get('principal'), parseShareRole(body.role)),
      201,
    );
  });
  app.post('/api/join', async (c) => {
    const { token } = await jsonBody(c);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ApiError(400, 'invalid_token');
    return c.json(store.join(token, c.get('principal')));
  });
  app.post('/api/boards/:id/assets', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');
    store.board(id, principal, 'write');
    const bytes = await boundedBody(c.req.raw, MAX_ASSET_BYTES);
    c.get('validateSession')();
    if (!bytes.length) throw new ApiError(400, 'empty_asset');
    const name = (c.req.query('name') || 'Attachment')
      .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
      .slice(0, 200);
    const type =
      (c.req.header('Content-Type') || 'application/octet-stream')
        .split(';')[0]
        ?.trim()
        .toLowerCase() || 'application/octet-stream';
    const safeType =
      /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) && type.length < 128
        ? type
        : 'application/octet-stream';
    const asset = store.attach(id, principal, name, safeType, bytes);
    return c.json({ ...asset, url: `/api/boards/${id}/assets/${asset.id}` }, 201);
  });
  app.post('/api/boards/:id/assets/adopt', async (c) => {
    const id = c.req.param('id');
    const { url } = await jsonBody(c);
    const source =
      typeof url === 'string' && /^\/api\/boards\/([\w-]+)\/assets\/([\w-]+)$/.exec(url);
    if (!source) throw new ApiError(400, 'invalid_asset_url');
    const asset = store.adopt(id, c.get('principal'), source[1], source[2]);
    return c.json({ ...asset, url: `/api/boards/${id}/assets/${asset.id}` });
  });
  app.get('/api/boards/:id/assets/:asset', (c) => {
    const board = c.req.param('id'),
      principal = c.get('principal');
    const asset = store.asset(board, principal, c.req.param('asset'));
    const read = (offset: number, size: number) =>
      store.assetBytes(board, principal, asset.id, offset, size);
    const inline = inlineTypes.has(asset.type);
    const headers: Record<string, string> = {
      'Content-Type': inline ? asset.type : 'application/octet-stream',
      'Content-Length': String(asset.size),
      'Accept-Ranges': 'bytes',
      'X-Asset-Type': asset.type,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(new TextDecoder().decode(new TextEncoder().encode(asset.name))).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16))}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store',
    };
    const range = c.req.header('Range');
    if (!range) return c.body(read(0, asset.size), 200, headers);
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, asset.size - Number(match?.[2]));
    const end =
      match?.[1] && match[2] ? Math.min(Number(match[2]), asset.size - 1) : asset.size - 1;
    if (
      !match ||
      !(match[1] || match[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= asset.size
    ) {
      return c.body(null, 416, { 'Content-Range': `bytes */${asset.size}` });
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${asset.size}`;
    headers['Content-Length'] = String(end - start + 1);
    return c.body(read(start, end - start + 1), 206, headers);
  });
  installLibraryRoutes(app, store, jsonBody);
  installChatRoutes(app, store, jsonBody, runAgent);
  app.all('/api/*', (c) => c.json({ error: 'route_not_found' }, 404));
  return app;
}
