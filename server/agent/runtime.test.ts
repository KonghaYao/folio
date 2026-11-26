import { describe, expect, test } from 'bun:test';
import { runPeriTurn } from './index';
import { publicAddress } from './provider';
import type { AgentEvent, AgentTurn } from '../../shared/chat';

type Frame = {
  id?: string | number;
  method: string;
  params?: { name?: string; protocolVersion?: string };
};
type ToolMessage = { role: string; content: string };
type MockRequest = {
  messages: ToolMessage[];
  tools: Array<{ function: { name: string } }>;
  model: string;
};

function canvas(frame: unknown) {
  const f = frame as Frame;
  if (f.id === undefined) return null;
  let result;
  switch (f.method) {
    case 'initialize':
      result = {
        protocolVersion: f.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'canvas', version: '1' },
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'canvas_read',
            description: 'Read the canvas',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
      break;
    case 'tools/call':
      expect(f.params?.name).toBe('canvas_read');
      result = { content: [{ type: 'text', text: 'emerald board' }] };
      break;
    default:
      return { jsonrpc: '2.0', id: f.id, error: { code: -32601, message: 'Method not found' } };
  }
  return { jsonrpc: '2.0', id: f.id, result };
}

function chunks(call: number, delta: object, reason: string) {
  const chunk = (d: object, finish: string | null) =>
    'data: ' +
    JSON.stringify({
      id: 'completion-' + call,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: d, finish_reason: finish }],
    }) +
    '\n\n';
  return new Response(
    chunk({ role: 'assistant' }, null) +
      chunk(delta, null) +
      chunk({}, reason) +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function anthropicChunks() {
  const chunks = [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bonjour !' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    chunks
      .map((chunk) => 'event: ' + chunk.type + '\ndata: ' + JSON.stringify(chunk) + '\n\n')
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function providerTest(
  handler: (req: Request) => Response | Promise<Response>,
  verify: (base: string) => Promise<void>,
) {
  const service = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  const previous = process.env.FOLIO_AI_ALLOWED_ORIGINS;
  process.env.FOLIO_AI_ALLOWED_ORIGINS = service.url.origin;
  try {
    await verify(service.url.origin);
  } finally {
    if (previous === undefined) delete process.env.FOLIO_AI_ALLOWED_ORIGINS;
    else process.env.FOLIO_AI_ALLOWED_ORIGINS = previous;
    await service.stop(true);
  }
}

function turn(
  baseUrl: string,
  emit: (event: AgentEvent) => void,
  provider: 'openai' | 'anthropic' = 'openai',
): AgentTurn {
  return {
    settings: { provider, baseUrl, model: 'test-model', apiKey: 'fixture-only' },
    history: [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'What color is the board?' },
    ],
    signal: AbortSignal.timeout(10_000),
    emit,
    async exchange(frame) {
      return canvas(frame);
    },
  };
}

describe('Peri SDK turn', () => {
  test('uses real WASM discovery, reverse MCP tool execution, tool results and streamed text', async () => {
    let calls = 0;
    const events: AgentEvent[] = [];
    await providerTest(
      async (req) => {
        expect(new URL(req.url).pathname).toBe('/v1/chat/completions');
        expect(req.headers.get('authorization')).toBe('Bearer fixture-only');
        const body: MockRequest = await req.json();
        expect(body.model).toBe('test-model');
        expect(body.messages).toContainEqual({ role: 'assistant', content: 'Earlier answer' });
        expect(body.tools.map((t) => t.function.name).sort()).toEqual([
          'ExecuteExtraTool',
          'SearchExtraTools',
        ]);
        calls++;
        const choice =
          calls === 1
            ? ['SearchExtraTools', { query: 'canvas_read' }]
            : ['ExecuteExtraTool', { tool_name: 'mcp__canvas__canvas_read', params: {} }];
        if (calls === 3) {
          expect(body.messages.at(-1)?.role).toBe('tool');
          expect(body.messages.at(-1)?.content).toContain('emerald board');
          return chunks(calls, { content: 'Emerald.' }, 'stop');
        }
        return chunks(
          calls,
          {
            tool_calls: [
              {
                index: 0,
                id: 'call_' + calls,
                type: 'function',
                function: { name: choice[0], arguments: JSON.stringify(choice[1]) },
              },
            ],
          },
          'tool_calls',
        );
      },
      async (base) => {
        await runPeriTurn(turn(base + '/v1', (e) => events.push(e)));
      },
    );
    expect(calls).toBe(3);
    expect(events).toEqual([
      { type: 'tool', name: 'canvas_read', phase: 'start' },
      { type: 'tool', name: 'canvas_read', phase: 'done' },
      { type: 'text', text: 'Emerald.' },
    ]);
  });
  test('runs the Anthropic Messages protocol and emits its content', async () => {
    const events: AgentEvent[] = [];
    await providerTest(
      async (req) => {
        expect(new URL(req.url).pathname).toBe('/v1/messages');
        expect(req.headers.get('x-api-key')).toBe('fixture-only');
        expect(req.headers.get('anthropic-version')).toBe('2023-06-01');
        const body = await req.json();
        expect(body.messages).toContainEqual({ role: 'assistant', content: 'Earlier answer' });
        return anthropicChunks();
      },
      async (base) => {
        await runPeriTurn(turn(base, (e) => events.push(e), 'anthropic'));
      },
    );
    expect(events).toContainEqual({ type: 'text', text: 'Bonjour !' });
  });
  test('reports authentication failures using only a stable code', async () => {
    await providerTest(
      () => new Response('sensitive upstream body', { status: 401 }),
      async (base) => {
        await expect(runPeriTurn(turn(base, () => {}))).rejects.toMatchObject({
          code: 'provider_auth',
          message: 'provider_auth',
        });
      },
    );
  });
  test('cancels a running provider request and disposes the upstream connection', async () => {
    const active = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const controller = new AbortController();
    await providerTest(
      (request) => {
        active.resolve();
        request.signal.addEventListener('abort', () => closed.resolve(), { once: true });
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(': waiting\n\n'));
            },
            cancel() {
              closed.resolve();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      async (origin) => {
        const running = runPeriTurn({ ...turn(origin, () => {}), signal: controller.signal });
        void running.catch(() => {});
        await active.promise;
        controller.abort();
        await expect(running).rejects.toMatchObject({ code: 'chat_cancelled' });
        await closed.promise;
      },
    );
  });
  test('does not follow redirects with credentials', async () => {
    let requests = 0;
    await providerTest(
      (request) => {
        requests++;
        return Response.redirect(new URL('/other-destination', request.url), 307);
      },
      async (origin) => {
        await expect(runPeriTurn(turn(origin, () => {}))).rejects.toMatchObject({
          code: 'provider_error',
        });
      },
    );
    expect(requests).toBe(1);
  });
  test('requires actual canvas capabilities before sending the prompt', async () => {
    let calls = 0;
    await providerTest(
      () => {
        calls++;
        return new Response(null, { status: 500 });
      },
      async (origin) => {
        const current = turn(origin, () => {});
        const exchange = async (frame: unknown) => {
          const request = frame as Frame;
          return request.method === 'tools/list'
            ? { jsonrpc: '2.0', id: request.id, result: { tools: [] } }
            : canvas(frame);
        };
        await expect(runPeriTurn({ ...current, exchange })).rejects.toMatchObject({
          code: 'canvas_error',
        });
      },
    );
    expect(calls).toBe(0);
  });
  test('rejects private endpoints unless explicitly allowed', async () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '::1', '::ffff:10.1.2.3', '2001:db8::1'])
      expect(publicAddress(ip)).toBe(false);
    expect(publicAddress('93.184.216.34')).toBe(true);
    await expect(runPeriTurn(turn('https://127.0.0.1', () => {}))).rejects.toMatchObject({
      code: 'provider_endpoint',
    });
  });
});
