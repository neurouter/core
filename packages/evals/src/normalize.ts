/**
 * Normalized answer matching: does a free-text answer state an expected value? Literal first, then
 * by kind: text and ids (case, whitespace, punctuation, `_`/`-` as spaces, diacritics), booleans
 * (true/yes/valid/active vs false/no/not valid/inactive, field-aware), numbers (thousand separators,
 * decimals, minor units: 1250 matches "12.50" when the value is a money amount), dates and times
 * (ISO vs natural language, unix seconds, UTC vs explicit offsets). Long texts (templates, bodies)
 * match by token recall (≥ 80%).
 */
import type { AnswerKind } from '@neurouter/shared';

export type MatchHow = 'literal' | 'normalized';

export interface MatchContext {
  /** The field the value came from (last path key): `valid`, `amount`, `created`, … */
  field?: string | null;
  kind?: AnswerKind;
  /** The value is an amount in minor units (a `currency` sibling, or the spec says so). */
  minorUnits?: boolean;
}

const MONEY_FIELD = /(^|_)(amount|price|total|subtotal|balance|fee|cost|tax|amount_due|amount_paid|amount_remaining|unit_amount)(_|$)/i;
const EPOCH_FIELD = /^(created|updated|expires_at|arrival_date|available_on|date|period_start|period_end|canceled_at|ended_at|start_date|due_date|paid_at|finalized_at|timestamp)$|_at$|_on$/i;
const ISO_DATE = /^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?$/;

/**
 * Typographic punctuation as ASCII: curly quotes and apostrophes (’ ‘ ʼ ′ → ', “ ” „ ″ → "), dashes and the minus
 * sign (‐ ‑ ‒ – — ― − → -), non-breaking and narrow spaces. Models write "can’t" (U+2019) as often as "can't".
 */
export function normPunct(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC\uFF07]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\uFF02]/g, '"')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/[\u00A0\u2007\u202F\u2009\u200A]/g, ' ');
}

export function normText(s: string): string {
  return normPunct(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_\-/\\|]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.]+/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function inferKind(value: unknown, field?: string | null): AnswerKind {
  const f = field ?? '';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 100_000_000 && value < 10_000_000_000 && EPOCH_FIELD.test(f)) return 'date';
    return MONEY_FIELD.test(f) ? 'money' : 'number';
  }
  if (typeof value === 'string') {
    if (value === 'true' || value === 'false') return 'boolean';
    if (ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))) return 'date';
    if (/^-?\d+(\.\d+)?$/.test(value)) return MONEY_FIELD.test(f) ? 'money' : 'number';
    if (f === 'id' || /_id$/.test(f) || /^[A-Za-z0-9]+[_-][A-Za-z0-9_-]+$/.test(value)) return 'id';
  }
  return 'text';
}

/** Whether `answer` states `expected` (normalized by kind). */
export function answerHas(answer: string, expected: unknown, ctx: MatchContext = {}): { ok: boolean; how: MatchHow | null } {
  if (expected === null || expected === undefined) return { ok: false, how: null };
  const exp = typeof expected === 'string' ? expected : typeof expected === 'number' || typeof expected === 'boolean' ? String(expected) : JSON.stringify(expected);
  // a literal hit counts for text values only ("11" must not match "110"; booleans are matched by meaning)
  if (typeof expected === 'string' && exp.length >= 3 && !/^-?\d+(\.\d+)?$/.test(exp) && exp !== 'true' && exp !== 'false' && includesBounded(answer, exp)) return { ok: true, how: 'literal' };
  const kind = ctx.kind ?? inferKind(expected, ctx.field);
  const ok = (() => {
    switch (kind) {
      case 'boolean':
        return booleanStated(answer, expected === true || expected === 'true', ctx.field ?? null);
      case 'number':
      case 'money':
        return numberStated(answer, Number(expected), kind === 'money' || !!ctx.minorUnits);
      case 'date':
        return dateStated(answer, expected) || textStated(answer, exp);
      default:
        return textStated(answer, exp);
    }
  })();
  return { ok, how: ok ? 'normalized' : null };
}

