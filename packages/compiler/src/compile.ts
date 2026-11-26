/**
 * `compile()`: spec bytes (+ overlay YAML) → tool model, diagnostics, stubs, mock model, lint and
 * build hash (backend spec §8). Never throws for spec problems.
 */
import { upgrade, validate } from '@scalar/openapi-parser';
import { parse as parseYaml } from 'yaml';
import type { GraphQLSchema } from 'graphql';
import type { CompileInput, Diagnostic, LintReport, SpecFormat, ToolDef } from '@neurouter/shared';
import { compileGraphql, loadGraphqlSchema } from './graphql/compile-graphql.js';
import { checkExamples } from './describe.js';
import { lint } from './lint.js';
import { buildMockModel, type MockModel } from './mock/model.js';
import { pyIdent } from './naming.js';
import { compileOpenApi } from './openapi/compile-openapi.js';
import { applyOverlay } from './overlay/apply.js';
import { parseOverlay, selectorLine } from './overlay/parse.js';
import { shapeOutputSchema } from './shape.js';
import { generateStubs, pySignatureFor } from './stubs.js';
import { isObj, jcsHash, sha256Hex, type Obj } from './util.js';
import { COMPILER_VERSION } from './version.js';

export interface CompileResult {
  format: SpecFormat | null;
  title: string;
  apiVersion: string | null;
  /** `servers[0].url` of an OpenAPI spec (informational) */
  serverUrl: string | null;
  operationCount: number;
  /** all tools after the overlay, hidden ones included (`hidden: true`) */
  tools: ToolDef[];
  /** tools before the overlay (for spec diffs and the mock) */
  baseTools: ToolDef[];
  diagnostics: Diagnostic[];
  orphanedOverlayKeys: string[];
  profiles: Record<string, string[]>;
  /** namespace → .pyi source, from visible tools */
  pythonStubs: Record<string, string>;
  mockModel: MockModel | null;
  lint: LintReport;
  /** sha256 hex of the raw spec bytes */
  specHash: string;
  /** sha256 hex of the overlay text ('' when none) */
  overlayHash: string;
  /** build hash = sha256(specHash + overlayHash + COMPILER_VERSION) */
  hash: string;
  /** true when no error diagnostics */
  ok: boolean;
}

export function buildHash(specHash: string, overlayHash: string): string {
  return sha256Hex(`${specHash}\n${overlayHash}\n${COMPILER_VERSION}`);
}

export interface DetectedSpec {
  format: SpecFormat | 'swagger-2.0' | null;
  doc?: Obj;
  text: string;
  error?: string;
}

