import type { OutputSchemaMode, ToolDef } from '@neurouter/shared';
import { hashCanonical } from '../../kernel/lib/jcs.js';
import type { RunContext } from '../pipeline/context.js';
import { resolveVisibleTool } from '../pipeline/pipeline.js';
import type { Draft, ErrorSpec } from './draft.js';
import { buildError } from './errors.js';
import { envelopeErrors, typedErrors } from './schema.js';
import { type StateSource } from './state.js';
import { BUDGET, type Envelope, type ErrorInfo, type StateFlag } from './types.js';
import type { McpToolResult } from './v1.js';

/**
 * The contract-2 result: the envelope as the only content item (compact JSON) and, identically, as
 * `structuredContent`; `isError` = `!ok`. The only constructor of a contract-2 tool result.
 */
export function envelopeResult(env: Envelope, meta: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(env) }], structuredContent: env as unknown as Record<string, unknown>, ...(env.ok ? {} : { isError: true }), _meta: meta };
}

/** Tools whose typed outputSchema a response did not match: listed without outputSchema from then on (per build). */
export class TypedSchemaIssues {
  private readonly dropped = new Set<string>();
  key(buildId: string, tool: string): string {
    return `${buildId}|${tool}`;
  }
  has(buildId: string, tool: string): boolean {
    return this.dropped.has(this.key(buildId, tool));
  }
  /** true the first time a tool is dropped */
  drop(buildId: string, tool: string): boolean {
    const k = this.key(buildId, tool);
    if (this.dropped.has(k)) return false;
    if (this.dropped.size > 10_000) this.dropped.clear();
    this.dropped.add(k);
    return true;
  }
}

export interface RenderDeps {
  state: StateSource;
  typed: TypedSchemaIssues;
  /** nearest visible tool names for an unknown tool (search index, top 3) */
  closest: (ctx: RunContext, name: string) => Promise<string[]>;
  /** a typed response did not match its schema: record a tool issue, re-list (once per build × tool) */
  onSchemaMismatch?: (ctx: RunContext, tool: ToolDef, errors: string[]) => void;
  log: { warn: (o: object, m: string) => void };
  now: () => number;
  /** throw when an envelope fails the envelope schema or a budget (tests); otherwise log */
  strict?: boolean;
}

export interface RenderInput {
  /** the tool name the agent called (`call_tool` renders as the inner tool) */
  name: string;
  args: Record<string, unknown>;
  /** the API tool behind the call, when there is one (typed outputSchema, write state) */
  tool?: ToolDef | null;
  draft: Draft;
}

/** `writes` as the agent experiences it: off without write scope or when the environment is read-only. */
export function writesState(ctx: RunContext): 'off' | 'on' | 'confirm' {
  const w = ctx.bundle.environment.writes;
  if (!w.enabled || !ctx.principal.scopes.includes('tools:write')) return 'off';
  return w.confirm !== 'none' ? 'confirm' : 'on';
}

/** The visible API tools of the principal (next calls and closest names only use these). */
export function visibleApiTools(ctx: RunContext): ToolDef[] {
  return ctx.bundle.build.tools.filter((t) => resolveVisibleTool(ctx, t.name) !== null);
}

/** Builds the error object of a failed draft (also used for errors raised inside scripts). */
export async function errorInfoFor(ctx: RunContext, spec: ErrorSpec, closest?: (ctx: RunContext, name: string) => Promise<string[]>): Promise<ErrorInfo> {
  const names = spec.code === 'unknown_tool' && closest ? await closest(ctx, spec.name ?? '') : undefined;
  return buildError(spec, { env: ctx.environment.slug, tools: visibleApiTools(ctx), ...(names ? { closest: names } : {}) });
}

/**
 * Contract 2 (contract-v2 §2): turns a producer's draft into the envelope `{ok,data,page,truncated,error,
 * state[,hint]}` with the state block, the error object, typed-schema validation and the budgets.
 */
export class EnvelopeRenderer {
  constructor(private readonly d: RenderDeps) {}

  async render(ctx: RunContext, input: RenderInput, outputSchema: OutputSchemaMode): Promise<McpToolResult> {
    const draft = input.draft;
    const error = draft.ok ? null : await errorInfoFor(ctx, draft.error ?? { code: 'unavailable', message: `${input.name} failed.` }, this.d.closest);
    const flags: StateFlag[] = [...(draft.flags ?? [])];
    const env: Envelope = {
      ok: draft.ok,
      data: draft.data === undefined ? null : draft.data,
      page: draft.page ?? null,
      truncated: draft.truncated ?? null,
      error,
      state: { task: '', call: 0 },
    };
    // typed outputSchema: validate before sending; a mismatch is sent flagged (never rejected by the client)
    const tool = input.tool ?? null;
    if (outputSchema === 'typed' && tool?.outputSchema && draft.ok && !this.d.typed.has(ctx.bundle.build.id, tool.name)) {
      const errs = typedErrors(`${tool.defHash}|typed`, tool.outputSchema, { ...env, state: {} });
      if (errs.length) {
        flags.push('schema_mismatch');
        if (this.d.typed.drop(ctx.bundle.build.id, tool.name)) this.d.onSchemaMismatch?.(ctx, tool, errs);
      }
    }
    const write = Boolean(tool?.risk.write || draft.write);
    env.state = await this.d.state.next({
      tenantId: ctx.tenantId,
      taskId: ctx.taskId,
      requestId: ctx.requestId,
      env: ctx.environment.slug,
      writes: writesState(ctx),
      callKey: hashCanonical({ n: input.name, a: input.args }),
      resultKey: hashCanonical({ ok: env.ok, d: env.data ?? null, c: error?.code ?? null }),
      write,
      ...(draft.wrote ? { wrote: draft.wrote } : {}),
      ...(draft.left ? { left: draft.left } : {}),
      ...(draft.scriptCalls !== undefined ? { scriptCalls: draft.scriptCalls } : {}),
      flags,
      ...(ctx.environment.kind === 'prod' ? { fullFlags: ['prod'] as StateFlag[] } : {}),
      ...(draft.flagPaths ? { flagPaths: draft.flagPaths } : {}),
      now: this.d.now(),
    });
    if (draft.hint) env.hint = draft.hint.length <= BUDGET.hintChars ? draft.hint : `${draft.hint.slice(0, BUDGET.hintChars - 1)}…`;
    this.selfCheck(env, input.name);
    return envelopeResult(env, draft.meta ?? {});
  }

  private selfCheck(env: Envelope, name: string): void {
    const problems = envelopeErrors(env);
    if (env.error && JSON.stringify(env.error).length > BUDGET.errorChars) problems.push(`error over ${BUDGET.errorChars} chars`);
    if (JSON.stringify(env.state).length > BUDGET.stateChars) problems.push(`state over ${BUDGET.stateChars} chars`);
    if (!problems.length) return;
    if (this.d.strict) throw new Error(`envelope for ${name} violates contract 2: ${problems.join('; ')}`);
    this.d.log.warn({ tool: name, problems }, 'contract-2 envelope self-check failed');
  }
}
