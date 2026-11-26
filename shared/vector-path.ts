/** Portable, bounded vector geometry. Coordinates are local to a resizable Quickdraw shape. */
export interface VectorPath {
  d: string;
  w: number;
  h: number;
  strokeWidth: number;
  fill: string;
}

const arity: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  Q: 4,
  T: 2,
  C: 6,
  S: 4,
  A: 7,
  Z: 0,
};
const token = /[MLHVQTCSAZ]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/iy;
const color = /^#[\da-f]{6}$/i;

export function vectorPathError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return 'Expected vector path properties.';
  const { d, w, h, strokeWidth, fill } = value as VectorPath;
  if (typeof d !== 'string' || d.length > 16_384 || !/^[\s]*m/i.test(d))
    return 'd must start with M or m and contain at most 16384 characters.';
  if (![w, h].every((n) => Number.isFinite(n) && n > 0 && n <= 1_000_000))
    return 'w and h must be positive and at most 1000000.';
  if (!Number.isFinite(strokeWidth) || strokeWidth < 0 || strokeWidth > 128)
    return 'strokeWidth must be between 0 and 128.';
  if (typeof fill !== 'string' || (fill !== 'none' && !color.test(fill)))
    return 'fill must be none or #RRGGBB.';
  let command = '',
    count = 0,
    commands = 0,
    end = 0;
  const incomplete = () =>
    arity[command] && (!count || count % arity[command])
      ? command + ' requires groups of ' + arity[command] + ' numbers (received ' + count + ').'
      : undefined;
  while (end < d.length) {
    if (/[\s,]/.test(d[end])) {
      end++;
      continue;
    }
    token.lastIndex = end;
    const match = token.exec(d);
    if (!match)
      return (
        'Unexpected path token at d[' + end + ']. Use M L H V Q T C S A Z, absolute or relative.'
      );
    end = token.lastIndex;
    const part = match[0],
      upper = part.toUpperCase();
    if (Object.hasOwn(arity, upper)) {
      const error = incomplete();
      if (error) return error;
      command = upper;
      count = 0;
      if (++commands > 1024) return 'Path exceeds 1024 commands.';
    } else {
      if (!arity[command]) return 'Expected a path command at d[' + match.index + '].';
      const n = Number(part);
      if (!Number.isFinite(n) || Math.abs(n) > 1_000_000) return 'Path coordinate exceeds 1000000.';
      if (command === 'A') {
        const index = count % 7;
        if (index < 2 && n < 0) return 'Arc radii must be nonnegative.';
        if ((index === 3 || index === 4) && !['0', '1'].includes(part))
          return 'Separate arc flags with spaces and use 0 or 1.';
      }
      count++;
    }
  }
  return incomplete();
}
export function validVectorPath(value: unknown): value is VectorPath {
  return vectorPathError(value) === undefined;
}
