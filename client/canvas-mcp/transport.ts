import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  JSONRPCMessageSchema,
  isJSONRPCNotification,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';

interface Reply {
  wire: string;
  promise: Promise<JSONRPCMessage>;
  resolve(frame: JSONRPCMessage): void;
  reject(reason: Error): void;
}

/** A single authenticated chat turn owns this transport. MCP handles negotiation and dispatch. */
export class BrowserTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: Transport['onclose'];
  private open = false;
  private pending = new Map<RequestId, Reply>();
  private history = new Map<RequestId, { wire: string; frame: JSONRPCMessage }>();
  private seen = new Set<RequestId>();

  async start() {
    this.open = true;
  }
  async exchange(input: unknown): Promise<JSONRPCMessage | null> {
    if (!this.open) throw new Error('Canvas MCP connection closed.');
    const wire = JSON.stringify(input);
    if (!wire || new TextEncoder().encode(wire).length > 512 * 1024)
      throw new Error('Invalid MCP frame size.');
    const frame = JSONRPCMessageSchema.parse(input);
    if (isJSONRPCNotification(frame)) {
      this.onmessage?.(frame);
      return null;
    }
    if (!isJSONRPCRequest(frame))
      throw new Error('Expected an MCP client request or notification.');
    const { id } = frame;
    const prior = this.history.get(id);
    const active = this.pending.get(id);
    if (prior || active) {
      if ((prior ?? active)!.wire !== wire) throw new Error('Conflicting MCP request ID.');
      return prior?.frame ?? active!.promise;
    }
    if (this.seen.has(id)) throw new Error('Expired duplicate MCP request.');
    if (this.pending.size >= 16 || this.seen.size >= 2048)
      throw new Error('Canvas MCP session limit reached.');
    this.seen.add(id);
    let resolve!: Reply['resolve'], reject!: Reply['reject'];
    const promise = new Promise<JSONRPCMessage>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    this.pending.set(id, { wire, promise, resolve, reject });
    this.onmessage?.(frame);
    return promise;
  }
  async send(frame: JSONRPCMessage) {
    if (!('id' in frame) || frame.id == null) return;
    const reply = this.pending.get(frame.id);
    if (!reply) return;
    this.pending.delete(frame.id);
    this.history.set(frame.id, { wire: reply.wire, frame });
    if (this.history.size > 16) this.history.delete(this.history.keys().next().value!);
    reply.resolve(frame);
  }
  async close() {
    if (!this.open) return;
    this.open = false;
    for (const reply of this.pending.values())
      reply.reject(new Error('Canvas MCP connection closed.'));
    this.pending.clear();
    this.history.clear();
    this.seen.clear();
    this.onclose?.();
  }
}
