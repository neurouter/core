/**
 * In-memory mock backend state for MSW (dev mocks, tests, the static demo). Builds objects shaped
 * exactly like the `@neurouter/shared` contract from the seeds in demo-data.ts and applies
 * mutations in memory (a reload starts over).
 */
import {
  DEFAULT_LIMITS, readinessBand, type ApiKeyRow, type AuditRow, type BuildRow, type CallDetail, type EnvironmentDetail, type EvalRunRow, type IssueRow, type MatrixCell,
  type NeedGroupRow, type NeedRow, type OverlayChange, type OverlayRevisionRow, type OverlayToolEntry, type PolicyStep, type ReadinessComponent, type ReadinessSummary, type ScriptRunDetail,
  type ServerDetail, type ServerRow, type SpecPreview, type SpecRevisionRow, type SuggestionRow, type TaskDetail, type TaskResultRow, type TaskRow, type TimelineItem, type ToolDetail, type ToolRow,
  type UserRow,
} from '@neurouter/shared';
import {
  ACME_BASELINE_BREAKDOWN, ACME_BREAKDOWN, ACME_LINT, BLUEFIN_LINT, CLIENTS, DAY, ENVS, EVAL_TASK_PROMPTS, HOUR, INSTANCE, ISSUES, KEYS, LUMEN_BREAKDOWN, MIN, MODELS, NEED_GROUPS, NOW,
  PEOPLE, RUNS, SERVERS, TASK_GOALS, TOOLS_BY_SERVER, ago, iso, rng, type EnvSeed, type ServerSeed, type ToolSeed,
} from './demo-data';

export type Entry = OverlayToolEntry;
type Mode = 'tool' | 'code';

/* ================================================================== helpers */

export const tokens = (v: unknown) => Math.ceil(new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v ?? null)).length / 4);
export const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
};
const ref = (p: { id: string; name: string }) => ({ id: p.id, name: p.name });
const snakeOf = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Overlay selector of a seed tool (`operationId:<id>` or `graphql:<Root>.<field>`), = ToolRow.key. */
export const keyOf = (t: ToolSeed) => (t.field ? `graphql:${t.field}` : `operationId:${t.orig}`);

/* ================================================================== response fields (shaping) */

const CUSTOMER_FIELDS: [string, string, number][] = [
  ['id', 'string', 6], ['email', 'string', 8], ['name', 'string', 6], ['phone', 'string', 7], ['addresses', 'array', 110], ['internal_notes', 'string', 38], ['audit', 'object', 45], ['segments', 'array', 20],
];
const ORDER_FIELDS: [string, string, number][] = [
  ['id', 'string', 6], ['number', 'string', 5], ['status', 'string', 4], ['total_cents', 'integer', 4], ['currency', 'string', 3], ['customer_id', 'string', 6], ['lines', 'array', 90], ['shipping_address', 'object', 40], ['created_at', 'string', 8], ['internal_flags', 'object', 30],
];
const GENERIC_FIELDS: [string, string, number][] = [['id', 'string', 6], ['name', 'string', 8], ['status', 'string', 4], ['created_at', 'string', 8], ['metadata', 'object', 40]];

function fieldsFor(seed: ToolSeed): [string, string, number][] {
  if (/customer/.test(seed.name)) return CUSTOMER_FIELDS;
  if (/order/.test(seed.name) && !/purchase/.test(seed.name)) return ORDER_FIELDS;
  return GENERIC_FIELDS;
}
const isList = (seed: ToolSeed) => /^(list|search)_/.test(seed.name) || /s$/.test(seed.field ?? '');

function sampleValue(field: string, type: string): unknown {
  const samples: Record<string, unknown> = {
    id: 'C-1042', email: 'maya@acme.test', name: 'Maya Lindqvist', phone: '+358 40 123 4567', addresses: ['… 3 …'], internal_notes: '…', audit: { created_by: '…' }, segments: ['…'],
    number: 'ORD-55120', status: 'unpaid', total_cents: 12990, currency: 'EUR', customer_id: 'C-1042', lines: ['… 2 …'], shipping_address: { city: 'Tampere' }, created_at: '2026-10-21T09:12:00Z', internal_flags: {}, metadata: {},
  };
  return samples[field] ?? (type === 'integer' ? 1 : type === 'array' ? [] : type === 'object' ? {} : '…');
}

/* ================================================================== state */

export interface ServerState {
  seed: ServerSeed;
  name: string;
  description: string;
  /** Published overlay entries by selector key. */
  published: Record<string, Entry>;
  /** Draft entries layered over the published ones (only changed selectors). */
  draft: Record<string, Entry>;
  draftUpdatedAt: number;
  draftRev: number;
  versions: (OverlayRevisionRow & { yaml: string })[];
  specs: SpecRevisionRow[];
  envs: EnvironmentDetail[];
  exposure: ServerDetail['exposure'];
  opsTools: ServerDetail['opsTools'];
  publicReport: boolean;
  tools: ToolSeed[];
}

export interface RunState {
  row: EvalRunRow;
  number: number;
  matrix: MatrixCell[];
  breakdown: ReadinessComponent[];
  startedMs: number;
  durationMs: number;
  finalScore: number;
  recommendation: string | null;
}

export type SuggestionOp = { selector: string; field: 'name' | 'description' | 'hidden' | 'examples'; value: unknown };
export type SuggestionState = SuggestionRow & { title: string; ops: SuggestionOp[]; verifyStartedMs?: number };

export interface MockDb {
  servers: ServerState[];
  tasks: TaskRow[];
  taskDetails: Map<string, TaskDetail>;
  calls: Map<string, CallDetail>;
  scripts: Map<string, ScriptRunDetail>;
  needGroups: (NeedGroupRow & { reports: NeedRow[]; attemptedTools: { tool: string; count: number }[]; daily14: number[] })[];
  issues: (IssueRow & { evidence: string; note: string | null })[];
  keys: ApiKeyRow[];
  runs: RunState[];
  suggestions: SuggestionState[];
  adminAudit: AuditRow[];
  previews: Map<string, { preview: SpecPreview; createdMs: number; draftOps: Record<string, Entry> }>;
  users: UserRow[];
  killSwitches: { scope: 'global' | 'server' | 'environment' | 'tool'; target: string; kind: 'all' | 'writes' | 'code_mode'; reason: string; createdBy: { id: string; name: string } | null; createdAt: string }[];
  settings: {
    keys: Record<'openai' | 'anthropic' | 'gemini', { configured: boolean; source: 'env' | 'stored' | null; last4: string | null }>;
    evalModel: string;
    judgeModel: string;
    generatorModel: string;
    effort: 'low' | 'medium' | 'high';
    fallbacks: 'default' | 'off';
    labelInferredTasks: boolean;
    codeModeEnabled: boolean;
    storeOutputs: boolean;
    auditDays: number;
    taskDays: number;
    orgName: string;
  };
  /** 0 in unit tests: simulated delays (compile stages, eval progress, verify) resolve instantly. */
  speed: number;
  nextRunNumber: number;
  seq: number;
  auditCache: { size: number; rows: AuditRow[] } | null;
}

/* ------------------------------------------------------------------ overlay entries */

function initialPublished(serverId: string, tools: ToolSeed[]): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const t of tools) {
    const e: Entry = {};
    if (t.name !== snakeOf(t.orig) && !t.field) e.name = t.name;
    if (t.hidden) e.hidden = true;
    if (t.pinned) e.pinned = true;
    if (Object.keys(e).length) out[keyOf(t)] = e;
  }
  if (serverId === 'srv_acme_orders') {
    out['operationId:customersSearch'] = { response: { include: ['id', 'email', 'name'], redact: ['internal_notes'], maxItems: 50 } };
    out['operationId:postRefund'] = { examples: [{ title: 'Refund €12.99', arguments: { order_id: 'ORD-1', amount_cents: 1299 } }] };
  }
  return out;
}

function mergeEntry(a: Entry | undefined, b: Entry | undefined): Entry {
  const out: Entry = { ...(a ?? {}), ...(b ?? {}) };
  if (a?.response || b?.response) out.response = { ...(a?.response ?? {}), ...(b?.response ?? {}) };
  return out;
}

export function effectiveEntry(s: ServerState, key: string, withDraft: boolean): Entry {
  return withDraft && s.draft[key] ? mergeEntry(s.published[key], s.draft[key]) : (s.published[key] ?? {});
}

export function toolName(s: ServerState, t: ToolSeed, withDraft = false): string {
  return effectiveEntry(s, keyOf(t), withDraft).name ?? t.name;
}

export function toolVisible(s: ServerState, t: ToolSeed, withDraft = false): boolean {
  const e = effectiveEntry(s, keyOf(t), withDraft);
  return e.hidden === undefined ? !t.hidden : !e.hidden;
}

/* ------------------------------------------------------------------ overlay YAML */

