import type { Context, Hono } from 'hono';
import type { AgentTurn, ChatFrame, ChatSettings } from '../../shared/chat';
import type { BoardStore } from '../database';
import { ApiError, isObject, type JsonObject, MAX_MUTATION_BYTES } from '../protocol';
import type { SessionEnv } from '../session';
import { ChatHistory, modelHistory } from './history';

type Runner = (turn: AgentTurn) => Promise<void>;
type Reader = (c: Context, limit?: number) => Promise<JsonObject>;
interface Turn {
  id: string;
  device: string;
  board: string;
  principal: string;
  controller: AbortController;
  calls: Map<number, (value: unknown) => void>;
}

const safeCodes = new Set([
  'provider_auth',
  'provider_endpoint',
  'provider_rate_limit',
  'provider_error',
  'chat_cancelled',
  'canvas_error',
  'permission_denied',
  'agent_error',
  'turn_expired',
  'output_limit',
  'turn_timeout',
  'inactive_workspace',
  'board_not_found',
  'read_only',
]);
const tools = new Set([
  'canvas_create',
  'canvas_update',
  'canvas_delete',
  'canvas_read',
  'canvas_view',
  'canvas_select',
]);
const mutating = new Set(['canvas_create', 'canvas_update', 'canvas_delete']);
const production: Runner = async (turn) => (await import('../agent')).runPeriTurn(turn);

function settings(input: unknown): ChatSettings {
  if (!isObject(input) || (input.provider !== 'openai' && input.provider !== 'anthropic'))
    throw new ApiError(400, 'invalid_settings');
  const { model, baseUrl, apiKey } = input;
  if (
    typeof model !== 'string' ||
    !model.trim() ||
    model.length > 256 ||
    typeof baseUrl !== 'string' ||
    baseUrl.length > 2048 ||
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    apiKey.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(model + baseUrl + apiKey)
  )
    throw new ApiError(400, 'invalid_settings');
  try {
    const url = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new ApiError(400, 'provider_endpoint');
  }
  return {
    provider: input.provider,
    model: model.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
  };
}

