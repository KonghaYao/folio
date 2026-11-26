import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Package the exact font maps and image decoders that match the parser worker.
 * Resources are same-origin, requested only for documents that use them. */
export function pdfResources(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const version: string = require('pdfjs-dist/package.json').version;
  const prefix = 'pdf-resources/' + version + '/';
  const resources = new Map<string, string>();
  for (const directory of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
    for (const file of readdirSync(join(root, directory))) {
      // The canvas preview never loads the optional JavaScript sandbox.
      if (file.toLowerCase().includes('quickjs')) continue;
      resources.set(prefix + directory + '/' + file, join(root, directory, file));
    }
  }
  return {
    name: 'folio-pdf-resources',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = resources.get((req.url ?? '').slice(1));
        if (!path) {
          next();
          return;
        }
        res.setHeader(
          'Content-Type',
          path.endsWith('.wasm')
            ? 'application/wasm'
            : path.endsWith('.js')
              ? 'text/javascript'
              : 'application/octet-stream',
        );
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const [fileName, path] of resources)
        this.emitFile({ type: 'asset', fileName, source: readFileSync(path) });
    },
  };
}
