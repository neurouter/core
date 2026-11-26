import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 over the RFC 8785 canonical JSON of a value. */
export function jcsHash(value: unknown): string {
  return sha256Hex(canonicalize(value) ?? 'null');
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function jsonBytes(v: unknown): number {
  return utf8Bytes(JSON.stringify(v) ?? 'null');
}

/** RFC 6901 pointer segment escaping. */
export function escapePointer(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