function yamlScalar(v: unknown): string {
  if (typeof v === 'string') return /[:#{}[\],&*?|<>=!%@`'"\n]|^\s|\s$/.test(v) || v === '' ? JSON.stringify(v) : v;
  if (Array.isArray(v)) return `[${v.map((x) => yamlScalar(x)).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${yamlScalar(x)}`).join(', ')} }`;
  return String(v);
}

export function entryYaml(key: string, e: Entry): string[] {
  const body: string[] = [];
  if (e.name) body.push(`    name: ${e.name}`);
  if (e.description !== undefined) body.push(`    description: ${yamlScalar(e.description)}`);
  if (e.hidden !== undefined) body.push(`    hidden: ${e.hidden}`);
  if (e.pinned !== undefined) body.push(`    pinned: ${e.pinned}`);
  if (e.response && Object.keys(e.response).length) {
    body.push('    response:');
    if (e.response.include) body.push(`      include: ${yamlScalar(e.response.include)}`);
    if (e.response.redact?.length) body.push(`      redact: ${yamlScalar(e.response.redact)}`);
    if (e.response.maxItems !== undefined) body.push(`      maxItems: ${e.response.maxItems}`);
  }
  if (e.examples?.length) body.push('    examples:', ...e.examples.map((x) => `      - ${x.title ? `title: ${yamlScalar(x.title)}\n        ` : ''}arguments: ${yamlScalar(x.arguments)}`));
  return body.length ? [`  ${JSON.stringify(key)}:`, ...body] : [];
}

export function overlayYaml(s: ServerState, withDraft: boolean): string {
  const lines = ['overlay: 1', `info: { title: ${yamlScalar(s.name)} }`, 'tools:'];
  const keys = [...new Set([...Object.keys(s.published), ...(withDraft ? Object.keys(s.draft) : [])])];
  const order = new Map(s.tools.map((t, i) => [keyOf(t), i]));
  keys.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const k of keys) lines.push(...entryYaml(k, effectiveEntry(s, k, withDraft)));
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ change list (OverlayChange) */

export function draftChanges(s: ServerState): OverlayChange[] {
  const out: OverlayChange[] = [];
  for (const [key, d] of Object.entries(s.draft)) {
    const pub = s.published[key] ?? {};
    for (const field of Object.keys(d) as (keyof Entry)[]) {
      if (field === 'response') {
        const r = d.response ?? {};
        const pr = pub.response ?? {};
        for (const rf of Object.keys(r) as (keyof NonNullable<Entry['response']>)[]) {
          if (JSON.stringify(r[rf]) !== JSON.stringify(pr[rf])) out.push({ kind: 'tool', target: key, field: `response.${rf}`, change: pr[rf] === undefined ? 'added' : 'changed', before: pr[rf], after: r[rf] });
        }
        continue;
      }
      const seed = s.tools.find((t) => keyOf(t) === key);
      const base = pub[field] ?? (field === 'description' ? seed?.description : field === 'name' ? seed?.name : field === 'hidden' ? !!seed?.hidden : field === 'pinned' ? !!seed?.pinned : undefined);
      if (JSON.stringify(d[field]) === JSON.stringify(base)) continue;
      out.push({ kind: 'tool', target: key, field, change: base === undefined ? 'added' : 'changed', before: base, after: d[field] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ builders */

export function visibleCount(s: ServerState, withDraft = false) {
  return s.tools.filter((t) => toolVisible(s, t, withDraft)).length;
}

export function buildRow(s: ServerState, rev = s.versions[0]?.rev ?? 1, envSlugs?: string[]): BuildRow {
  const visible = visibleCount(s);
  return {
    id: `bld_${s.seed.slug}_${rev}`,
    hash: hash(`${s.seed.id}:${rev}`),
    status: 'ok',
    specRev: s.specs[0]?.rev ?? 1,
    overlayRev: rev,
    compilerVersion: '0.1.0',
    toolCount: s.tools.length,
    visibleCount: visible,
    writeCount: s.tools.filter((t) => t.write && toolVisible(s, t)).length,
    hiddenCount: s.tools.length - visible,
    lintScore: s.seed.id === 'srv_bluefin' ? 41 : s.seed.id === 'srv_lumen' ? 66 : 76,
    diagnosticsCount: { error: 0, warning: s.seed.id === 'srv_bluefin' ? 67 : 17, info: 4 },
    environments: envSlugs ?? s.envs.filter((e) => e.build?.overlayRev === rev).map((e) => e.slug),
    createdAt: s.versions.find((v) => v.rev === rev)?.createdAt ?? ago(DAY),
  };
}

function modeScores(matrix: MatrixCell[]): { tool?: number; code?: number } {
  const out: { tool?: number; code?: number } = {};
  for (const m of ['tool', 'code'] as const) {
    const cells = matrix.filter((c) => c.mode === m);
    if (cells.length) out[m] = Math.round((cells.reduce((a, c) => a + c.successRate, 0) / cells.length) * 100);
  }
  return out;
}

export function readinessFor(db: MockDb, serverId: string): ReadinessSummary {
  const latest = db.runs.filter((r) => r.row.server.id === serverId && r.row.status === 'succeeded' && !r.row.temporaryBuild).sort((a, b) => b.number - a.number)[0];
  if (!latest) {
    const lint = serverId === 'srv_bluefin' ? BLUEFIN_LINT : ACME_LINT;
    return {
      score: lint.score, band: readinessBand(lint.score), confidence: 'preliminary', runId: null, measuredAt: null, recommendedMode: null, recommendation: null, modeScores: {},
      breakdown: [{ key: 'quality', label: 'Spec quality', weight: 1, score: lint.score / 100, detail: 'Spec checks only: descriptions, examples and naming', fixCount: 0 }],
    };
  }
  return {
    score: latest.finalScore, band: readinessBand(latest.finalScore), confidence: 'measured', runId: latest.row.id, measuredAt: latest.row.endedAt, recommendedMode: latest.row.recommendedMode,
    recommendation: latest.recommendation, modeScores: modeScores(latest.matrix), breakdown: latest.breakdown,
  };
}

export function serverRow(db: MockDb, s: ServerState): ServerRow {
  return {
    id: s.seed.id,
    slug: s.seed.slug,
    name: s.name,
    kind: s.seed.kind,
    specFormat: s.seed.specFormat,
    status: 'active',
    managedBy: s.seed.id === 'srv_lumen' ? 'file' : 'console',
    toolCount: s.tools.length,
    visibleToolCount: visibleCount(s),
    writeToolCount: s.tools.filter((t) => t.write && toolVisible(s, t)).length,
    environments: s.envs.map((e) => ({ id: e.id, slug: e.slug, kind: e.kind, writesEnabled: e.writes.enabled && e.writes.enabledToolNames.length > 0, isMock: e.isMock, health: e.health.status })),
    readiness: readinessFor(db, s.seed.id),
    lastSpecAt: s.specs[0]?.createdAt ?? null,
    updatedAt: iso(Math.max(s.draftUpdatedAt, Date.parse(s.versions[0]?.createdAt ?? ago(DAY)))),
  };
}

const stripYaml = ({ yaml: _y, ...row }: OverlayRevisionRow & { yaml: string }): OverlayRevisionRow => row;

export function serverDetail(db: MockDb, s: ServerState): ServerDetail {
  const changes = draftChanges(s);
  const pub = s.versions[0] ?? null;
  return {
    ...serverRow(db, s),
    description: s.description,
    exposure: s.exposure,
    opsTools: s.opsTools,
    publicReport: s.publicReport,
    publicReportUrl: s.publicReport ? `https://mcp.acme.test/public/servers/${s.seed.slug}/report` : null,
    specSource: { url: s.specs[0]?.sourceUrl ?? null, path: s.seed.id === 'srv_lumen' ? 'specs/lumen.graphql' : null, upload: s.seed.id === 'srv_bluefin' },
    currentSpec: s.specs[0] ?? null,
    publishedOverlay: pub ? stripYaml(pub) : null,
    draft: changes.length ? { changeCount: changes.length, updatedAt: iso(s.draftUpdatedAt) } : null,
    latestBuild: buildRow(s),
    config: s.seed.id === 'srv_lumen' ? { path: 'neurouter.yaml', line: 42 } : null,
    fileManagedFields: s.seed.id === 'srv_lumen' ? ['name', 'description', 'exposure'] : [],
  };
}

export function toolId(serverId: string, orig: string) {
  return `${serverId}__${orig}`;
}
export function parseToolId(id: string): { serverId: string; orig: string } | null {
  const i = id.indexOf('__');
  return i < 0 ? null : { serverId: id.slice(0, i), orig: id.slice(i + 2) };
}

