import { describe, expect, it } from 'vitest';
import { answerHas, datesIn, inferKind, normText, numbersIn } from './normalize.js';

const has = (answer: string, v: unknown, ctx = {}) => answerHas(answer, v, ctx).ok;

describe('normalized answer matching', () => {
  it('text and ids: case, whitespace, punctuation, underscores, glued words', () => {
    expect(normText('  Apple_Pay!  ')).toBe('apple pay');
    expect(has('Wallet provider: Apple Pay', 'apple_pay')).toBe(true);
    expect(has('network **Mastercard**', 'mastercard')).toBe(true);
    expect(has('repo `hello-world`', 'Hello-World')).toBe(true);
    expect(has('see topup_12', 'topup_1')).toBe(false);
    expect(answerHas('id coupon_3', 'coupon_3').how).toBe('literal');
  });

  it('booleans by meaning, field-aware', () => {
    expect(has('The coupon is not valid.', false, { field: 'valid' })).toBe(true);
    expect(has('It is invalid.', false, { field: 'valid' })).toBe(true);
    expect(has('The coupon is valid.', false, { field: 'valid' })).toBe(false);
    expect(has('The coupon is valid.', true, { field: 'valid' })).toBe(true);
    expect(has('The link is inactive.', false, { field: 'active' })).toBe(true);
    expect(has('Yes, it is the default.', true, { field: 'is_account_default' })).toBe(true);
    expect(has('Value: false', false)).toBe(true);
  });

  it('numbers: separators, decimals, minor units, no substring hits', () => {
    expect(numbersIn('1,234.50 and 1 000 and 3k')).toEqual(expect.arrayContaining([1234.5, 1000, 3000]));
    expect(has('Amount due: 1,250', 1250)).toBe(true);
    expect(has('Amount: $12.50', 1250, { minorUnits: true })).toBe(true);
    expect(has('Amount: $12.50', 1250)).toBe(false);
    expect(has('I found 110 items', 11)).toBe(false);
    expect(has('amount 50000 (USD 500.00)', 50000, { field: 'amount' })).toBe(true);
    expect(inferKind(1250, 'unit_amount')).toBe('money');
  });

  it('dates and times: ISO vs natural language, time zones, unix seconds', () => {
    const iso = '2025-09-23T05:04:19.330Z';
    expect(has('Created September 23, 2025 at 05:04:19 UTC', iso)).toBe(true);
    expect(has('created 23 Sep 2025, 5:04 AM UTC', iso)).toBe(true);
    expect(has('created 2025-09-23 07:04 +02:00', iso)).toBe(true);
    expect(has('created September 23, 2025', iso)).toBe(true);
    expect(has('created September 24, 2025 at 05:04 UTC', iso)).toBe(false);
    expect(inferKind(1768415912, 'created')).toBe('date');
    expect(has('Created on January 14, 2026 at 18:38 UTC', 1768415912, { field: 'created' })).toBe(true);
    expect(datesIn('due 2026/01/15')[0]).toMatchObject({ y: 2026, m: 1, d: 15 });
  });

  it('long values match by token recall', () => {
    const tpl = '# Object files\n*.o\n*.ko\n*.obj\n*.elf\n# Precompiled Headers\n*.gch\n*.pch\n# Libraries\n*.lib\n*.a';
    expect(has(`Here it is:\n${tpl.replace(/\n/g, ' ')}`, tpl)).toBe(true);
    expect(has('It ignores object files.', tpl)).toBe(false);
  });
});
