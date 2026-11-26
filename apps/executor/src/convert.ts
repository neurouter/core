/**
 * Converts values coming out of Monty (Python dicts are `Map`s, sets are `Set`s, big ints may be
 * `bigint`) into plain JSON values. Anything without a JSON form becomes its string representation.
 */
export function toJson(value: unknown, depth = 0): unknown {
  if (depth > 200) return '<nested too deep>';
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    case 'function':
    case 'symbol':
      return String(value);
  }
  if (Array.isArray(value)) return value.map((v) => toJson(v, depth + 1));
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) out[typeof k === 'string' ? k : String(toJson(k, depth + 1))] = toJson(v, depth + 1);
    return out;
  }
  if (value instanceof Set) return [...value].map((v) => toJson(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJson(v, depth + 1);
    return out;
  }
  return String(value);
}

/** Byte length of the compact JSON form (`null` for `undefined`). */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

/** Truncates a UTF-8 string to at most `max` bytes without splitting a code point. */
export function truncateUtf8(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = Buffer.from(s, 'utf8').subarray(0, max).toString('utf8');
  if (out.endsWith('�')) out = out.slice(0, -1);
  return out;
}