export function toolRow(s: ServerState, t: ToolSeed, withDraft = false): ToolRow {
  const key = keyOf(t);
  const e = effectiveEntry(s, key, withDraft);
  const name = e.name ?? t.name;
  const description = e.description ?? t.description;
  return {
    id: toolId(s.seed.id, t.orig),
    buildId: `bld_${s.seed.slug}_${s.versions[0]?.rev ?? 1}`,
    name,
    pyName: name,
    title: name.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()),
    summary: description.split(/(?<=\.)\s/)[0] ?? '',
    kind: t.field ? 'graphql' : 'http',
    method: t.method ?? null,
    path: t.path ?? null,
    key,
    write: !!t.write,
    destructive: !!t.destructive,
    hidden: !toolVisible(s, t, withDraft),
    pinned: e.pinned ?? !!t.pinned,
    deprecated: !!t.deprecated,
    overlayModified: !!(s.published[key] && Object.keys(s.published[key]!).length) || !!s.draft[key],
    tags: t.deprecated ? ['deprecated'] : [],
    writeEnabledIn: t.write ? s.envs.filter((env) => env.writes.enabled && env.writes.enabledToolNames.includes(name)).map((env) => env.slug) : s.envs.map((env) => env.slug),
    calls7d: t.calls7d,
    errorRate7d: t.err,
  };
}

function pyType(type: string) {
  return type === 'integer' ? 'int' : type === 'array' ? 'list[Any]' : type === 'object' ? 'dict[str, Any]' : 'str';
}

export function toolDetail(s: ServerState, t: ToolSeed, withDraft = false): ToolDetail {
  const row = toolRow(s, t, withDraft);
  const e = effectiveEntry(s, keyOf(t), withDraft);
  const description = e.description ?? t.description;
  const fields = fieldsFor(t);
  const params: Record<string, { type: string; description?: string; default?: unknown; maximum?: number }> = {};
  if (t.path?.includes('{id}')) params.id = { type: 'string', description: 'Order id, e.g. ORD-55120' };
  if (isList(t)) {
    params.query = { type: 'string', description: 'Free text: email, name or phone' };
    params.limit = { type: 'integer', default: 20, maximum: 100 };
  }
  if (t.name === 'create_refund') {
    params.order_id = { type: 'string' };
    params.amount_cents = { type: 'integer', description: 'Amount in minor units (1299 = €12.99)' };
  }
  const inputSchema = { type: 'object', properties: params, required: Object.keys(params).filter((k) => k !== 'limit' && k !== 'query') };
  const item = { type: 'object', properties: Object.fromEntries(fields.map(([f, type]) => [f, { type }])) };
  const outputSchema = isList(t) ? { type: 'array', items: item } : item;
  const sig = `def ${row.name}(*, ${Object.entries(params).map(([k, v]) => `${k}: ${pyType(v.type)}${k === 'limit' ? ' = 20' : ''}`).join(', ')}) -> ${isList(t) ? 'list[dict[str, Any]]' : 'dict[str, Any]'}:`;
  const ns = s.seed.slug.replaceAll('-', '_');
  const annotations = { title: row.title, readOnlyHint: !t.write, destructiveHint: !!t.destructive, idempotentHint: !t.write, openWorldHint: true };
  const touched = !!(s.published[keyOf(t)] || s.draft[keyOf(t)]);
  return {
    ...row,
    description,
    inputSchema,
    outputSchema,
    annotations,
    risk: { readOnly: !t.write, destructive: !!t.destructive, idempotent: !t.write, openWorld: true, write: !!t.write },
    binding: t.field
      ? { type: 'graphql', operationType: t.field.startsWith('Mutation') ? 'mutation' : 'query', document: `${t.field.startsWith('Mutation') ? 'mutation' : 'query'} { ${t.field.split('.')[1]} { id } }` }
      : { type: 'http', method: t.method ?? 'GET', pathTemplate: t.path ?? '/', params: Object.keys(params).map((k) => ({ arg: k, in: k === 'id' ? 'path' : 'query', name: k, required: k === 'id' })), bodyContentType: t.write ? 'application/json' : null, successStatuses: [200] },
    examples: e.examples ?? [],
    pySignature: sig,
    sourceRef: t.field ? { field: t.field } : { operationId: t.orig, method: t.method, path: t.path },
    overlayApplied: touched ? [keyOf(t)] : [],
    overlayEntry: touched ? e : null,
    agentView: {
      mcp: { name: `${ns}__${row.name}`, description, inputSchema, annotations },
      python: `# ${ns}.pyi (generated)\n${sig}\n    """${description || 'No description.'}${t.write ? '\n\n    WRITE: in dry_run mode returns a planned change instead of calling the API.' : '\n\n    Read-only.'}"""`,
    },
    defHash: hash(`${row.name}:${description}`),
  };
}

/** Before/after of response shaping for the overlay editor (`overlays.preview`). */
export function shapingPreview(t: ToolSeed, e: Entry) {
  const fields = fieldsFor(t);
  const r = e.response ?? {};
  const keep = r.include ?? fields.map(([f]) => f);
  const redact = new Set(r.redact ?? []);
  const items = isList(t) ? 8 : 1;
  const full = Object.fromEntries(fields.map(([f, type]) => [f, sampleValue(f, type)]));
  const shaped = Object.fromEntries(fields.filter(([f]) => keep.includes(f)).map(([f, type]) => [f, redact.has(f) ? { $redacted: 'overlay' } : sampleValue(f, type)]));
  const per = (list: [string, string, number][]) => list.reduce((a, [, , w]) => a + w, 0);
  const before = per(fields) * items;
  const capped = Math.min(items, r.maxItems ?? items);
  const after = per(fields.filter(([f]) => keep.includes(f))) * capped + (isList(t) ? (r.maxItems ? 150 : 20) : 0);
  const afterSample = isList(t) ? { items: [shaped], returned: Math.min(r.maxItems ?? 64, 64), total: 64, ...(r.maxItems ? { next: 'page_9f2c' } : {}) } : shaped;
  return { before: isList(t) ? { items: [full], total: 64 } : full, after: afterSample, tokensBefore: before, tokensAfter: after };
}

/* ------------------------------------------------------------------ environments */

function authOut(e: EnvSeed): EnvironmentDetail['auth'] {
  const secret = { hasSecret: !!e.secretRef?.startsWith('secret:'), secretUpdatedAt: e.secretRef?.startsWith('secret:') ? ago(9 * DAY) : null };
  switch (e.authType) {
    case 'header':
      return { type: 'header', headerName: 'X-Api-Key', secretRef: e.secretRef ?? '', ...secret };
    case 'bearer':
      return { type: 'bearer', secretRef: e.secretRef ?? '', ...secret };
    case 'oauth_client_credentials':
      return { type: 'oauth_client_credentials', tokenUrl: 'https://auth.acme.test/oauth/token', clientId: 'neurouter-qa', clientSecretRef: e.secretRef ?? '', scopes: ['orders:read', 'orders:write'], ...secret };
    case 'oauth_passthrough':
      return { type: 'oauth_passthrough', mode: 'broker', authorizationUrl: 'https://auth.acme.test/authorize', tokenUrl: 'https://auth.acme.test/oauth/token', clientId: 'neurouter-prod', scopes: ['orders:read', 'orders:write'], connected: true, connectUrl: null, ...secret };
    default:
      return { type: 'none', ...secret };
  }
}

export function envDetail(s: ServerSeed, e: EnvSeed, tools: ToolSeed[], build: BuildRow): EnvironmentDetail {
  const writeNames = tools.filter((t) => t.write && !t.hidden).map((t) => t.name);
  const enabledToolNames = e.writesOn === 'all' ? writeNames : e.writesOn;
  return {
    id: `env_${s.slug}_${e.slug}`,
    serverId: s.id,
    slug: e.slug,
    name: e.isMock ? 'Mock' : e.slug.toUpperCase(),
    kind: e.kind,
    baseUrl: e.isMock ? 'mock:' : (e.baseUrl ?? ''),
    isMock: !!e.isMock,
    builtin: !!e.isMock,
    status: 'active',
    buildId: build.id,
    build: { ...build, environments: [e.slug] },
    auth: authOut(e),
    headers: {},
    writes: { enabled: enabledToolNames.length > 0, tools: e.writesOn === 'all' ? null : enabledToolNames, confirm: e.kind === 'prod' ? 'elicit' : 'none', writeToolCount: writeNames.length, enabledToolNames },
    codeMode: true,
    limits: { ...DEFAULT_LIMITS, rateLimit: { perMinute: e.kind === 'prod' ? 60 : 300, burst: 20 } },
    policies: [],
    discovery: null,
    allowedHosts: [],
    allowHttp: false,
    autoPromote: e.kind === 'dev',
    health: { status: e.health, checkedAt: ago(2 * MIN), latencyMs: e.latencyMs || null, error: e.health === 'down' ? 'connect ECONNREFUSED (TLS handshake timed out). Last success 3 h ago.' : null },
    credential: e.authType === 'none' || e.authType === 'oauth_passthrough' ? 'not_required' : 'ok',
    mcpUrl: `https://mcp.acme.test/mcp/${s.slug}/${e.slug}`,
    managedBy: e.managedBy ?? 'console',
    config: e.managedBy === 'file' ? { path: 'neurouter.yaml', line: 58 } : null,
    createdAt: ago(s.importedDaysAgo * DAY + 30 * DAY),
    updatedAt: e.lastCallMin >= 0 ? ago(Math.max(1, e.lastCallMin) * MIN) : ago(DAY),
  };
}