/** Detects the spec format from raw bytes (JSON/YAML OpenAPI, Swagger, GraphQL SDL or introspection). */
export function detectSpec(bytes: Uint8Array, hint?: CompileInput['spec']['format']): DetectedSpec {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  if (hint === 'graphql-sdl') return { format: 'graphql-sdl', text };
  let doc: unknown;
  const trimmed = text.trimStart();
  try {
    doc = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(text) : undefined;
  } catch {
    doc = undefined;
  }
  if (isObj(doc) && (isObj(doc.__schema) || (isObj(doc.data) && isObj(doc.data.__schema)))) return { format: 'graphql-introspection', text };
  if (hint === 'graphql-introspection') return { format: null, text, error: 'not a GraphQL introspection result (no __schema)' };
  if (doc === undefined && !/^\s*(openapi|swagger)\s*:/m.test(text) && /\b(type\s+\w+|schema)\s*(@\w+[^{]*)?\{/.test(text)) {
    return { format: 'graphql-sdl', text };
  }
  if (doc === undefined) {
    try {
      doc = parseYaml(text, { maxAliasCount: 1000, uniqueKeys: false });
    } catch (e) {
      if (/\btype\s+\w+\s*\{/.test(text)) return { format: 'graphql-sdl', text };
      return { format: null, text, error: `not valid JSON or YAML: ${(e as Error).message.split('\n')[0]}` };
    }
  }
  if (!isObj(doc)) {
    if (/\btype\s+\w+\s*\{/.test(text)) return { format: 'graphql-sdl', text };
    return { format: null, text, error: 'the document is not an object' };
  }
  if (typeof doc.swagger === 'string' || typeof doc.swagger === 'number') return { format: 'swagger-2.0', text, doc };
  if (typeof doc.openapi === 'string') {
    const v = doc.openapi;
    if (v.startsWith('3.0')) return { format: 'openapi-3.0', text, doc };
    if (v.startsWith('3.')) return { format: 'openapi-3.1', text, doc };
    return { format: null, text, doc, error: `unsupported OpenAPI version ${v}` };
  }
  return { format: null, text, doc, error: 'no "openapi" or "swagger" field, and not GraphQL' };
}

const emptyLint: LintReport = { score: 0, rules: [], findings: [] };

export async function compile(input: CompileInput): Promise<CompileResult> {
  const specHash = sha256Hex(input.spec.bytes);
  const overlayText = input.overlay ?? '';
  const overlayHash = overlayText ? sha256Hex(overlayText) : '';
  const hash = buildHash(specHash, overlayHash);
  const maxTools = input.options?.maxTools ?? 2000;
  const namespace = input.namespace;
  const diagnostics: Diagnostic[] = [];
  const fail = (format: SpecFormat | null, d: Diagnostic): CompileResult => ({
    format,
    title: '',
    apiVersion: null,
    serverUrl: null,
    operationCount: 0,
    tools: [],
    baseTools: [],
    diagnostics: [...diagnostics, d],
    orphanedOverlayKeys: [],
    profiles: {},
    pythonStubs: {},
    mockModel: null,
    lint: emptyLint,
    specHash,
    overlayHash,
    hash,
    ok: false,
  });

  const det = detectSpec(input.spec.bytes, input.spec.format);
  if (det.format === 'swagger-2.0') return fail(null, { severity: 'error', code: 'spec_unsupported', message: 'Swagger 2.0 is not supported; convert it to OpenAPI 3.x', pointer: '/swagger' });
  if (!det.format) return fail(null, { severity: 'error', code: 'spec_invalid', message: det.error ?? 'unrecognised spec format' });
  const format = det.format;

  let base: { tools: ToolDef[]; operationCount: number; title: string; apiVersion: string | null; serverUrl: string | null };
  let gqlSchema: GraphQLSchema | null = null;
  let mockModel: MockModel | null;
  if (format === 'graphql-sdl' || format === 'graphql-introspection') {
    try {
      gqlSchema = loadGraphqlSchema(det.text, format);
    } catch (e) {
      return fail(format, { severity: 'error', code: 'spec_invalid', message: `GraphQL schema error: ${(e as Error).message.split('\n')[0]}` });
    }
    const endpointPath = input.spec.graphql?.endpointPath ?? '/graphql';
    const out = compileGraphql(gqlSchema, { selectionDepth: input.spec.graphql?.selectionDepth ?? 2, endpointPath, maxTools });
    diagnostics.push(...out.diagnostics);
    base = { tools: out.tools, operationCount: out.operationCount, title: out.title, apiVersion: null, serverUrl: null };
    mockModel = { kind: 'graphql', schemaText: det.text, format, endpointPath };
  } else {
    const doc = det.doc!;
    try {
      const v = await validate(structuredClone(doc));
      if (!v.valid) {
        for (const e of (v.errors ?? []).slice(0, 50)) {
          const pointer = Array.isArray(e.path) ? `/${e.path.join('/')}` : typeof e.path === 'string' ? e.path : undefined;
          diagnostics.push({ severity: 'warning', code: 'spec_invalid', message: e.message, ...(pointer ? { pointer } : {}) });
        }
      }
    } catch (e) {
      diagnostics.push({ severity: 'warning', code: 'spec_invalid', message: `validation failed: ${(e as Error).message}` });
    }
    let upgraded: Obj | null;
    try {
      upgraded = format === 'openapi-3.0' ? ((upgrade(structuredClone(doc)).specification as Obj | null) ?? null) : doc;
    } catch (e) {
      return fail(format, { severity: 'error', code: 'spec_invalid', message: `cannot upgrade the spec to OpenAPI 3.1: ${(e as Error).message}` });
    }
    if (!upgraded || !isObj(upgraded.paths)) return fail(format, { severity: 'error', code: 'spec_invalid', message: 'the spec has no paths' });
    const out = compileOpenApi(upgraded, { maxTools });
    diagnostics.push(...out.diagnostics);
    base = out;
    mockModel = buildMockModel(out.tools);
  }

  // overlay
  let overlayResult = { tools: base.tools.map((t) => structuredClone(t)), orphanedOverlayKeys: [] as string[], profiles: {} as Record<string, string[]> };
  if (overlayText.trim()) {
    const parsed = parseOverlay(overlayText);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.overlay) {
      const applied = applyOverlay(base.tools, parsed.overlay, { namespace, graphqlSchema: gqlSchema, lineOf: (s) => selectorLine(overlayText, s) });
      diagnostics.push(...applied.diagnostics);
      overlayResult = applied;
    }
  }

  const tools = overlayResult.tools.map((t) => finalize(t, namespace));
  const baseTools = base.tools.map((t) => finalize(structuredClone(t), namespace));
  const visible = tools.filter((t) => !t.hidden);
  const pythonStubs = { [namespace]: generateStubs(visible, namespace, { buildHash: hash }) };
  // one checked example per visible tool (contract-2 descriptions, docstrings; lint example_runs)
  const examples = await checkExamples(tools, mockModel);
  for (const t of tools) {
    const ex = examples.get(t.name);
    if (ex) t.checkedExample = { arguments: ex.arguments, source: ex.source, runs: ex.runs, conforms: ex.conforms, ...(ex.problem ? { problem: ex.problem } : {}), ...(ex.curatedProblem ? { curatedProblem: ex.curatedProblem } : {}) };
  }
  const report = lint(tools, { ...(input.options?.discovery ? { discovery: input.options.discovery } : {}), ...(input.options?.pinned ? { pinned: input.options.pinned } : {}), examples });
  return {
    format,
    title: base.title,
    apiVersion: base.apiVersion,
    serverUrl: base.serverUrl,
    operationCount: base.operationCount,
    tools,
    baseTools,
    diagnostics,
    orphanedOverlayKeys: overlayResult.orphanedOverlayKeys,
    profiles: overlayResult.profiles,
    pythonStubs,
    mockModel,
    lint: report,
    specHash,
    overlayHash,
    hash,
    ok: !diagnostics.some((d) => d.severity === 'error'),
  };
}

/** The agent-visible definition hashed into `defHash`. */
export function agentDefinition(t: ToolDef): Record<string, unknown> {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema ?? null, risk: t.risk, pySignature: t.pySignature };
}

/** Fills pyName, shaped outputSchema, pySignature and defHash. */
export function finalize(t: ToolDef, namespace: string): ToolDef {
  t.pyName = `${namespace}.${pyIdent(t.name)}`;
  if (t.shaping) {
    const shaped = shapeOutputSchema(t.outputSchema, t.shaping);
    if (shaped) t.outputSchema = shaped;
  }
  t.pySignature = pySignatureFor(t);
  t.defHash = jcsHash(agentDefinition(t));
  return t;
}
