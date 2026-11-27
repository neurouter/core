import * as z from 'zod';

/**
 * Neurouter overlay format (`*.overlay.yaml`, backend spec §8.4). Overlays act on the tool model,
 * not on the raw spec, so a re-imported spec keeps its curation. Selectors (keys of `tools`):
 * `operationId:<id>`, `"<METHOD> <path>"`, `graphql:<Query|Mutation>.<field>`, `tag:<tag>`, `"*"`.
 */

const JsonObject = z.record(z.string(), z.unknown());

export const OverlayRisk = z
  .object({ readOnly: z.boolean(), destructive: z.boolean(), idempotent: z.boolean(), openWorld: z.boolean(), write: z.boolean() })
  .partial()
  .strict();
export type OverlayRisk = z.infer<typeof OverlayRisk>;

export const OverlayArgs = z
  .object({
    /** original arg name → agent-visible name */
    rename: z.record(z.string(), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)),
    /** args removed from the agent-visible schema (re-added by the request builder with their defaults) */
    hide: z.array(z.string()),
    /** values applied when the agent omits the arg */
    defaults: JsonObject,
    describe: z.record(z.string(), z.string().max(1024)),
    enum: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1)),
    required: z.array(z.string()),
  })
  .partial()
  .strict();
export type OverlayArgs = z.infer<typeof OverlayArgs>;

export const OverlayResponse = z
  .object({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
    flatten: z.record(z.string(), z.string()),
    maxItems: z.number().int().min(1).max(10_000),
    maxBytes: z.number().int().min(256).max(16 * 1024 * 1024),
    redact: z.array(z.string()),
  })
  .partial()
  .strict();
export type OverlayResponse = z.infer<typeof OverlayResponse>;

export const OverlayExample = z.object({ title: z.string().max(200).optional(), arguments: JsonObject }).strict();
export type OverlayExample = z.infer<typeof OverlayExample>;

export const OverlayToolEntry = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'tool names are snake_case: ^[a-z][a-z0-9_]{0,63}$'),
    title: z.string().max(200),
    description: z.string().max(4096),
    hidden: z.boolean(),
    pinned: z.boolean(),
    deprecated: z.boolean(),
    risk: OverlayRisk,
    tags: z.array(z.string().max(64)),
    args: OverlayArgs,
    response: OverlayResponse,
    examples: z.array(OverlayExample).max(20),
    graphql: z.object({ selection: z.string() }).strict(),
    idempotencyHeader: z.string(),
    /** The built-in mock (list tools): `order` without sort params, `"<field> asc|desc"` or `none` (insertion order); default: newest first where the API lists so. */
    mock: z.object({ order: z.string().regex(/^(none|[A-Za-z_][A-Za-z0-9_]* (asc|desc))$/, 'order is "<field> asc", "<field> desc" or "none"') }).partial().strict(),
    /**
     * Contract 2 (writes): the read tool of the write's target, e.g. `get_order`. Dry-run plans and confirmations
     * name the target with a human label, and a write answers `{before, after, response}`. `label`: the fields of
     * the read that name the entity (default: name/title/number/status/total-like fields).
     */
    readBack: z.union([
      z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      z.object({ tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), label: z.array(z.string().max(100)).max(5).optional() }).strict(),
    ]),
  })
  .partial()
  .strict();
export type OverlayToolEntry = z.infer<typeof OverlayToolEntry>;

export const OverlayComposite = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(4096),
    inputSchema: JsonObject.default({ type: 'object', properties: {} }),
    write: z.boolean().default(false),
    tags: z.array(z.string()).optional(),
    pinned: z.boolean().optional(),
    script: z.string().min(1).max(16384),
  })
  .strict();
export type OverlayComposite = z.infer<typeof OverlayComposite>;

export const OverlayProfile = z.object({ tools: z.array(z.string()) }).strict();

export const Overlay = z
  .object({
    overlay: z.literal(1),
    info: z.object({ title: z.string().optional(), notes: z.string().optional() }).strict().optional(),
    defaults: z.object({ hidden: z.boolean().optional() }).strict().optional(),
    tools: z.record(z.string(), OverlayToolEntry).optional(),
    composites: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), OverlayComposite).optional(),
    profiles: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), OverlayProfile).optional(),
  })
  .strict();
export type Overlay = z.infer<typeof Overlay>;

export const OVERLAY_TOOL_FIELDS = ['name', 'title', 'description', 'hidden', 'pinned', 'tags', 'risk', 'args', 'response', 'examples', 'readBack'] as const;
export const OverlayToolField = z.enum(OVERLAY_TOOL_FIELDS);
export type OverlayToolField = z.infer<typeof OverlayToolField>;

/** Structured overlay edits from the console (backend §14.6), applied to the YAML AST (comments preserved). */
export const OverlayPatchOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), selector: z.string().min(1), field: OverlayToolField, value: z.unknown() }),
  z.object({ op: z.literal('unset'), selector: z.string().min(1), field: OverlayToolField }),
  z.object({ op: z.literal('set_default'), field: z.literal('hidden'), value: z.boolean() }),
  z.object({ op: z.literal('set_composite'), name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), value: OverlayComposite }),
  z.object({ op: z.literal('remove_composite'), name: z.string() }),
  z.object({ op: z.literal('set_profile'), name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), tools: z.array(z.string()) }),
]);
export type OverlayPatchOp = z.infer<typeof OverlayPatchOp>;

/** One logical change between two overlay versions (draft vs published), for change counts and diffs. */
export const OverlayChange = z.object({
  kind: z.enum(['tool', 'default', 'composite', 'profile', 'info']),
  /** selector, composite name or profile name */
  target: z.string(),
  field: z.string().nullable(),
  change: z.enum(['added', 'removed', 'changed']),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type OverlayChange = z.infer<typeof OverlayChange>;

/** JSON Schema of the overlay format (editor completion, `neurouter validate --print-schema`). */
export function overlayJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Overlay, { io: 'input' }) as Record<string, unknown>;
}