/* ------------------------------------------------------------------ calls, tasks, scripts */

const PRINCIPALS = KEYS.filter((k) => k.expiresDays === null || k.expiresDays > 0);

function trail(env: EnvironmentDetail, auditId: string, opts: { write?: boolean; confirmed?: boolean; dryRun?: boolean; decision?: CallDetail['decision'] }): PolicyStep[] {
  const st = (step: PolicyStep['step'], result: PolicyStep['result'], detail?: string): PolicyStep => (detail ? { step, result, detail } : { step, result });
  const host = env.isMock ? 'mock' : env.baseUrl.replace(/^https?:\/\//, '');
  const steps: PolicyStep[] = [
    st('resolve', 'pass'),
    st('kill_switch', 'pass'),
    st('acl', 'pass', 'Key scope allows this tool'),
    st('read_only', opts.write ? 'pass' : 'skip', opts.write ? `Writes enabled in ${env.slug}` : 'Read tool'),
    st('arguments', 'pass'),
    st('policy', 'pass', opts.write && env.kind === 'prod' ? 'Write allowed in prod, user confirmed' : undefined),
    st('rate_limit', 'pass', '12 / 60 per minute'),
    st('dry_run', opts.dryRun ? 'pass' : 'skip', opts.dryRun ? 'Planned change, not executed' : undefined),
    st('confirm', opts.confirmed ? 'pass' : 'skip', opts.confirmed ? 'Confirmed by the user in the client' : undefined),
    st('routing', opts.dryRun ? 'skip' : 'pass', opts.dryRun ? undefined : `Routed to ${env.slug} · ${host}`),
    st('upstream', opts.dryRun ? 'skip' : 'pass', opts.dryRun ? undefined : '200 OK'),
    st('response', 'pass', 'Shaped by overlay'),
    st('audit', 'pass', `Audited · ${auditId}`),
  ];
  const d = opts.decision;
  if (d && d.startsWith('denied_')) {
    const failAt = d === 'denied_read_only' ? 'read_only' : d === 'denied_rate_limit' ? 'rate_limit' : d === 'denied_acl' ? 'acl' : 'policy';
    let after = false;
    return steps.map((s) => {
      if (s.step === 'audit') return s;
      if (after) return { step: s.step, result: 'skip' as const };
      if (s.step === failAt) {
        after = true;
        return { step: s.step, result: 'fail' as const, detail: d === 'denied_read_only' ? `Writes are off in ${env.slug}` : d === 'denied_rate_limit' ? '61 / 60 per minute' : 'Refused by policy' };
      }
      return s;
    });
  }
  return steps;
}

interface CallInput {
  auditId: string; ts: number; tool: string; env: EnvironmentDetail; server: ServerState; taskId: string | null; scriptRunId?: string | null; principal: { id: string; name: string };
  client: { name: string; version: string }; write?: boolean; dryRun?: boolean; confirmed?: boolean; args: unknown; output: unknown; status?: CallDetail['status']; decision?: CallDetail['decision'];
  latencyMs?: number; error?: CallDetail['error']; via?: CallDetail['via'];
}

export function callDetail(p: CallInput): CallDetail {
  const decision = p.decision ?? (p.dryRun ? 'dry_run' : p.confirmed ? 'confirmed' : 'allowed');
  const blocked = decision.startsWith('denied_');
  const status = p.status ?? (blocked ? 'blocked' : 'ok');
  const seed = p.server.tools.find((x) => toolName(p.server, x) === p.tool);
  return {
    auditId: p.auditId,
    ts: iso(p.ts),
    tool: p.tool,
    toolId: seed ? toolId(p.server.seed.id, seed.orig) : null,
    via: p.via ?? (p.scriptRunId ? 'script' : 'direct'),
    mode: p.scriptRunId ? 'code' : 'tool',
    decision,
    status,
    write: !!p.write,
    dryRun: !!p.dryRun,
    confirm: p.confirmed ? 'elicited' : 'none',
    policyTrail: trail(p.env, p.auditId, { write: p.write, confirmed: p.confirmed, dryRun: p.dryRun, decision }),
    arguments: p.args,
    outputPreview: blocked ? null : (p.output ?? null),
    outputSize: blocked ? null : JSON.stringify(p.output ?? null).length,
    outputHash: blocked ? null : hash(JSON.stringify(p.output ?? null)),
    latencyMs: p.latencyMs ?? 120,
    upstreamLatencyMs: blocked || p.dryRun ? null : Math.max(1, (p.latencyMs ?? 120) - 14),
    upstreamStatus: blocked || p.dryRun ? null : status === 'ok' ? 200 : 500,
    errorId: p.error ? `err_${hash(p.auditId).slice(0, 6)}` : null,
    error: p.error ?? null,
    traceId: (hash(`${p.taskId}:trace`) + hash(`${p.taskId}:t2`) + hash(`${p.taskId}:t3`) + hash(`${p.taskId}:t4`)).slice(0, 32),
    spanId: (hash(p.auditId) + hash(`${p.auditId}:s`)).slice(0, 16),
    taskId: p.taskId,
    scriptRunId: p.scriptRunId ?? null,
    server: { id: p.server.seed.id, slug: p.server.seed.slug, name: p.server.name },
    environment: { id: p.env.id, slug: p.env.slug, name: p.env.name, kind: p.env.kind },
    client: p.client,
    principal: { type: 'api_key', id: p.principal.id, name: p.principal.name },
  };
}

function timelineCall(c: CallDetail, summary: string): TimelineItem {
  const item: TimelineItem = { id: `ti_${c.auditId}`, kind: 'call', ts: c.ts, tool: c.tool, decision: c.decision, status: c.status, write: c.write, dryRun: c.dryRun, via: c.via, summary, auditId: c.auditId };
  if (c.latencyMs !== null) item.durationMs = c.latencyMs;
  if (c.scriptRunId) item.scriptRunId = c.scriptRunId;
  if (c.errorId) item.errorId = c.errorId;
  return item;
}

/** An ops-tool call (begin_task, log_decision, end_task) whose arguments live on the call (calls.get). */
function opsCall(db: MockDb, p: Omit<CallInput, 'output'> & { kind: TimelineItem['kind']; summary: string }): TimelineItem {
  const c = callDetail({ ...p, output: { ok: true }, via: 'direct' });
  db.calls.set(c.auditId, c);
  return { id: `ti_${c.auditId}`, kind: p.kind, ts: c.ts, tool: p.tool, summary: p.summary, auditId: c.auditId, status: 'ok' };
}

function featuredTask(db: MockDb): TaskDetail {
  const s = db.servers[0]!;
  const env = s.envs.find((e) => e.slug === 'prod')!;
  const key = KEYS[0]!;
  const principal = { id: key.id, name: key.name };
  const client = CLIENTS[0]!;
  const t0 = NOW - 3 * HOUR;
  const taskId = 'task_flag_unpaid';
  const orders = ['ORD-55120', 'ORD-55187', 'ORD-55203', 'ORD-55299', 'ORD-55301', 'ORD-55344', 'ORD-55390'];
  const base = { env, server: s, taskId, principal, client };
  const mk = (n: string, tool: string, ts: number, extra: Partial<CallInput>) => {
    const c = callDetail({ auditId: `aud_01JDX8K${n}`, ts, tool, args: {}, output: {}, ...base, ...extra });
    db.calls.set(c.auditId, c);
    return c;
  };
  const listCall = mk('1', 'list_orders', t0 + 9_200, { scriptRunId: 'scr_dry', args: { status: 'unpaid', older_than_days: 30 }, output: { items: '… 43 orders …', returned: 43 }, latencyMs: 410 });
  const planned = orders.map((o, i) => mk(`P${i}`, 'add_order_note', t0 + 9_600 + i * 60, { scriptRunId: 'scr_dry', write: true, dryRun: true, args: { order_id: o, text: `Order ${o} unpaid > 30 days` }, output: null, latencyMs: 2 }));
  const execList = mk('2', 'list_orders', t0 + 100_200, { scriptRunId: 'scr_exec', args: { status: 'unpaid', older_than_days: 30 }, output: { items: '… 43 orders …', returned: 43 }, latencyMs: 380 });
  const exec = orders.map((o, i) => mk(`E${i}`, 'add_order_note', t0 + 100_800 + i * 300, { scriptRunId: 'scr_exec', write: true, confirmed: true, args: { order_id: o, text: `Order ${o} unpaid > 30 days` }, output: { note_id: `N-882${13 + i}`, ok: true }, latencyMs: 290 }));
  const code = `# typed stubs: acme_orders.*, ops.*
late = [o for o in acme_orders.list_orders(status="unpaid", older_than_days=30)
        if o.total_cents > 50_000]
for o in late:
    acme_orders.add_order_note(order_id=o.id, text=f"Order {o.id} unpaid > 30 days")
return {"flagged": len(late), "ids": [o.id for o in late]}`;
  const sref = { id: s.seed.id, slug: s.seed.slug, name: s.name };
  const eref = { id: env.id, slug: env.slug, name: env.name, kind: env.kind };
  const dry: ScriptRunDetail = {
    id: 'scr_dry', taskId, server: sref, environment: eref, mode: 'dry_run', status: 'ok', code, codeHash: hash(code), error: null, resultPreview: { flagged: 7, ids: orders }, resultBytes: 180, resultHandle: null, stdout: null,
    plannedChanges: orders.map((o) => ({ tool: 'add_order_note', method: 'POST', path: `/v2/orders/${o}/notes`, arguments: { order_id: o, text: `Order ${o} unpaid > 30 days` }, wouldConfirm: true })),
    stats: { wallMs: 1200, cpuMs: 400, toolCalls: 8, blockedCalls: 0, peakMemoryBytes: 9_400_000, suspensions: 8 },
    phases: [{ name: 'validate', status: 'ok', durationMs: 3 }, { name: 'type_check', status: 'ok', durationMs: 11 }, { name: 'execute', status: 'ok', durationMs: 1180 }],
    calls: [timelineCall(listCall, '43 orders'), ...planned.map((c) => timelineCall(c, 'planned, not executed'))], auditId: 'aud_scr_dry', traceId: listCall.traceId, startedAt: iso(t0 + 9_000), endedAt: iso(t0 + 10_200), recipeCount: 3,
  };
  const execRun: ScriptRunDetail = {
    ...dry, id: 'scr_exec', mode: 'execute', plannedChanges: [],
    stats: { wallMs: 2900, cpuMs: 520, toolCalls: 8, blockedCalls: 0, peakMemoryBytes: 9_800_000, suspensions: 8 },
    phases: [{ name: 'validate', status: 'ok', durationMs: 3 }, { name: 'type_check', status: 'ok', durationMs: 10 }, { name: 'execute', status: 'ok', durationMs: 2880 }],
    calls: [timelineCall(execList, '43 orders'), ...exec.map((c) => timelineCall(c, 'note added'))], auditId: 'aud_scr_exec', startedAt: iso(t0 + 100_000), endedAt: iso(t0 + 102_900),
  };
  db.scripts.set(dry.id, dry);
  db.scripts.set(execRun.id, execRun);
  const ops = (n: string, tool: string, ts: number, kind: TimelineItem['kind'], summary: string, args: unknown) => opsCall(db, { auditId: `aud_01JDX8O${n}`, ts, tool, kind, summary, args, ...base });
  const timeline: TimelineItem[] = [
    ops('B', 'neurouter_begin_task', t0 + 2_000, 'task_begin', 'Flag unpaid orders older than 30 days over €500 with a note', { goal: 'Flag unpaid orders older than 30 days over €500 with a note' }),
    ops('D1', 'neurouter_log_decision', t0 + 5_000, 'decision', 'Use a script: 40+ orders to check', { choice: 'Use a script: 40+ orders to check', reason: 'One script run instead of about 45 direct calls.', alternatives: ['list_orders in a loop (≈45 calls)'] }),
    { id: 'ti_scr1', kind: 'script', ts: iso(t0 + 9_000), durationMs: 1200, tool: 'run_script', dryRun: true, status: 'ok', summary: 'dry_run · 8 calls · 7 planned writes', scriptRunId: 'scr_dry', auditId: 'aud_scr_dry', children: dry.calls },
    ops('D2', 'neurouter_log_decision', t0 + 60_000, 'decision', 'Skip disputed orders', { choice: 'Skip disputed orders', reason: '2 orders already have an open dispute.', alternatives: ['flag all 9'] }),
    { id: 'ti_scr2', kind: 'script', ts: iso(t0 + 100_000), durationMs: 2900, tool: 'run_script', dryRun: false, write: true, decision: 'confirmed', status: 'ok', summary: 'execute · 8 calls · 7 writes', scriptRunId: 'scr_exec', auditId: 'aud_scr_exec', children: execRun.calls },
    ops('E', 'neurouter_end_task', t0 + 252_000, 'task_end', 'success', { outcome: 'success', notes: 'Flagged 7 orders; 2 were already disputed and skipped.' }),
  ];
  return {
    id: taskId, goal: 'Flag unpaid orders older than 30 days', outcome: 'success', framing: 'explicit', inferredLabel: null, status: 'closed', origin: 'agent',
    server: sref, environment: eref, principal: { type: 'api_key', ...principal }, client,
    startedAt: iso(t0), endedAt: iso(t0 + 252_000), durationMs: 252_000, callCount: 9, errorCount: 0, writeCount: 7, blockedCount: 0, scriptCount: 2, decisionCount: 2, opsCount: 4,
    notes: 'Flagged 7 orders; 2 were already disputed and skipped.', traceId: listCall.traceId, timeline, truncated: false, unmetNeeds: [], issues: [], evalRunId: null,
  };
}

const READ_TOOLS: Record<string, string[]> = {
  srv_acme_orders: ['search_orders', 'get_order', 'list_orders', 'search_customers', 'get_customer', 'track_shipment', 'list_refunds', 'get_invoice'],
  srv_lumen: ['stock_level', 'warehouses', 'purchase_orders', 'sku', 'search_skus'],
};
const WRITE_TOOLS: Record<string, string[]> = { srv_acme_orders: ['add_order_note', 'create_refund', 'update_order_address'], srv_lumen: ['adjust_stock', 'create_purchase_order'] };

/** One generated task row. `seed` decides outcome, framing, calls. */
export function generateTask(db: MockDb, idx: number, startedMs: number, opts: { open?: boolean; serverId?: string; seed?: number } = {}): TaskRow {
  const r = rng(opts.seed ?? idx * 7919 + 17);
  const s = opts.serverId ? db.servers.find((x) => x.seed.id === opts.serverId)! : r() < 0.78 ? db.servers[0]! : db.servers[1]!;
  const realEnvs = s.envs.filter((e) => !e.isMock);
  const env = r() < 0.6 ? (realEnvs.find((e) => e.kind === 'prod') ?? realEnvs[0]!) : realEnvs[Math.floor(r() * realEnvs.length)]!;
  const keyPool = PRINCIPALS.filter((k) => k.server === s.seed.id);
  const key = keyPool[Math.floor(r() * keyPool.length)] ?? PRINCIPALS[0]!;
  const client = CLIENTS[Math.floor(r() * CLIENTS.length)]!;
  const roll = r();
  const inferred = roll > 0.91;
  const outcome: TaskRow['outcome'] = opts.open ? null : inferred ? null : roll < 0.68 ? 'success' : roll < 0.82 ? 'partial' : 'failure';
  const hasScript = r() < 0.25;
  const calls = 2 + Math.floor(r() * 5);
  const errors = outcome === 'failure' ? 1 + Math.floor(r() * 2) : r() < 0.1 ? 1 : 0;
  const writes = r() < 0.3 ? 1 : 0;
  const dur = 20_000 + Math.floor(r() * 280_000);
  const goal = TASK_GOALS[Math.floor(r() * TASK_GOALS.length)]!;
  return {
    id: `task_${String(idx).padStart(4, '0')}`,
    goal: inferred ? null : goal,
    outcome,
    framing: inferred ? 'inferred' : hasScript && r() < 0.3 ? 'script' : 'explicit',
    inferredLabel: inferred ? { goal, outcome: 'unknown', confidence: 0.62, model: 'gemini-3.5-flash-lite' } : null,
    status: opts.open ? 'open' : 'closed',
    origin: 'agent',
    server: { id: s.seed.id, slug: s.seed.slug, name: s.name },
    environment: { id: env.id, slug: env.slug, name: env.name, kind: env.kind },
    principal: { type: 'api_key', id: key.id, name: key.name },
    client,
    startedAt: iso(startedMs),
    endedAt: opts.open ? null : iso(startedMs + dur),
    durationMs: opts.open ? null : dur,
    callCount: calls + (hasScript ? 1 : 0),
    errorCount: errors,
    writeCount: writes,
    blockedCount: errors && r() < 0.3 ? 1 : 0,
    scriptCount: hasScript ? 1 : 0,
    decisionCount: r() < 0.5 ? 1 : 0,
    opsCount: inferred ? 0 : 2,
  };
}

/** Builds (and caches) the timeline, calls and script of a generated task. */
export function taskDetail(db: MockDb, id: string): TaskDetail | null {
  const cached = db.taskDetails.get(id);
  if (cached) return cached;
  const row = db.tasks.find((t) => t.id === id);
  if (!row) return null;
  const s = db.servers.find((x) => x.seed.id === row.server.id)!;
  const env = s.envs.find((e) => e.id === row.environment.id) ?? s.envs[0]!;
  const r = rng(Number(id.replace(/\D/g, '') || 1) * 13 + 7);
  const start = Date.parse(row.startedAt);
  const reads = READ_TOOLS[s.seed.id] ?? ['get_order'];
  const writesPool = WRITE_TOOLS[s.seed.id] ?? [];
  const base = { env, server: s, taskId: id, principal: { id: row.principal.id, name: row.principal.name }, client: { name: row.client.name ?? 'client', version: row.client.version ?? '' } };
  const items: TimelineItem[] = [];
  let ts = start + 1500;
  if (row.framing !== 'inferred') items.push(opsCall(db, { ...base, auditId: `aud_${id}_b`, ts: start + 500, tool: 'neurouter_begin_task', kind: 'task_begin', summary: row.goal ?? '', args: { goal: row.goal } }));
  const n = row.callCount - row.scriptCount;
  let errorsLeft = row.errorCount;
  let writesLeft = row.writeCount;
  for (let i = 0; i < n; i++) {
    const write = writesLeft > 0 && i === n - 1 && writesPool.length > 0;
    const tool = write ? writesPool[Math.floor(r() * writesPool.length)]! : reads[Math.floor(r() * reads.length)]!;
    const err = errorsLeft > 0 && i === Math.floor(n / 2);
    const blocked = err && row.blockedCount > 0;
    if (err) errorsLeft--;
    if (write) writesLeft--;
    const c = callDetail({
      ...base, auditId: `aud_${id}_${i}`, ts, tool, write, confirmed: write && env.kind === 'prod',
      decision: blocked ? (write ? 'denied_read_only' : 'denied_rate_limit') : undefined,
      status: err && !blocked ? 'upstream_error' : undefined,
      error: err && !blocked ? { code: 'upstream_500', title: 'Upstream error', explanation: 'The API returned 500. Retry once; if it fails again, call neurouter_report_issue.' } : null,
      args: tool.includes('order') ? { order_id: `ORD-5${5000 + Math.floor(r() * 400)}` } : { query: 'C-1042' }, output: err ? null : { ok: true, id: `R-${Math.floor(r() * 9000)}` }, latencyMs: 60 + Math.floor(r() * 600),
    });
    db.calls.set(c.auditId, c);
    items.push(timelineCall(c, err ? (blocked ? (c.policyTrail.find((p) => p.result === 'fail')?.detail ?? 'blocked') : 'upstream error 500') : 'ok'));
    ts += 3000 + Math.floor(r() * 20_000);
    if (i === 0 && row.decisionCount) items.push(opsCall(db, { ...base, auditId: `aud_${id}_d`, ts: ts - 1500, tool: 'neurouter_log_decision', kind: 'decision', summary: 'Check the order before refunding', args: { choice: 'Check the order before refunding', reason: 'The customer asked about two orders; confirm which one first.', alternatives: ['refund directly'] } }));
  }
  if (row.scriptCount) {
    const sid = `scr_${id}`;
    const code = `orders = ${s.seed.slug.replaceAll('-', '_')}.${reads[0]}(limit=50)\nreturn {"count": len(orders)}`;
    const inner = [0, 1].map((k) => {
      const c = callDetail({ ...base, auditId: `aud_${id}_s${k}`, ts: ts + 200 + k * 100, tool: reads[k % reads.length]!, scriptRunId: sid, args: { limit: 50 }, output: { returned: 50 } });
      db.calls.set(c.auditId, c);
      return timelineCall(c, 'ok');
    });
    db.scripts.set(sid, {
      id: sid, taskId: id, server: row.server, environment: row.environment, mode: 'execute', status: 'ok', code, codeHash: hash(code), error: null, resultPreview: { count: 50 }, resultBytes: 14, resultHandle: null, stdout: null, plannedChanges: [],
      stats: { wallMs: 640, cpuMs: 90, toolCalls: 2, blockedCalls: 0, suspensions: 2 },
      phases: [{ name: 'validate', status: 'ok', durationMs: 2 }, { name: 'type_check', status: 'ok', durationMs: 8 }, { name: 'execute', status: 'ok', durationMs: 630 }],
      calls: inner, auditId: `aud_scr_${id}`, traceId: null, startedAt: iso(ts), endedAt: iso(ts + 640), recipeCount: 1,
    });
    items.push({ id: `${id}_s`, kind: 'script', ts: iso(ts), durationMs: 640, tool: 'run_script', dryRun: false, status: 'ok', summary: 'execute · 2 calls', scriptRunId: sid, auditId: `aud_scr_${id}`, children: inner });
    ts += 2000;
  }
  if (row.status === 'closed' && row.framing !== 'inferred') {
    const note = row.outcome === 'success' ? 'Done.' : row.outcome === 'partial' ? 'Answered part of the question; one order could not be found.' : 'Could not complete: the API returned errors.';
    items.push(opsCall(db, { ...base, auditId: `aud_${id}_e`, ts: Date.parse(row.endedAt!), tool: 'neurouter_end_task', kind: 'task_end', summary: row.outcome ?? 'unknown', args: { outcome: row.outcome, notes: note } }));
  }
  const detail: TaskDetail = { ...row, notes: row.outcome === 'partial' ? 'Answered part of the question; one order could not be found.' : null, traceId: hash(id) + hash(`${id}x`) + hash(`${id}y`) + hash(`${id}z`), timeline: items, truncated: false, unmetNeeds: [], issues: [], evalRunId: null };
  db.taskDetails.set(id, detail);
  return detail;
}

/* ------------------------------------------------------------------ evals */

export function matrixFrom(seed: Pick<(typeof RUNS)[number], 'matrix'>): MatrixCell[] {
  const out: MatrixCell[] = [];
  for (const model of Object.keys(seed.matrix)) {
    const m = seed.matrix[model];
    if (!m) continue;
    const cells = (['tool', 'code'] as Mode[]).map((mode) => [mode, m[mode]] as const).filter(([, v]) => v);
    const best = Math.max(...cells.map(([, v]) => v![0]));
    for (const [mode, v] of cells) out.push({ model, mode, successRate: v![0], score: Math.round(v![0] * 100), avgTokens: v![2], avgCalls: v![1], avgLatencyMs: Math.round(v![1] * 900), flakyTasks: Math.round((1 - v![0]) * 6), excludedAttempts: 0, best: v![0] === best });
  }
  return out;
}

export function taskResults(run: RunState): TaskResultRow[] {
  const r = rng(run.number * 101);
  const prompts = run.row.models.length === 1 && run.row.repeats === 1 ? EVAL_TASK_PROMPTS.slice(0, 12) : EVAL_TASK_PROMPTS;
  return prompts.map((t, i) => ({
    taskId: `etask_${t.key}`,
    key: t.key,
    category: t.category,
    prompt: t.prompt,
    cells: run.matrix.map((c) => {
      const p = c.successRate + (t.category === 'single' ? 0.15 : t.category === 'impossible' ? -0.25 : 0) + (r() - 0.5) * 0.3;
      const attempts = run.row.repeats;
      const passes = Math.max(0, Math.min(attempts, Math.round(p * attempts)));
      return {
        model: c.model, mode: c.mode, passes, attempts, flaky: passes > 0 && passes < attempts,
        failureCause: passes === attempts ? null : t.category === 'impossible' ? ('missing_capability' as const) : i % 3 === 0 ? ('wrong_tool' as const) : ('bad_arguments' as const),
        avgTokens: Math.round(c.avgTokens * (0.7 + r() * 0.6)), avgCalls: Math.round(c.avgCalls * (0.6 + r() * 0.8) * 10) / 10, taskRunIds: [`trun.${run.row.id}.${t.key}.${c.model}.${c.mode}`],
      };
    }),
  }));
}

/** Advances a simulated running eval from wall-clock time. */
export function tickRun(db: MockDb, run: RunState): void {
  if (run.row.status !== 'running') return;
  const elapsed = db.speed === 0 ? Infinity : (Date.now() - run.startedMs) / db.speed;
  const frac = Math.min(1, elapsed / run.durationMs);
  run.row.progress = { done: Math.round(frac * run.row.progress.total), total: run.row.progress.total };
  if (frac >= 1) {
    run.row.status = 'succeeded';
    run.row.endedAt = iso(Date.now());
    run.row.headline = run.finalScore;
    run.row.confidence = 'measured';
    run.row.recommendedMode = 'code';
  }
}

const SUGGESTIONS: Omit<SuggestionState, 'runId' | 'serverId' | 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'sug_rename_list_orders', title: 'Rename getOrdersV2 → list_orders', cause: 'wrong_tool', kind: 'rename', tools: ['list_orders'], affectedTaskKeys: ['t08', 't10', 't12', 't11', 't09', 't07'],
    overlayPatch: 'tools:\n  "operationId:getOrdersV2":\n    name: list_orders', ops: [{ selector: 'operationId:getOrdersV2', field: 'name', value: 'list_orders' }],
    specPatch: '[{"op":"replace","path":"/paths/~1v2~1orders/get/operationId","value":"listOrders"}]', rationale: 'Agents searched for “list orders” and skipped the tool in 6 tasks.', predictedDelta: 3, status: 'verified', verifyRunId: 'run_15', verifiedDelta: 4,
  },
  {
    id: 'sug_search_customers_desc', title: 'Rewrite search_customers description', cause: 'wrong_tool', kind: 'describe', tools: ['search_customers'], affectedTaskKeys: ['t02', 't13', 't07', 't10', 't14', 't15', 't08', 't09', 't12'],
    overlayPatch: 'tools:\n  "operationId:customersSearch":\n    description: Search customers by email, name or phone. Use list_customers to page through all customers.',
    ops: [{ selector: 'operationId:customersSearch', field: 'description', value: 'Search customers by email, name or phone. Use list_customers to page through all customers.' }],
    specPatch: '[{"op":"replace","path":"/paths/~1customers~1search/get/description","value":"Search customers by email, name or phone."}]', rationale: 'Confused with list_customers in 9 tasks.', predictedDelta: 5, status: 'verified', verifyRunId: 'run_16', verifiedDelta: 6,
  },
  {
    id: 'sug_hide_legacy_export', title: 'Hide legacyExportOrders', cause: 'wrong_tool', kind: 'hide', tools: ['legacy_export_orders'], affectedTaskKeys: ['t12', 't16', 't08', 't11', 't09', 't07', 't10'],
    overlayPatch: 'tools:\n  "operationId:legacyExportOrders":\n    hidden: true', ops: [{ selector: 'operationId:legacyExportOrders', field: 'hidden', value: true }], specPatch: null,
    rationale: 'Picked by mistake 7 times; it returns a deprecated CSV format.', predictedDelta: 4, status: 'proposed', verifyRunId: null, verifiedDelta: null,
  },
  {
    id: 'sug_refund_example', title: 'Add an example to create_refund', cause: 'bad_arguments', kind: 'example', tools: ['create_refund'], affectedTaskKeys: ['t07', 't15', 't17'],
    overlayPatch: 'tools:\n  "operationId:postRefund":\n    examples:\n      - arguments: { order_id: ORD-1, amount_cents: 1299 }', ops: [{ selector: 'operationId:postRefund', field: 'examples', value: [{ arguments: { order_id: 'ORD-1', amount_cents: 1299 } }] }],
    specPatch: null, rationale: 'Amount passed in euros instead of cents in 11 failures.', predictedDelta: 5, status: 'proposed', verifyRunId: null, verifiedDelta: null,
  },
  {
    id: 'sug_bulk_refund', title: 'Missing capability: bulk refund', cause: 'missing_capability', kind: 'composite', tools: ['create_refund'], affectedTaskKeys: ['t17', 't07', 't16', 't18', 't15'],
    overlayPatch: '', ops: [], specPatch: null, rationale: '5 tasks need it; no overlay can fix this. Agents also report it in the inbox (23 reports).', predictedDelta: 0, status: 'proposed', verifyRunId: null, verifiedDelta: null,
  },
];

