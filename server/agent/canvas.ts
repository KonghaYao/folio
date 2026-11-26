import type { AcpMcpServerInstance, AcpMcpTransport } from '@peri-code/sdk';
import type { AgentTurn } from '../../shared/chat';

const tools = new Set([
  'canvas_read',
  'canvas_create',
  'canvas_update',
  'canvas_delete',
  'canvas_select',
  'canvas_view',
]);

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** SDK-owned ACP transport delegates JSON-RPC to the active, authenticated browser tab. */
export function canvasServer(
  turn: AgentTurn,
  signal: AbortSignal,
  onDiscovered: (valid: boolean) => void,
): AcpMcpServerInstance {
  let transport: AcpMcpTransport | undefined;
  return {
    async connect(link) {
      transport = link;
      link.onmessage = (frame) => {
        void relay(frame);
      };
      await link.start();
    },
    async close() {
      await transport?.close();
    },
  };

  async function relay(frame: unknown) {
    const { method, id, params } = object(frame);
    const rawName = object(params).name;
    const name = method === 'tools/call' && typeof rawName === 'string' ? rawName : undefined;
    try {
      signal.throwIfAborted();
      if (name && !tools.has(name)) throw new Error('Unknown canvas tool');
      if (name) turn.emit({ type: 'tool', name, phase: 'start' });
      const reply = await turn.exchange(frame);
      signal.throwIfAborted();
      if (method === 'tools/list') {
        const exported = object(object(reply).result).tools;
        onDiscovered(
          Array.isArray(exported) && exported.some((tool) => object(tool).name === 'canvas_read'),
        );
      }
      if (name) {
        const result = object(reply);
        turn.emit({
          type: 'tool',
          name,
          phase: result.error || object(result.result).isError ? 'error' : 'done',
        });
      }
      if (reply !== null && reply !== undefined) await transport?.send(reply);
    } catch {
      if (method === 'tools/list') onDiscovered(false);
      if (name && !signal.aborted) turn.emit({ type: 'tool', name, phase: 'error' });
      if (id !== undefined) {
        await transport
          ?.send({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: 'Canvas exchange failed or was cancelled.' },
          })
          .catch(() => {});
      }
    }
  }
}
