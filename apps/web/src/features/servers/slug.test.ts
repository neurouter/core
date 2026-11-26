import { describe, expect, it } from 'vitest';
import { isValidSlug, slugify } from './slug';

describe('slugify', () => {
  it('lowercases, strips accents and joins words with single hyphens', () => {
    expect(slugify('Acme Orders API (v2)')).toBe('acme-orders-api-v2');
    expect(slugify('  Lümen   Inventory ')).toBe('lumen-inventory');
  });
  it('caps at 40 characters without a trailing hyphen', () => {
    expect(slugify('a'.repeat(39) + ' b')).toHaveLength(39);
  });
  it('keeps a trailing hyphen while typing when trim is off', () => {
    expect(slugify('acme ', false)).toBe('acme-');
  });
  it('validates against the shared Slug schema', () => {
    expect(isValidSlug('acme-orders')).toBe(true);
    expect(isValidSlug('Acme')).toBe(false);
    expect(isValidSlug('ab')).toBe(false);
  });
});
