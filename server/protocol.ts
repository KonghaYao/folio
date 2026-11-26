import { validRecord } from './records';

/** Boundaries shared by the HTTP layer and the persistence layer. */
export type Role = 'owner' | 'editor' | 'viewer';
export type ShareRole = Exclude<Role, 'owner'>;
export type JsonObject = Record<string, unknown>;

export interface BoardMeta {
  id: string;
  title: string;
  rev: number;
  updatedAt: number;
}

export interface BoardSnapshot extends BoardMeta {
  role: Role;
  items: Record<string, JsonObject>;
}

export interface Mutation {
  opId: string;
  baseRev: number;
  put: Record<string, JsonObject>;
  remove: string[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 410 | 413 | 415 | 429,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export const MAX_MUTATION_BYTES = 4 * 1024 * 1024;
export const MAX_ASSET_BYTES = 24 * 1024 * 1024;
export const MAX_BOARD_BYTES = 32 * 1024 * 1024;
export const MAX_BOARD_ASSET_BYTES = 256 * 1024 * 1024;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[\w.:~-]{1,160}$/.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value)
  );
}

export function parseMutation(body: JsonObject): Mutation {
  const { opId, baseRev, put = {}, remove = [] } = body;
  if (
    !isKey(opId) ||
    typeof baseRev !== 'number' ||
    !Number.isSafeInteger(baseRev) ||
    baseRev < 0
  ) {
    throw new ApiError(400, 'invalid_revision_or_operation_id');
  }
  if (!isObject(put) || !Array.isArray(remove) || !remove.every(isKey)) {
    throw new ApiError(400, 'invalid_changes');
  }
  const entries = Object.entries(put);
  const count = entries.length + remove.length;
  if (
    !count ||
    count > 4096 ||
    new Set([...Object.keys(put), ...remove]).size !== count ||
    !entries.every(([key, value]) => isKey(key) && validRecord(key, value))
  ) {
    throw new ApiError(400, 'invalid_changes');
  }
  return { opId, baseRev, put: put as Record<string, JsonObject>, remove };
}

export function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    throw new ApiError(400, 'invalid_title');
  }
  return value.trim();
}

export function parseShareRole(value: unknown): ShareRole {
  if (value !== 'editor' && value !== 'viewer') throw new ApiError(400, 'invalid_share_role');
  return value;
}