/* ================================================================== create */

function newServerState(seed: ServerSeed, tools: ToolSeed[]): ServerState {
  const s: ServerState = {
    seed, name: seed.name, description: seed.description, published: initialPublished(seed.id, tools), draft: {}, draftUpdatedAt: NOW - 3 * HOUR, draftRev: 1, versions: [], specs: [], envs: [],
    exposure: { mode: seed.id === 'srv_acme_orders' ? 'both' : seed.id === 'srv_lumen' ? 'auto' : 'tools', discovery: 'auto', pinned: tools.filter((t) => t.pinned).map((t) => t.name) },
    opsTools: { begin_task: true, end_task: true, log_decision: true, report_unmet_need: true, report_issue: true, explain_error: true, get_examples: true, whoami: true },
    publicReport: seed.id === 'srv_acme_orders', tools,
  };
  const notes = ['Initial import', 'Rename getOrdersV2, hide v1 endpoints', 'Response shaping for search_customers', 'Apply 4 verified fixes from run #14'];
  const authors = [PEOPLE.maya, PEOPLE.jon, PEOPLE.maya, PEOPLE.maya];
  for (let rev = seed.overlayRev; rev >= 1; rev--) {
    s.versions.push({
      id: `ovl_${seed.slug}_${rev}`, rev, hash: hash(`${seed.id}:ov:${rev}`), message: seed.id === 'srv_acme_orders' ? notes[rev - 1]! : rev === 1 ? 'Initial import' : 'Curate tool names',
      source: rev === 4 ? 'suggestion' : 'console', basedOnRev: rev > 1 ? rev - 1 : null, createdBy: ref(authors[rev - 1]!), createdAt: ago((seed.overlayRev - rev) * 0.5 * DAY + 4 * HOUR),
      toolChanges: rev === 1 ? tools.filter((t) => t.hidden).length : 4, yaml: '',
    });
  }
  for (let rev = seed.specRev; rev >= 1; rev--) {
    s.specs.push({
      id: `spec_${seed.slug}_${rev}`, rev, format: seed.specFormat, title: seed.specTitle, apiVersion: `2.${rev}.0`, operationCount: seed.operations - (seed.specRev - rev) * 2, contentHash: hash(`${seed.id}:spec:${rev}`),
      contentBytes: 180_000 + rev * 4_000, sourceUrl: seed.kind === 'openapi' && seed.id !== 'srv_bluefin' ? `https://${seed.slug.split('-')[0]}.example.test/openapi.yaml` : null,
      createdAt: ago((seed.importedDaysAgo + (seed.specRev - rev) * 6) * DAY), createdBy: ref(PEOPLE.maya),
    });
  }
  const build = buildRow(s, seed.overlayRev, []);
  s.envs = (ENVS[seed.id] ?? []).map((e) => envDetail(seed, e, tools, build));
  for (const v of s.versions) v.yaml = overlayYaml(s, false).replace('overlay: 1', `overlay: 1\n# revision ${v.rev}`);
  return s;
}

