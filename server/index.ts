import { resolve, sep, extname } from 'node:path';
import { createApp } from './app';
import { BoardStore } from './database';
import { BoardEvents } from './events';
import { MAX_ASSET_BYTES } from './protocol';

const store = new BoardStore(process.env.FOLIO_DB || './data/folio.sqlite');
const events = new BoardEvents();
const app = createApp(store, events);
const webRoot = resolve(process.env.STATIC_DIR || 'dist');

app.get('*', async (c) => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return c.text('Invalid path', 400);
  }
  if (pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.')))
    return c.notFound();
  const path = resolve(webRoot, '.' + pathname);
  if (path !== webRoot && !path.startsWith(webRoot + sep)) return c.notFound();
  let file = Bun.file(path);
  if (path === webRoot || !(await file.exists())) {
    if (extname(pathname)) return c.notFound();
    file = Bun.file(resolve(webRoot, 'index.html'));
    if (!(await file.exists())) return c.notFound();
  }
  return new Response(file, {
    headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
  });
});

const server = Bun.serve({
  hostname: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  fetch: app.fetch,
  maxRequestBodySize: MAX_ASSET_BYTES + 1024,
  idleTimeout: 120,
});
console.log(`Folio listening at ${server.url}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  events.close();
  await server.stop(false);
  store.close();
}

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
