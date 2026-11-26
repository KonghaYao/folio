import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** The SW ships a complete, immutable shell. Board APIs and uploaded media stay outside it. */
export function offlineShell(): Plugin {
  return {
    name: 'folio-offline-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const hash = createHash('sha256');
        const shell = Object.keys(bundle)
          .sort()
          .filter((file) => !file.endsWith('.map'));
        for (const name of shell) {
          const output = bundle[name]!;
          hash.update(name).update(output.type === 'chunk' ? output.code : output.source);
        }
        const icon = 'folio.svg';
        hash.update(readFileSync(new URL('../public/' + icon, import.meta.url)));
        const cache = 'folio-shell-' + hash.digest('hex').slice(0, 20);
        const paths = [
          '/index.html',
          ...shell.filter((f) => f !== 'index.html').map((f) => '/' + f),
          '/' + icon,
        ];
        // Optional PDF workers and language resources are cached on first use.
        // A browser opening an empty drawing need not fetch hundreds of CMaps.
        const initial = paths.filter(
          (path) =>
            !path.startsWith('/pdf-resources/') &&
            !/^\/assets\/pdf(?:-preview|\.worker)[.-]/.test(path),
        );
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: `
const cacheName = ${JSON.stringify(cache)}
const paths = ${JSON.stringify(paths)}
const initial = ${JSON.stringify(initial)}
const known = new Set(paths)
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
    initial.map(path => new Request(path, {cache: 'reload'}))
  )))
})
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('folio-shell-') && key !== cacheName) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})
self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  const path = request.mode === 'navigate' ? '/index.html' : url.pathname
  if (!known.has(path)) return
  event.respondWith(caches.open(cacheName).then(async cache => {
    const cached=await cache.match(path)
    if(cached)return cached
    const response=await fetch(request)
    if(response.ok)await cache.put(path,response.clone())
    return response
  }))
})
`,
        });
      },
    },
  };
}