export function createDb(opts: { speed?: number } = {}): MockDb {
  const servers = SERVERS.map((seed) => newServerState(seed, TOOLS_BY_SERVER[seed.id] ?? []));
  const acme = servers[0]!;
  // the prototype's draft: 3 unpublished changes on search_customers
  acme.draft = { 'operationId:customersSearch': { response: { maxItems: 20 }, examples: [{ arguments: { query: 'maya@acme.test' } }, { arguments: { query: '+358 40 123 4567', limit: 5 } }], pinned: true } };
  const db: MockDb = {
    servers, tasks: [], taskDetails: new Map(), calls: new Map(), scripts: new Map(), needGroups: [], issues: [], keys: [], runs: [], suggestions: [], adminAudit: [], previews: new Map(),
    users: Object.values(PEOPLE).map((p, i) => ({ id: p.id, email: p.email, name: p.name, role: p.role, roleSource: i === 0 ? 'bootstrap' : 'oidc', status: 'active', lastLoginAt: ago((i + 1) * 2 * HOUR), createdAt: ago((60 - i * 10) * DAY) })),
    killSwitches: [{ scope: 'tool', target: 'acme-orders/prod/cancel_order', kind: 'writes', reason: 'Investigating double cancellations (INC-2231)', createdBy: ref(PEOPLE.jon), createdAt: ago(26 * HOUR) }],
    settings: { keys: { openai: { configured: true, source: 'env', last4: 'Lu6a' }, anthropic: { configured: true, source: 'stored', last4: '9fQa' }, gemini: { configured: false, source: null, last4: null } }, evalModel: 'gpt-6-luna', judgeModel: 'gpt-6-luna', generatorModel: 'gpt-6-luna', effort: 'medium', fallbacks: 'default', labelInferredTasks: true, codeModeEnabled: true, storeOutputs: false, auditDays: 90, taskDays: 30, orgName: INSTANCE.name },
    speed: opts.speed ?? 1, nextRunNumber: 19, seq: 0, auditCache: null,
  };

  // tasks: ~600 over 14 days, newest first; the featured task sits 3 h ago
  const r = rng(42);
  const rows: TaskRow[] = [];
  let t = NOW - 6 * MIN;
  for (let i = 0; i < 600; i++) {
    rows.push(generateTask(db, 600 - i, t));
    t -= (14 * DAY) / 600 + (r() - 0.5) * 20 * MIN;
  }
  const featured = featuredTask(db);
  const { notes: _n, traceId: _t, timeline: _tl, truncated: _tr, unmetNeeds: _u, issues: _i, evalRunId: _e, ...featuredRow } = featured;
  rows.splice(Math.max(0, rows.findIndex((x) => Date.parse(x.startedAt) < Date.parse(featured.startedAt))), 0, featuredRow);
  db.taskDetails.set(featured.id, featured);
  db.tasks = rows;

  const envRef = (s: ServerState, slug: string) => {
    const e = s.envs.find((x) => x.slug === slug) ?? s.envs[0]!;
    return { id: e.id, slug: e.slug, name: e.name, kind: e.kind };
  };
  db.needGroups = NEED_GROUPS.map((g) => ({
    id: g.id, label: g.label, server: { id: acme.seed.id, slug: acme.seed.slug, name: acme.name }, count: g.count, distinctPrincipals: g.keys, firstSeenAt: ago(g.firstDays * DAY), lastSeenAt: ago(g.lastMin * MIN),
    status: g.status, note: g.status === 'planned' ? 'Bulk refund endpoint is on the Q1 roadmap (ORD-812).' : null, sampleIntents: g.reports.slice(0, 3).map((x) => x.intent), daily14: [...g.daily],
    reports: g.reports.map((x, i) => {
      const key = KEYS.find((k) => k.name === x.key)!;
      return { id: `${g.id}_r${i}`, groupId: g.id, intent: x.intent, attempted: [x.attempted], taskId: rows[(i + 3) * 7]?.id ?? null, environment: envRef(acme, key.env), principal: { type: 'api_key', id: key.id, name: key.name }, client: CLIENTS[i % 2]!, createdAt: ago(x.days * DAY + i * HOUR) };
    }),
    attemptedTools: g.tried,
  }));
  db.issues = ISSUES.map((x, i) => ({
    id: x.id, tool: x.tool, problem: x.problem, server: { id: acme.seed.id, slug: acme.seed.slug, name: acme.name }, environment: envRef(acme, x.env), taskId: rows[11 + i * 5]?.id ?? null, status: x.status,
    createdAt: ago((3 + i * 2) * DAY), updatedAt: ago(x.lastMin * MIN), hasFailingCall: true, evidence: x.evidence, note: i === 1 ? 'Reproduced in qa; fix ships with API 2.4.' : null,
  }));

  db.keys = KEYS.map((k) => {
    const s = servers.find((x) => x.seed.id === k.server)!;
    return {
      id: k.id, name: k.name, displayPrefix: `${k.prefix}…`, server: { id: s.seed.id, slug: s.seed.slug, name: s.name }, environment: envRef(s, k.env), scopes: [...k.scopes], profile: null, rateLimit: null,
      owner: ref(PEOPLE[k.owner as keyof typeof PEOPLE]), expiresAt: k.expiresDays === null ? null : iso(NOW + k.expiresDays * DAY), revokedAt: null, lastUsedAt: ago(k.lastMin * MIN),
      status: k.expiresDays !== null && k.expiresDays < 0 ? 'expired' : 'active', createdAt: ago(k.createdDays * DAY),
    };
  });

  for (const seed of RUNS) {
    const s = servers.find((x) => x.seed.id === seed.serverId)!;
    const mock = s.envs.find((e) => e.isMock)!;
    const prev = RUNS.filter((x) => x.serverId === seed.serverId && x.number < seed.number).sort((a, b) => b.number - a.number)[0];
    const src = seed.serverId === 'srv_lumen' ? LUMEN_BREAKDOWN : seed.number === 14 ? ACME_BASELINE_BREAKDOWN : ACME_BREAKDOWN;
    const exact = seed.number === 18 || seed.number === 14 || seed.serverId === 'srv_lumen';
    const breakdown: ReadinessComponent[] = src.map((b) => ({ ...b, detail: b.detail || '', score: exact ? b.score : Math.max(0, Math.min(1, b.score * (seed.score / 87))) }));
    const ended = NOW - seed.daysAgo * DAY;
    const total = (s.seed.id === 'srv_lumen' ? 30 : 40) * seed.modes.length * MODELS.length * 3;
    db.runs.push({
      number: seed.number,
      row: {
        id: seed.id, server: { id: s.seed.id, slug: s.seed.slug, name: s.name }, suite: { id: `suite_${s.seed.slug}_2`, version: 2 }, environment: { id: mock.id, slug: mock.slug, name: mock.name },
        build: { id: `bld_${s.seed.slug}_${seed.overlayRev}`, hash: hash(`${s.seed.id}:${seed.overlayRev}`) }, overlayRev: seed.overlayRev, temporaryBuild: false, models: [...MODELS], modes: seed.modes, repeats: 3,
        status: 'succeeded', progress: { done: total, total }, headline: seed.score, recommendedMode: seed.modes.includes('code') ? 'code' : 'tool', confidence: 'measured', trigger: seed.trigger, baseRunId: prev?.id ?? null, error: null,
        createdAt: iso(ended - 14 * MIN), startedAt: iso(ended - 13 * MIN), endedAt: iso(ended),
        usage: Object.fromEntries(MODELS.map((m, i) => [m, { inputTokens: 620_000 - i * 40_000, outputTokens: 71_000 - i * 5_000 }])),
      },
      matrix: matrixFrom(seed), breakdown, startedMs: 0, durationMs: 0, finalScore: seed.score,
      recommendation: seed.modes.length === 2 ? 'Use both modes: code mode is +18 pts and −62% tokens on multi-step tasks; tool mode is better for single lookups.' : 'Only tool mode was measured. Run code mode too to compare.',
    });
  }
  db.suggestions = SUGGESTIONS.map((x) => ({ ...x, runId: 'run_14', serverId: acme.seed.id, createdAt: ago(2 * DAY), updatedAt: ago(DAY) }));

  const adminRows: [number, keyof typeof PEOPLE, string, string][] = [
    [4 * HOUR, 'maya', 'overlays.publish', 'Published overlay v4 (4 tool changes)'],
    [5 * HOUR, 'maya', 'suggestions.apply', 'Applied fix: Rewrite search_customers description'],
    [26 * HOUR, 'jon', 'killSwitches.set', 'Kill switch set: writes off for cancel_order in prod'],
    [30 * HOUR, 'maya', 'environments.setToolWrite', 'Write switch: add_order_note enabled in prod (typed confirm)'],
    [2 * DAY, 'maya', 'evals.createRun', 'Eval run #14 started (suite v2, 3 models)'],
    [3 * DAY, 'jon', 'keys.create', 'API key created: ops-nightly (prod)'],
    [9 * DAY, 'maya', 'servers.create', 'Server imported: Lumen Inventory'],
  ];
  db.adminAudit = adminRows.map(([a, who, action, summary], i) => {
    const p = PEOPLE[who];
    return {
      id: `aud_admin_${i}`, seq: 17_900 + i, ts: ago(a), kind: action === 'evals.createRun' ? 'eval_run' : 'admin_action', principal: { type: 'user', id: p.id, name: p.name }, client: { name: 'Console', version: INSTANCE.version },
      server: { id: acme.seed.id, slug: acme.seed.slug, name: acme.name }, environment: null, tool: null, via: 'console', mode: null, decision: 'allowed', decisionReason: summary, status: 'ok', write: true, dryRun: false,
      confirm: 'none', latencyMs: null, errorId: null, errorMessage: null, taskId: null, scriptRunId: null, traceId: null, action,
    };
  });
  return db;
}