/** `exp` occurs in `answer` not glued to a letter or digit (`topup_1` is not in `topup_12`). */
function includesBounded(answer: string, exp: string): boolean {
  const word = /[\p{L}\p{N}]/u;
  for (let i = answer.indexOf(exp); i >= 0; i = answer.indexOf(exp, i + 1)) {
    const before = answer[i - 1];
    const after = answer[i + exp.length];
    if ((!before || !word.test(before) || !word.test(exp[0]!)) && (!after || !word.test(after) || !word.test(exp[exp.length - 1]!))) return true;
  }
  return false;
}

function textStated(answer: string, exp: string): boolean {
  const a = ` ${normText(answer)} `;
  const e = normText(exp);
  if (!e) return false;
  if (a.includes(` ${e} `)) return true;
  // one-word values in another form: plural ("day" = "every 50 days") and the interval adverbs ("daily")
  if (/^\p{L}{3,}$/u.test(e) && wordForms(e).some((w) => a.includes(` ${w} `))) return true;
  // glued ids/names: "applepay" vs "apple pay", "HelloWorld" vs "hello-world"
  const glue = (s: string) => s.replace(/\s+/g, '');
  if (e.length >= 6 && !/\d/.test(e) && glue(a).includes(glue(e))) return true;
  // long values (template contents, descriptions): token recall
  const et = e.split(' ').filter((t) => t.length > 1);
  if (et.length >= 8) {
    const at = new Set(a.split(' '));
    return et.filter((t) => at.has(t)).length / et.length >= 0.8;
  }
  return false;
}

const INTERVAL_ADVERBS: Record<string, string[]> = { day: ['daily'], week: ['weekly'], month: ['monthly'], year: ['yearly', 'annually', 'annual'], hour: ['hourly'], minute: ['minutely'] };

/** Other forms of a one-word value: its plural, and for interval units the adverb (`day` → `days`, `daily`). */
function wordForms(w: string): string[] {
  const out = [`${w}s`, /(s|x|z|ch|sh)$/.test(w) ? `${w}es` : '', /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : '', ...(INTERVAL_ADVERBS[w] ?? [])];
  return out.filter(Boolean);
}

