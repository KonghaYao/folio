import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pageBounds, type ShapeRecord } from '@quickdrawjs/core';
import type { BoardCanvas } from '../canvas';
import { createShape, shapeContent, summarize, updateShape } from './records';
import { schemas, tools, type ToolName } from './schemas';
import { BrowserTransport } from './transport';
import { createShapeQuery, selectionSummary } from './read';

export interface CanvasMcpOptions {
  boardId: string;
  canvas: Pick<BoardCanvas, 'editor' | 'store'>;
  flush(): Promise<void>;
  isActive?(): boolean;
}
const writeTools = new Set<string>(['canvas_create', 'canvas_update', 'canvas_delete']);
const compact = (shape: ShapeRecord) => ({
  id: shape.id,
  kind: summarize(shape).kind,
  x: shape.x,
  y: shape.y,
});
export async function createCanvasMcp({ boardId, canvas, flush, isActive }: CanvasMcpOptions) {
  const { store, editor } = canvas;
  const queryShapes = createShapeQuery(store);
  const server = new Server(
    { name: 'folio-canvas', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const transport = new BrowserTransport();
  let closed = false;
  function active() {
    if (closed || editor.disposed || editor.boardId !== boardId || (isActive && !isActive()))
      throw new Error('This board is no longer open for this chat.');
  }
  function mayWrite() {
    active();
    if (editor.readonly) throw new Error('View-only access. This canvas cannot be edited.');
  }
  function shapeOf(id: string): ShapeRecord {
    const s = store.get(id);
    if (s?.typeName !== 'shape') throw new Error('Unknown object ID: ' + id);
    return s;
  }
  function editable(id: string) {
    const s = shapeOf(id);
    if (s.props.locked) throw new Error('Object is locked: ' + id);
    return s;
  }
  function unique(ids: string[]) {
    if (new Set(ids).size !== ids.length)
      throw new Error('Each object may appear only once in a batch.');
  }
  async function commit(action: () => void) {
    mayWrite();
    if (editor.session || editor.editing)
      throw new Error(
        'The user has an active canvas gesture or text edit. Retry after it finishes.',
      );
    store.transact(action);
    try {
      await flush();
    } catch {
      mayWrite();
      return 'local-pending';
    }
    mayWrite();
    return 'synced';
  }
  const viewport = () => ({ ...editor.viewportPageBounds(), zoom: editor.camera.z });
  const inspect = (shape: ShapeRecord) => ({ ...summarize(shape), bounds: pageBounds(shape) });
  async function run(name: ToolName, args: unknown) {
    active();
    if (writeTools.has(name)) mayWrite();
    switch (name) {
      case 'canvas_read': {
        const {
          scope = 'all',
          ids,
          query = '',
          detailOffset,
          offset = 0,
          limit = 25,
        } = schemas.canvas_read.parse(args);
        const rect = viewport();
        if (detailOffset !== undefined && ids?.length !== 1)
          throw new Error('detailOffset requires exactly one object ID.');
        const { matched, page } = queryShapes(
          scope,
          ids,
          query,
          editor.selection,
          rect,
          offset,
          limit,
        );
        return {
          boardId,
          viewport: rect,
          ...selectionSummary(editor.selection),
          matched,
          offset,
          hasMore: offset + limit < matched,
          objects: page.map((s) => ({
            ...inspect(s),
            ...(ids?.length === 1 ? { content: shapeContent(s, detailOffset ?? 0) } : {}),
          })),
        };
      }
      case 'canvas_create': {
        const { objects } = schemas.canvas_create.parse(args);
        const aliases = new Map<string, ShapeRecord>(),
          base = store.maxZ() + 1;
        const plan = objects.map((a, i) => {
          try {
            if (a.key && (aliases.has(a.key) || store.has(a.key)))
              throw new Error('Ambiguous object key: ' + a.key);
            const record = createShape(a, base + i, (id) => aliases.get(id) ?? shapeOf(id));
            if (a.key) aliases.set(a.key, record);
            return record;
          } catch (error) {
            const label = 'objects[' + i + '] ' + a.kind + (a.key ? ' (key ' + a.key + ')' : '');
            throw new Error(
              label + ': ' + (error instanceof Error ? error.message : 'Invalid object.'),
            );
          }
        });
        const sync = await commit(() => {
          for (const s of plan) store.put(s);
        });
        return { created: plan.map((s, i) => ({ ...compact(s), key: objects[i].key })), sync };
      }
      case 'canvas_update': {
        const { changes } = schemas.canvas_update.parse(args);
        unique(changes.map((c) => c.id));
        const plan = changes.map((c, i) => {
          const shape = editable(c.id);
          try {
            return updateShape(shape, c);
          } catch (error) {
            throw new Error(
              'changes[' +
                i +
                '] ' +
                summarize(shape).kind +
                ' (' +
                c.id +
                '): ' +
                (error instanceof Error ? error.message : 'Invalid change.'),
            );
          }
        });
        // Update connectors first, so native reflow from jointly moved endpoints wins.
        plan.sort((a, b) => Number(Boolean(b.props.bindings)) - Number(Boolean(a.props.bindings)));
        const sync = await commit(() => {
          for (const s of plan) store.put(s);
        });
        return { updated: plan.map((s) => compact(shapeOf(s.id))), sync };
      }
      case 'canvas_delete': {
        const { ids } = schemas.canvas_delete.parse(args);
        unique(ids);
        ids.forEach(editable);
        const sync = await commit(() => store.remove(ids));
        return { deleted: ids, sync };
      }
      case 'canvas_select': {
        const { ids } = schemas.canvas_select.parse(args);
        ids.forEach(shapeOf);
        editor.setSelection(ids);
        return selectionSummary(editor.selection);
      }
      case 'canvas_view': {
        const { mode, x, y, zoom } = schemas.canvas_view.parse(args);
        if (mode === 'fit') editor.fitContent({ margin: 0.1, maxZoom: 1 });
        else if (mode === 'selection') {
          const b = editor.selectionBounds();
          if (!b) throw new Error('Select at least one object before fitting the selection.');
          editor.followBounds({
            x: b.x - b.w * 0.07 - 4,
            y: b.y - b.h * 0.07 - 4,
            w: b.w * 1.14 + 8,
            h: b.h * 1.14 + 8,
          });
        } else {
          if (x === undefined || y === undefined) throw new Error('Center needs both x and y.');
          const size = editor.viewSize(),
            z = zoom ?? editor.camera.z;
          editor.setCamera({ x: size.w / (2 * z) - x, y: size.h / (2 * z) - y, z });
        }
        return { viewport: viewport() };
      }
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, () => {
    active();
    return { tools: editor.readonly ? tools.filter((t) => !writeTools.has(t.name)) : tools };
  });
  let tail: Promise<unknown> = Promise.resolve();
  server.setRequestHandler(CallToolRequestSchema, ({ params }, { signal }) => {
    const perform = async () => {
      try {
        signal.throwIfAborted();
        if (!Object.hasOwn(schemas, params.name)) throw new Error('Unknown canvas tool.');
        const result = await run(params.name as ToolName, params.arguments ?? {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: (error instanceof Error ? error.message : 'Canvas operation failed.').slice(
                0,
                2048,
              ),
            },
          ],
        };
      }
    };
    const result = tail.then(perform, perform);
    tail = result;
    return result;
  });
  await server.connect(transport);
  return {
    async exchange(frame: unknown) {
      active();
      return transport.exchange(frame);
    },
    async close() {
      closed = true;
      await server.close();
    },
  };
}
