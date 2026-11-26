import type { BoardRecord } from '@quickdrawjs/core';
import { forgetBoardAssets } from './asset-cache';
import {
  cachedBoard,
  cachedBoardList,
  cachedBoardHeader,
  cacheBoard,
  cacheBoardList,
  currentCacheScope,
  forgetBoard,
  rememberSummary,
} from './offline';

export type Role = 'owner' | 'editor' | 'viewer';
export interface BoardSummary {
  id: string;
  title: string;
  rev: number;
  updatedAt: number;
  role: Role;
}
export interface Board extends BoardSummary {
  items: Record<string, BoardRecord>;
}
export interface Asset {
  id: string;
  url: string;
  name: string;
  size: number;
  type: string;
}
export async function bootstrapSession() {
  const begin = async () => {
    try {
      await request('/api/devices/workspaces');
    } catch (error) {
      if (error instanceof RequestError || !currentCacheScope()) throw error;
    }
  };
  if (navigator.locks) await navigator.locks.request('folio:session-init', begin);
  else await begin();
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
async function fetchEndpoint(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const file = body instanceof Blob;
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers:
      body === undefined
        ? undefined
        : { 'Content-Type': file ? body.type || 'application/octet-stream' : 'application/json' },
    body: body === undefined ? undefined : file ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new RequestError(response.status, problem?.error || response.statusText);
  }
  return response;
}
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetchEndpoint(path, method, body);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const boardPath = (id: string) => '/api/boards/' + encodeURIComponent(id);
export async function listBoards() {
  const scope = currentCacheScope();
  try {
    const { boards } = await request<{ boards: BoardSummary[] }>('/api/boards');
    await cacheBoardList(boards, scope ?? currentCacheScope()).catch(() => {});
    return boards;
  } catch (err) {
    if (!(err instanceof RequestError)) {
      const cached = await cachedBoardList(scope);
      if (cached) return cached;
    }
    throw err;
  }
}
export async function createBoard(title?: string) {
  const board = await request<Board>('/api/boards', 'POST', title ? { title } : {});
  await Promise.allSettled([cacheBoard(board), rememberSummary(board)]);
  return board;
}
export interface BoardDelta extends BoardSummary {
  put: Record<string, BoardRecord>;
  remove: string[];
}
export const getChanges = (id: string, since: number) =>
  request<BoardDelta>(boardPath(id) + '/changes?since=' + since);

export function applyDelta(board: Board, delta: BoardDelta): Board {
  for (const id of delta.remove) delete board.items[id];
  Object.assign(board.items, delta.put);
  return {
    id: board.id,
    title: delta.title,
    rev: delta.rev,
    role: delta.role,
    updatedAt: delta.updatedAt,
    items: board.items,
  };
}

export async function getBoard(id: string) {
  const scope = currentCacheScope();
  try {
    const header = await cachedBoardHeader(id, scope).catch(() => undefined);
    if (header) {
      try {
        const delta = await getChanges(id, header.rev);
        const local = await cachedBoard(id, scope).catch(() => undefined);
        // Another tab can advance the local base while this request is in flight.
        if (local && local.rev >= header.rev && local.rev <= delta.rev) {
          const board = applyDelta(local, delta);
          await Promise.allSettled([
            cacheBoard(board, scope, {
              since: header.rev,
              ids: [...Object.keys(delta.put), ...delta.remove],
            }),
            rememberSummary(board, scope),
          ]);
          return board;
        }
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 409) throw error;
      }
    }
    // Keep the received bytes as the cold offline base; storing a Blob does not synchronously
    // structured-clone a whole document (including every nested pressure sample) on the UI thread.
    const response = await fetchEndpoint(boardPath(id));
    const snapshot = await response.blob();
    const board = JSON.parse(await snapshot.text()) as Board;
    await Promise.allSettled([
      cacheBoard(board, scope ?? currentCacheScope(), snapshot),
      rememberSummary(board, scope ?? currentCacheScope()),
    ]);
    return board;
  } catch (err) {
    if (!(err instanceof RequestError)) {
      const previous = await cachedBoard(id, scope);
      if (previous) return previous;
    } else if (err.status === 403 || err.status === 404)
      await Promise.all([forgetBoard(id, scope), forgetBoardAssets(id, scope).catch(() => {})]);
    throw err;
  }
}
export async function renameBoard(id: string, title: string) {
  const summary = await request<BoardSummary>(boardPath(id), 'PATCH', { title });
  await rememberSummary(summary).catch(() => {});
  return summary;
}
export async function deleteBoard(id: string) {
  await request<void>(boardPath(id), 'DELETE');
  await Promise.allSettled([forgetBoard(id), forgetBoardAssets(id)]);
}
export const joinBoard = (token: string) =>
  request<{ id: string; role: Role }>('/api/join', 'POST', { token });
export async function shareBoard(id: string, role: Exclude<Role, 'owner'>) {
  const { token } = await request<{ token: string }>(boardPath(id) + '/share', 'POST', { role });
  return location.origin + '/#join=' + encodeURIComponent(token);
}
export interface Invitation {
  id: string;
  role: Exclude<Role, 'owner'>;
  createdAt: number;
  joinedCount: number;
}
export const listInvitations = async (id: string) =>
  (await request<{ invitations: Invitation[] }>(boardPath(id) + '/share')).invitations;
export const revokeInvitation = (id: string, inviteId: string) =>
  request<void>(boardPath(id) + '/share/' + encodeURIComponent(inviteId), 'DELETE');
export const uploadAsset = (id: string, file: File) =>
  request<Asset>(boardPath(id) + '/assets?name=' + encodeURIComponent(file.name), 'POST', file);
