import { existsSync } from 'node:fs';

// Production's standalone service places the Emscripten factory beside its
// entrypoint. Source checkouts use the artifact in the locked SDK installation.
const shipped = new URL('./runtime/peri-wasm.js', import.meta.url);
export const periModuleUrl = existsSync(shipped)
  ? shipped
  : new URL('./wasm/peri-wasm.js', import.meta.resolve('@peri-code/sdk'));
