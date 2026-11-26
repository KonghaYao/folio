import type { Context, Hono } from 'hono';
import type { BoardStore } from './database';
import { LibraryStore, type BoardPreferences } from './library-store';
import { ApiError, parseTitle, type JsonObject } from './protocol';
import type { SessionEnv } from './session';

export { initializeLibrary } from './library-store';

function readBoolean(body: JsonObject, key: string): boolean | undefined {
  const value = body[key];
  if (value !== undefined && typeof value !== 'boolean')
    throw new ApiError(400, 'invalid_library_change');
  return value;
}

export function installLibraryRoutes(
  app: Hono<SessionEnv>,
  store: BoardStore,
  jsonBody: (c: Context, limit?: number) => Promise<JsonObject>,
): void {
  const library = new LibraryStore(store.db);
  app.get('/api/library', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length > 120) throw new ApiError(400, 'search_too_long');
    return c.json(library.read(c.get('principal'), q));
  });
  app.post('/api/library/folders', async (c) => {
    const body = await jsonBody(c);
    return c.json(library.createFolder(c.get('principal'), parseTitle(body.name)), 201);
  });
  app.patch('/api/library/folders/:id', async (c) => {
    const body = await jsonBody(c);
    const patch = {
      name: body.name === undefined ? undefined : parseTitle(body.name),
      trashed: readBoolean(body, 'trashed'),
    };
    if (patch.name === undefined && patch.trashed === undefined)
      throw new ApiError(400, 'invalid_library_change');
    library.updateFolder(c.get('principal'), c.req.param('id'), patch);
    return c.body(null, 204);
  });
  app.patch('/api/library/boards/:id', async (c) => {
    const body = await jsonBody(c);
    const patch: BoardPreferences = {};
    if (body.favorite !== undefined) patch.favorite = readBoolean(body, 'favorite');
    if (body.trashed !== undefined) patch.trashed = readBoolean(body, 'trashed');
    if (body.folderId !== undefined) {
      if (
        body.folderId !== null &&
        (typeof body.folderId !== 'string' || !body.folderId || body.folderId.length > 80)
      ) {
        throw new ApiError(400, 'invalid_folder_id');
      }
      patch.folderId = body.folderId;
    }
    if (!Object.keys(patch).length) throw new ApiError(400, 'invalid_library_change');
    library.setPreferences(c.get('principal'), c.req.param('id'), patch);
    return c.body(null, 204);
  });
}
