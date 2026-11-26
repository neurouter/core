import * as z from 'zod';

/** Basic OSS policies (backend §9.8). Evaluated in order; the first matching `deny` wins. */
export const PolicyMatcher = z
  .object({ tools: z.array(z.string().min(1)).min(1).optional(), tags: z.array(z.string().min(1)).min(1).optional() })
  .refine((m) => m.tools !== undefined || m.tags !== undefined, 'give tools or tags');
export type PolicyMatcher = z.infer<typeof PolicyMatcher>;

const isValidRegex = (s: string) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
};

/** `HH:MM-HH:MM <IANA zone>`, e.g. `08:00-18:00 Europe/Helsinki` (deny when outside these hours). */
export const OUTSIDE_HOURS_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d(?: [A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)?$/;

export const PolicyWhen = z.object({
  argMatches: z.record(z.string(), z.string().refine(isValidRegex, 'invalid regular expression')).optional(),
  outsideHours: z.string().regex(OUTSIDE_HOURS_RE, 'expected "HH:MM-HH:MM Area/City"').optional(),
});

export const PolicySequence = z.object({ first: PolicyMatcher, then: PolicyMatcher, within: z.literal('task').default('task') });

export const PolicyDeny = z
  .object({
    tools: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    when: PolicyWhen.optional(),
    sequence: PolicySequence.optional(),
    /** Accepted here too (the §6.2 example writes `within` next to `sequence`). */
    within: z.literal('task').optional(),
  })
  .refine((d) => d.tools !== undefined || d.tags !== undefined || d.when !== undefined || d.sequence !== undefined, 'a deny rule needs tools, tags, when or sequence');

export const Policy = z.object({
  name: z.string().min(1).max(100),
  deny: PolicyDeny,
  message: z.string().max(500).optional(),
});
export type Policy = z.infer<typeof Policy>;

/** Built-in policy on every environment (§9.8). */
export const BUILTIN_POLICY_NO_RAW_URLS = 'no-raw-urls';
