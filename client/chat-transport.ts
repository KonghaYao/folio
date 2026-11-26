import type { ChatEvent, ChatFrame, ChatMessage, ChatSettings } from '../shared/chat';
export type { ChatEvent, ChatMessage, ChatSettings } from '../shared/chat';

function endpoint(boardId: string, action: string) {
  return '/api/boards/' + encodeURIComponent(boardId) + '/chat/' + action;
}
async function checked(response: Response) {
  if (response.ok) return response;
  const body = await response.json().catch(() => null);
  throw new Error(typeof body?.error === 'string' ? body.error : 'agent_error');
}
export async function getChatHistory(
  boardId: string,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const response = await checked(
    await fetch(endpoint(boardId, 'history'), { signal, cache: 'no-store' }),
  );
  return (await response.json()).messages;
}
interface RunOptions {
  boardId: string;
  settings: ChatSettings;
  prompt: string;
  signal: AbortSignal;
  exchange: (frame: unknown) => Promise<unknown>;
  onEvent: (event: ChatEvent) => void;
}

export async function runChat(options: RunOptions): Promise<void> {
  const { boardId, settings, prompt, signal, onEvent, exchange } = options;
  signal.throwIfAborted();
  // getRandomValues also works on LAN HTTP; crypto.randomUUID requires a secure context.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const turnId = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
  const post = (path: string, body: object, extra: RequestInit = {}) =>
    fetch(endpoint(boardId, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...extra,
    });
  const cancel = () => {
    void post('cancel', { turnId }, { keepalive: true }).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let reader: ReadableStreamDefaultReader<string> | undefined;
  let terminal = false;
  try {
    const response = await checked(await post('turn', { turnId, settings, prompt }, { signal }));
    if (!response.body) throw new Error('agent_error');
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const event: ChatFrame = JSON.parse(line);
        signal.throwIfAborted();
        if (event.type === 'rpc') {
          let result: unknown;
          try {
            result = await exchange(event.frame);
          } catch {
            const frame = event.frame as { id?: unknown };
            result =
              frame?.id === undefined
                ? null
                : {
                    jsonrpc: '2.0',
                    id: frame.id,
                    error: { code: -32603, message: 'Canvas operation failed.' },
                  };
          }
          signal.throwIfAborted();
          await checked(
            await post('rpc', { turnId, id: event.id, result: result ?? null }, { signal }),
          );
        } else if (event.type === 'error') {
          terminal = true;
          throw new Error(event.code);
        } else if (event.type === 'done') {
          terminal = true;
          onEvent(event);
          return;
        } else if (event.type === 'text' || event.type === 'tool') onEvent(event);
      }
    }
    throw new Error('agent_error');
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!terminal && !signal.aborted) cancel();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
