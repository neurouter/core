import { Slug } from '@/contract';

/**
 * "Acme Orders API (v2)" → "acme-orders-api-v2": lowercase, single hyphens, ≤ 40 chars (the
 * server slug is part of the MCP URL). `trim: false` keeps a trailing hyphen while typing.
 */
export function slugify(name: string, trim = true): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/g, '')
    .slice(0, 40);
  return trim ? s.replace(/-+$/g, '') : s;
}

export function isValidSlug(slug: string): boolean {
  return Slug.safeParse(slug).success;
}
