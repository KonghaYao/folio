import { afterEach, expect, test } from 'bun:test';
import { BoardStore } from '../database';
import { BoardEvents } from '../events';
import { createApp } from '../app';
import type { AgentTurn } from '../../shared/chat';
import { ChatHistory } from './history';

let store: BoardStore;
let events: BoardEvents;
afterEach(() => {
  events?.close();
  store?.close();
});
async function fixture(run: (turn: AgentTurn) => Promise<void>) {
  store = new BoardStore(':memory:');
  events = new BoardEvents();
  const app = createApp(store, events, run);
  const owner = await app.request('/api/boards', { method: 'POST', body: '{}' });
  const cookie = owner.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const { id } = await owner.json();
  const root = '/api/boards/' + id;
  function post(action: string, body: unknown, auth = cookie) {
    return app.request(root + action, {
      method: 'POST',
      headers: { Cookie: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const turnId = crypto.randomUUID();
  const settings = {
    provider: 'openai',
    model: 'demo',
    baseUrl: 'https://example.com/v1',
    apiKey: 'local-secret',
  };
  const turn = () => post('/chat/turn', { turnId, settings, prompt: 'Read this board' });
  return { app, root, id, cookie, post, turn, turnId, settings };
}
test('only the initiating device can deliver a reverse MCP reply, even after workspace pairing', async () => {
  const ctx = await fixture(async (turn) => {
    const answer = await turn.exchange({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'canvas_read', arguments: {} },
    });
    if (!(answer as { result?: unknown }).result) throw new Error('canvas_error');
    turn.emit({ type: 'text', text: 'Read confirmed' });
  });
  const pair = await ctx.app.request('/api/devices/pair', {
    method: 'POST',
    headers: { Cookie: ctx.cookie },
  });
  const invite = await pair.json();
  const claim = await ctx.app.request('/api/devices/claim', {
    method: 'POST',
    body: JSON.stringify({ token: invite.token }),
  });
  expect(claim.status).toEqual(200);
  const paired = claim.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const running = await ctx.turn();
  const reply = {
    turnId: ctx.turnId,
    id: 1,
    result: { jsonrpc: '2.0', id: 7, result: { content: [] } },
  };
  expect((await ctx.post('/chat/rpc', reply, paired)).status).toEqual(404);
  expect((await ctx.post('/chat/cancel', { turnId: ctx.turnId }, paired)).status).toEqual(404);
  expect(
    (
      await ctx.post(
        '/chat/turn',
        { turnId: crypto.randomUUID(), settings: ctx.settings, prompt: 'Second device' },
        paired,
      )
    ).status,
  ).toEqual(409);
  expect((await ctx.post('/chat/rpc', reply)).status).toEqual(204);
  expect(await running.text()).toContain('"type":"done"');
  expect((await ctx.post('/chat/rpc', reply)).status).toEqual(404);
  expect((await ctx.turn()).status).toEqual(409);
  const log = await ctx.app.request(ctx.root + '/chat/history', { headers: { Cookie: paired } });
  expect((await log.json()).messages).toHaveLength(2);
});
test('a cancelled round does not persist partial history or reserve the next turn', async () => {
  const ctx = await fixture(async (turn) => {
    turn.emit({ type: 'text', text: 'Incomplete' });
    await turn.exchange({ jsonrpc: '2.0', id: 11, method: 'ping' });
  });
  const running = await ctx.turn();
  expect((await ctx.post('/chat/cancel', { turnId: ctx.turnId })).status).toEqual(204);
  expect(await running.text()).toContain('chat_cancelled');
  const history = await ctx.app.request(ctx.root + '/chat/history', {
    headers: { Cookie: ctx.cookie },
  });
  expect((await history.json()).messages).toEqual([]);
  const next = await ctx.turn();
  expect(next.status).toBe(200);
  await ctx.post('/chat/cancel', { turnId: ctx.turnId });
  await next.text();
});
test('history retains the most recent forty complete pairs and is removed with the board', async () => {
  const { id } = await fixture(async () => {});
  const history = new ChatHistory(store.db);
  for (let i = 0; i < 45; i++) history.append(id, 'workspace', 'turn' + i, 'user' + i, 'reply' + i);
  const log = history.messages(id, 'workspace');
  expect(log).toHaveLength(80);
  expect(log[0].content).toBe('user5');
  expect(history.messages(id, 'peer')).toHaveLength(0);
  store.db.run('DELETE FROM boards WHERE id=?', [id]);
  expect(history.messages(id, 'workspace')).toHaveLength(0);
});
