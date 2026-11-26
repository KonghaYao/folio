import { createHmac, randomBytes } from 'node:crypto';
import { ApiError, isObject, type JsonObject, type Role } from './protocol';

type Point = { x: number; y: number };
type View = Point & { w: number; h: number };
export interface Peer {
  id: string;
  role: Role;
  cursor: Point | null;
  view: View;
}
interface Active {
  device: string;
  peer: Peer;
  principal: string;
  timestamp: number;
}
interface Room {
  entries: Map<string, Active>;
  listeners: Set<(peers: Peer[]) => void>;
  timer?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>;
}
export const PRESENCE_TTL = 25_000;
const settled = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12;

function point(value: unknown): value is Point {
  return isObject(value) && settled(value.x) && settled(value.y);
}
export function clientKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(value))
    throw new ApiError(400, 'invalid_tab_id');
  return value;
}

/** Cursors are last-value state local to this server. Broadcasts are coalesced per board. */
export class Presence {
  private readonly key = randomBytes(32);
  private readonly rooms = new Map<string, Room>();
  private room(board: string) {
    let room = this.rooms.get(board);
    if (!room) {
      room = { entries: new Map(), listeners: new Set() };
      this.rooms.set(board, room);
    }
    return room;
  }
  private id(board: string, device: string, tab: string) {
    return createHmac('sha256', this.key)
      .update([board, device, tab].join('/'))
      .digest('hex')
      .slice(0, 16);
  }
  private broadcast(board: string, room: Room) {
    if (room.timer) return;
    room.timer = setTimeout(() => {
      room.timer = undefined;
      const peers = [...room.entries.values()].map((entry) => entry.peer);
      for (const listener of room.listeners) listener(peers);
      if (!room.entries.size && !room.listeners.size && this.rooms.get(board) === room)
        this.clear(board);
    }, 100);
    room.timer.unref();
  }
  private expire(board: string, room: Room) {
    if (room.expiry || !room.entries.size) return;
    const firstExpiry = Math.min(
      ...[...room.entries.values()].map((entry) => entry.timestamp + PRESENCE_TTL),
    );
    room.expiry = setTimeout(
      () => {
        room.expiry = undefined;
        this.prune(board);
        this.expire(board, room);
      },
      Math.max(1, firstExpiry - Date.now()),
    );
    room.expiry.unref();
  }
  prune(board: string, allowed?: (principal: string) => boolean, now = Date.now()) {
    const room = this.rooms.get(board);
    if (!room) return;
    let changed = false;
    for (const [id, entry] of room.entries) {
      if (now - entry.timestamp >= PRESENCE_TTL || (allowed && !allowed(entry.principal))) {
        room.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcast(board, room);
  }
  update(board: string, device: string, principal: string, role: Role, body: JsonObject) {
    const self = this.id(board, device, clientKey(body.tab));
    const { view, cursor } = body;
    if (
      !isObject(view) ||
      !settled(view.x) ||
      !settled(view.y) ||
      !settled(view.w) ||
      !settled(view.h) ||
      view.w <= 0 ||
      view.h <= 0 ||
      !(cursor === null || point(cursor))
    )
      throw new ApiError(400, 'invalid_presence');
    const now = Date.now();
    this.prune(board, undefined, now);
    const room = this.room(board);
    const prev = room.entries.get(self);
    if (prev && now - prev.timestamp < 75) throw new ApiError(429, 'presence_throttled');
    if (!prev && room.entries.size >= 64) throw new ApiError(429, 'presence_room_full');
    const peer = {
      id: self,
      role,
      cursor: cursor && { x: cursor.x, y: cursor.y },
      view: { x: view.x, y: view.y, w: view.w, h: view.h },
    };
    room.entries.set(self, { peer, principal, device, timestamp: now });
    this.expire(board, room);
    this.broadcast(board, room);
    return { self };
  }
  leave(board: string, device: string, tab: string) {
    const room = this.rooms.get(board);
    if (room?.entries.delete(this.id(board, device, tab))) this.broadcast(board, room);
  }
  listen(board: string, listener: (peers: Peer[]) => void) {
    this.prune(board);
    const room = this.room(board);
    room.listeners.add(listener);
    if (room.entries.size) listener([...room.entries.values()].map((entry) => entry.peer));
    return () => {
      room.listeners.delete(listener);
      if (!room.listeners.size && !room.entries.size && !room.timer) this.clear(board);
    };
  }
  removeDevice(device: string, principal: string) {
    for (const [board, room] of this.rooms) {
      let changed = false;
      for (const [key, entry] of room.entries) {
        if (entry.device === device && entry.principal === principal) {
          room.entries.delete(key);
          changed = true;
        }
      }
      if (changed) this.broadcast(board, room);
    }
  }
  clear(board: string) {
    const room = this.rooms.get(board);
    if (room?.timer) clearTimeout(room.timer);
    if (room?.expiry) clearTimeout(room.expiry);
    this.rooms.delete(board);
  }
}
