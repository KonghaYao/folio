import { cp, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// The Emscripten loader imports the Turso shim relative to itself, and opens
// the native wasm binary at runtime. All three upstream files travel together.
const source = new URL('./wasm/', import.meta.resolve('@peri-code/sdk'));
const destination = new URL('../service/runtime/', import.meta.url);
const assets = {
  'peri-wasm.js': 'cb995e9c30f7d2b0a45db7839a456fcf3c3f2875d0606acc6a5aa6b46f745699',
  'peri_wasm.wasm': 'e941e18a2b099c025fd0a82de811583728491d7de949fa3a1dbf04b7e30041cb',
  'snippets/turso_serverless-ab30c6ece8fbcf33/inline0.js':
    '4a023493c312bb75142286047ef85081f19660784e643d80fdce22f36f3c81a3',
};
for (const [name, expected] of Object.entries(assets)) {
  const origin = new URL(name, source);
  const target = new URL(name, destination);
  const digest = createHash('sha256')
    .update(await readFile(origin))
    .digest('hex');
  if (digest !== expected) throw new Error('Unexpected @peri-code/sdk 0.5.0 artifact: ' + name);
  await mkdir(new URL('.', target), { recursive: true });
  await cp(origin, target);
}