export function installChatRoutes(
  app: Hono<SessionEnv>,
  store: BoardStore,
  read: Reader,
  run: Runner = production,
) {
  const history = new ChatHistory(store.db);
  const active = new Map<string, Turn>();
  const prefix = '/api/boards/:id/chat';
  app.get(prefix + '/history', (c) => {
    const board = c.req.param('id')!,
      principal = c.get('principal');
    store.board(board, principal);
    return c.json({ messages: history.messages(board, principal) });
  });

  function find(c: Context<SessionEnv>, id: unknown): Turn {
    const turn = typeof id === 'string' ? active.get(id) : undefined;
    if (
      !turn ||
      turn.board !== c.req.param('id') ||
      turn.principal !== c.get('principal') ||
      turn.device !== c.get('device')
    )
      throw new ApiError(404, 'turn_expired');
    store.board(turn.board, turn.principal);
    return turn;
  }

  app.post(prefix + '/rpc', async (c) => {
    const body = await read(c, MAX_MUTATION_BYTES);
    const turn = find(c, body.turnId);
    const settle = typeof body.id === 'number' ? turn.calls.get(body.id) : undefined;
    if (!settle || !Object.hasOwn(body, 'result')) throw new ApiError(409, 'turn_expired');
    turn.calls.delete(body.id as number);
    settle(body.result);
    return c.body(null, 204);
  });
  app.post(prefix + '/cancel', async (c) => {
    const { turnId } = await read(c);
    find(c, turnId).controller.abort(new Error('chat_cancelled'));
    return c.body(null, 204);
  });
  app.post(prefix + '/turn', async (c) => {
    const board = c.req.param('id')!,
      principal = c.get('principal'),
      device = c.get('device');
    store.board(board, principal);
    const body = await read(c, 96 * 1024);
    const options = settings(body.settings);
    const { turnId, prompt } = body;
    if (
      typeof turnId !== 'string' ||
      !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(turnId) ||
      typeof prompt !== 'string' ||
      !prompt.trim() ||
      prompt.length > 12000
    )
      throw new ApiError(400, 'invalid_chat_turn');
    const previous = history.messages(board, principal);
    if (
      history.completed(board, principal, turnId) ||
      active.has(turnId) ||
      [...active.values()].some((t) => t.principal === principal && t.board === board)
    )
      throw new ApiError(409, 'chat_busy');
    if (active.size >= 24) throw new ApiError(429, 'chat_busy');
    const turn: Turn = {
      id: turnId,
      device,
      board,
      principal,
      controller: new AbortController(),
      calls: new Map(),
    };
    const { signal } = turn.controller;
    const abort = () => turn.controller.abort(new Error('chat_cancelled'));
    const verify = () => {
      c.get('validateSession')();
      store.board(board, principal);
      signal.throwIfAborted();
    };
    verify();
    active.set(turnId, turn);
    const encoder = new TextEncoder();
    const requestSignal = c.req.raw.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(output) {
        const send = (event: ChatFrame) =>
          output.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        let next = 0,
          reply = '';
        const heartbeat = setInterval(() => {
          try {
            verify();
            send({ type: 'heartbeat' });
          } catch {
            abort();
          }
        }, 12000);
        const deadline = setTimeout(
          () => turn.controller.abort(new Error('turn_timeout')),
          15 * 60 * 1000,
        );
        requestSignal.addEventListener('abort', abort, { once: true });
        if (requestSignal.aborted) abort();
        async function exchange(frame: unknown) {
          verify();
          if (!isObject(frame) || typeof frame.method !== 'string') throw new Error('canvas_error');
          if (frame.method === 'tools/call') {
            const name = isObject(frame.params) ? frame.params.name : undefined;
            if (typeof name !== 'string' || !tools.has(name)) throw new Error('permission_denied');
            if (mutating.has(name)) store.board(board, principal, 'write');
          } else if (
            ![
              'server/discover',
              'resources/templates/list',
              'resources/list',
              'initialize',
              'notifications/initialized',
              'ping',
              'tools/list',
              'notifications/cancelled',
            ].includes(frame.method)
          )
            throw new Error('permission_denied');
          if (turn.calls.size >= 16) throw new Error('canvas_error');
          const id = ++next;
          const result = Promise.withResolvers<unknown>();
          const stop = () => result.reject(signal.reason);
          const timer = setTimeout(() => result.reject(new Error('canvas_error')), 60000);
          turn.calls.set(id, result.resolve);
          signal.addEventListener('abort', stop, { once: true });
          try {
            send({ type: 'rpc', id, frame });
            const response = await result.promise;
            verify();
            if (
              frame.id !== undefined &&
              (!isObject(response) || response.jsonrpc !== '2.0' || response.id !== frame.id)
            )
              throw new Error('canvas_error');
            return response;
          } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
            turn.calls.delete(id);
          }
        }
        void (async () => {
          try {
            await run({
              settings: options,
              history: modelHistory(previous, prompt),
              signal,
              exchange,
              emit(event) {
                verify();
                if (event.type === 'text') {
                  if (reply.length + event.text.length > 65536) {
                    turn.controller.abort(new Error('output_limit'));
                    signal.throwIfAborted();
                  }
                  reply += event.text;
                }
                send(event);
              },
            });
            verify();
            const redact = (text: string) => text.split(options.apiKey).join('[redacted]');
            history.append(board, principal, turnId, redact(prompt), redact(reply));
            send({ type: 'done' });
          } catch (error) {
            const code = signal.aborted
              ? signal.reason?.message
              : error instanceof Error
                ? error.message
                : undefined;
            try {
              send({ type: 'error', code: safeCodes.has(code) ? code : 'agent_error' });
            } catch {
              /* Reader disconnected. */
            }
          } finally {
            active.delete(turnId);
            clearInterval(heartbeat);
            clearTimeout(deadline);
            requestSignal.removeEventListener('abort', abort);
            abort();
            try {
              output.close();
            } catch {
              /* Reader cancelled. */
            }
          }
        })();
      },
      cancel() {
        abort();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