const NEG = /\b(not|no|isn'?t|is not|aren'?t|wasn'?t|never|non|un|in)\s*[-]?\s*$/i;

/** Booleans: the literal, yes/no, or the field word with / without a negation (`not valid`, `inactive`). */
function booleanStated(answer: string, value: boolean, field: string | null): boolean {
  const a = answer.toLowerCase();
  const word = field ? field.replace(/^(is|has|can)_/, '').replace(/_/g, ' ').toLowerCase() : null;
  if (value) {
    if (/\b(true|yes)\b/.test(a)) return true;
    if (word && wordOccurrences(a, word).some((i) => !NEG.test(a.slice(Math.max(0, i - 12), i)))) return true;
    return /\b(enabled|active|valid|on)\b/.test(a) && !/\b(not|in)(active|valid)|\bnot (enabled|active|valid)\b|\bdisabled\b/.test(a);
  }
  if (/\bfalse\b/.test(a)) return true;
  if (word && (wordOccurrences(a, word).some((i) => NEG.test(a.slice(Math.max(0, i - 12), i))) || new RegExp(`\\b(in|un|non-?)${escapeRe(word)}\\b`).test(a))) return true;
  return /\b(no|disabled|inactive|invalid|not (enabled|active|valid|set))\b/.test(a);
}

function wordOccurrences(a: string, w: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`\\b${escapeRe(w)}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(a))) out.push(m.index);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Numbers in a text: `1,234.5`, `1 234`, `1'234`, `12.50`, `-3`, `1.2k` / `3M`. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /-?\d{1,3}(?:[,\u00a0\u202f' ]\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    let n = Number(raw.replace(/[,\u00a0\u202f' ]/g, ''));
    const suffix = text.slice(m.index + raw.length, m.index + raw.length + 1);
    if (/^[kK]$/.test(suffix)) n *= 1000;
    else if (/^[M]$/.test(suffix)) n *= 1_000_000;
    if (Number.isFinite(n)) out.push(n);
    // "1 234" may also be two numbers
    if (/ /.test(raw)) for (const part of raw.split(' ')) out.push(Number(part.replace(/,/g, '')));
  }
  return out;
}

function numberStated(answer: string, value: number, minor: boolean): boolean {
  if (!Number.isFinite(value)) return false;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
  return numbersIn(answer).some((n) => near(n, value) || (minor && (near(n * 100, value) || near(n, value * 100))));
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function monthIndex(s: string): number {
  const p = s.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(p));
}

/** Calendar dates (y, m 1..12, d) and, when given, minute-precision instants stated in a text. */
export function datesIn(text: string): Array<{ y: number; m: number; d: number; instant: number | null }> {
  const out: Array<{ y: number; m: number; d: number; instant: number | null }> = [];
  const t = text.toLowerCase();
  const timeAfter = (idx: number): number | null => {
    const m = /^[,\s]*(?:at\s+)?(\d{1,2}):(\d\d)(?::(\d\d))?\s*(am|pm)?\s*(utc|gmt|z\b|[+-]\d\d:?\d\d)?/.exec(t.slice(idx, idx + 40));
    if (!m) return null;
    let h = Number(m[1]);
    if (m[4] === 'pm' && h < 12) h += 12;
    if (m[4] === 'am' && h === 12) h = 0;
    return h * 60 + Number(m[2]) - offsetMinutes(m[5]);
  };
  const push = (y: number, mo: number, d: number, end: number) => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return;
    const tm = timeAfter(end);
    out.push({ y, m: mo, d, instant: tm === null ? null : Date.UTC(y, mo - 1, d) / 60000 + tm });
  };
  let m: RegExpExecArray | null;
  const iso = /(\d{4})-(\d\d)-(\d\d)(?:[t ](\d\d):(\d\d)(?::\d\d(?:\.\d+)?)?\s*(z|[+-]\d\d:?\d\d)?)?/g;
  while ((m = iso.exec(t))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4]) out.push({ y, m: mo, d, instant: Date.UTC(y, mo - 1, d) / 60000 + Number(m[4]) * 60 + Number(m[5]) - offsetMinutes(m[6]) });
    else push(y, mo, d, m.index + m[0].length);
  }
  const mdy = new RegExp(`${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'g');
  while ((m = mdy.exec(t))) push(Number(m[3]), monthIndex(m[1]!) + 1, Number(m[2]), m.index + m[0].length);
  const dmy = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}\\.?,?\\s+(\\d{4})`, 'g');
  while ((m = dmy.exec(t))) push(Number(m[3]), monthIndex(m[2]!) + 1, Number(m[1]), m.index + m[0].length);
  const slash = /(\d{4})\/(\d\d)\/(\d\d)/g;
  while ((m = slash.exec(t))) push(Number(m[1]), Number(m[2]), Number(m[3]), m.index + m[0].length);
  return out;
}

function offsetMinutes(tz: string | undefined): number {
  if (!tz || /^(utc|gmt|z)$/.test(tz)) return 0;
  const m = /([+-])(\d\d):?(\d\d)/.exec(tz);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

function dateStated(answer: string, expected: unknown): boolean {
  const ms = typeof expected === 'number' ? expected * 1000 : typeof expected === 'string' ? Date.parse(expected) : NaN;
  if (!Number.isFinite(ms)) return false;
  const e = new Date(ms);
  const eMin = Math.floor(ms / 60000);
  const hasTime = typeof expected === 'number' || (typeof expected === 'string' && /\d\d:\d\d/.test(expected));
  return datesIn(answer).some((d) => {
    if (d.instant !== null && hasTime) return Math.abs(d.instant - eMin) <= 1;
    // a date without a time: the UTC date, or ±1 day (the answer may use a local time zone)
    const day = Date.UTC(d.y, d.m - 1, d.d);
    const eDay = Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate());
    return d.instant === null ? Math.abs(day - eDay) <= (hasTime ? 86_400_000 : 0) : day === eDay;
  });
}