/* ================================================================== audit rows from calls */

export function auditRows(db: MockDb): AuditRow[] {
  for (const t of db.tasks.slice(0, 150)) taskDetail(db, t.id);
  const size = db.calls.size + db.adminAudit.length + db.scripts.size;
  if (db.auditCache && db.auditCache.size === size) return db.auditCache.rows;
  const rows: AuditRow[] = [...db.adminAudit];
  let seq = 18_000;
  for (const c of db.calls.values()) {
    rows.push({
      id: c.auditId, seq: seq++, ts: c.ts, kind: c.tool.startsWith('neurouter_') ? 'ops_call' : 'tool_call', principal: c.principal, client: c.client, server: c.server, environment: c.environment, tool: c.tool, via: c.via, mode: c.mode,
      decision: c.decision, decisionReason: c.policyTrail.find((p) => p.result === 'fail')?.detail ?? null, status: c.status, write: c.write, dryRun: c.dryRun, confirm: c.confirm, latencyMs: c.latencyMs,
      errorId: c.errorId, errorMessage: c.error?.title ?? null, taskId: c.taskId, scriptRunId: c.scriptRunId, traceId: c.traceId, action: null,
    });
  }
  for (const sr of db.scripts.values()) {
    const task = db.taskDetails.get(sr.taskId ?? '');
    if (!task) continue;
    const confirmed = sr.calls.some((c) => c.decision === 'confirmed');
    rows.push({
      id: sr.auditId ?? `aud_${sr.id}`, seq: seq++, ts: sr.startedAt, kind: 'script_run', principal: task.principal, client: task.client, server: task.server, environment: task.environment, tool: 'run_script', via: 'direct', mode: 'code',
      decision: sr.mode === 'dry_run' ? 'dry_run' : confirmed ? 'confirmed' : 'allowed', decisionReason: null, status: 'ok', write: sr.calls.some((c) => c.write && !c.dryRun), dryRun: sr.mode === 'dry_run',
      confirm: confirmed ? 'elicited' : 'none', latencyMs: sr.stats?.wallMs ?? null, errorId: null, errorMessage: null, taskId: sr.taskId, scriptRunId: sr.id, traceId: sr.traceId, action: null,
    });
  }
  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  db.auditCache = { size, rows };
  return rows;
}

export { DAY, HOUR, MIN, NOW, iso, ago };
