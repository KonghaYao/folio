import { Presence } from './presence';
interface BoardEvent {
  rev: number;
  kind: 'snapshot' | 'items' | 'title' | 'deleted' | 'access';
}

const encoder = new TextEncoder();

/** SSE is a revision notification channel. A reconnect always starts with a current revision. */
export class BoardEvents {
  readonly presence = new Presence();
  private readonly deviceStreams = new Map<string, Set<() => void>>();
  disconnect(device: string, principal: string) {
    const key = device + '/' + principal;
    for (const end of this.deviceStreams.get(key) ?? []) end();
    this.presence.removeDevice(device, principal);
  }
  private readonly subscribers = new Map<string, Set<(event: BoardEvent) => void>>();
  private readonly cleanups = new Set<() => void>();

  publish(boardId: string, event: BoardEvent): void {
    for (const subscriber of this.subscribers.get(boardId) ?? []) subscriber(event);
  }

  open(
    boardId: string,
    rev: number,
    signal: AbortSignal,
    revision: () => number,
    device: string,
    principal: string,
  ): Response {
    let dispose = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const listeners = this.subscribers.get(boardId) ?? new Set();
        this.subscribers.set(boardId, listeners);
        let offPresence = () => {};
        let latest = rev;
        let closed = false;
        const emit = (event: BoardEvent) => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) < -32) {
            dispose();
            return;
          }
          if (event.kind !== 'deleted') {
            try {
              revision();
            } catch {
              event = { rev: event.rev, kind: 'deleted' };
            }
          }
          latest = event.rev;
          controller.enqueue(
            encoder.encode(`id: ${event.rev}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`),
          );
          if (event.kind === 'deleted') dispose();
        };
        const key = device + '/' + principal;
        const end = () => emit({ rev: latest + 1, kind: 'deleted' });
        const owned = this.deviceStreams.get(key) ?? new Set();
        this.deviceStreams.set(key, owned);
        owned.add(end);
        const heartbeat = setInterval(() => {
          // Also observes commits from a different process sharing the same database.
          try {
            this.presence.prune(boardId);
            const current = revision();
            if (current > latest) emit({ rev: current, kind: 'snapshot' });
            else if ((controller.desiredSize ?? 0) >= 0)
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            else dispose();
          } catch {
            emit({ rev: latest + 1, kind: 'deleted' });
          }
        }, 12_000);
        dispose = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          owned.delete(end);
          if (!owned.size) this.deviceStreams.delete(key);
          offPresence();
          listeners.delete(emit);
          if (!listeners.size) this.subscribers.delete(boardId);
          signal.removeEventListener('abort', dispose);
          this.cleanups.delete(dispose);
          try {
            controller.close();
          } catch {
            /* Consumer already cancelled. */
          }
        };
        listeners.add(emit);
        this.cleanups.add(dispose);
        signal.addEventListener('abort', dispose, { once: true });
        if (signal.aborted) dispose();
        else {
          emit({ rev, kind: 'snapshot' });
          offPresence = this.presence.listen(boardId, (peers) => {
            if (closed || (controller.desiredSize ?? 0) < 0) return;
            try {
              revision();
            } catch {
              emit({ rev: latest + 1, kind: 'deleted' });
              return;
            }
            controller.enqueue(
              encoder.encode('event: presence\ndata: ' + JSON.stringify({ peers }) + '\n\n'),
            );
          });
        }
      },
      cancel: () => dispose(),
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  close(): void {
    for (const cleanup of this.cleanups) cleanup();
  }
}
