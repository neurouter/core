import * as z from 'zod';
import { DiagnosticSeverity } from './enums.js';
import type { SpecFormat, ToolKind } from './enums.js';

/**
 * The tool model (backend spec §8.1): the compiler's output and the data plane's input. Plain
 * interfaces for the model itself (it is produced and consumed in-process); zod schemas for the
 * parts that cross the REST API (diagnostics, lint).
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolRisk {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  write: boolean;
}

export interface HttpParam {
  arg: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  name: string;
  style?: string;
  explode?: boolean;
  required: boolean;
}

export interface HttpBinding {
  type: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  pathTemplate: string;
  params: HttpParam[];
  /** `arg` = the single `body` property when not spread; `spread` = body properties are top-level args. */
  body?: { arg: string | null; contentType: 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data'; spread: boolean; properties?: string[] };
  successStatuses: number[];
  responseContentType: string | null;
  pagination?: { style: 'link' | 'cursor' | 'offset' | 'page'; param?: string; nextPath?: string };
  idempotencyHeader?: string;
  security: Array<Record<string, string[]>>;
}

export interface GraphqlBinding {
  type: 'graphql';
  operationType: 'query' | 'mutation';
  document: string;
  variables: Array<{ arg: string; name: string }>;
  resultPath: string[];
  endpointPath?: string;
}

export interface CompositeBinding {
  type: 'composite';
  script: string;
  namespace: string;
}

export type ToolBinding = HttpBinding | GraphqlBinding | CompositeBinding;

/** Response shaping from the overlay (§8.4 `response`). Paths use the JSONPath subset (`a.b`, `a[]`, `[].x`). */
export interface ResponseShaping {
  include?: string[];
  exclude?: string[];
  flatten?: Record<string, string>;
  maxItems?: number;
  maxBytes?: number;
  redact?: string[];
}

export interface ToolExample {
  title?: string;
  arguments: Record<string, unknown>;
  /** where the example came from (optional; added by the compiler) */
  source?: 'spec' | 'overlay';
}

export type ToolSourceRef = { operationId?: string; method?: string; path?: string; pointer: string } | { rootType: 'Query' | 'Mutation'; field: string };

/** Argument transforms the request builder applies (overlay `args`). Keys are agent-visible names. */
export interface ArgTransforms {
  /** agent-visible name → original arg name (overlay `args.rename`). */
  renamed?: Record<string, string>;
  /** hidden args (removed from the schema) with their defaults, by original arg name. */
  hidden?: Record<string, unknown>;
  /** defaults applied when the agent omits the arg (agent-visible names). */
  defaults?: Record<string, unknown>;
}

export interface ToolDef {
  /** Exposed MCP name: ^[a-z][a-z0-9_]{0,63}$ */
  name: string;
  /** "<namespace>.<fn>" e.g. "github.issues_create" */
  pyName: string;
  title: string;
  description: string;
  kind: ToolKind;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  binding: ToolBinding;
  risk: ToolRisk;
  tags: string[];
  hidden: boolean;
  pinned: boolean;
  deprecated: boolean;
  examples: ToolExample[];
  pySignature: string;
  sourceRef: ToolSourceRef;
  shaping?: ResponseShaping;
  args?: ArgTransforms;
  /** Overlay selector keys that touched this tool. */
  overlayApplied: string[];
  /** Stable selector key of the source operation: `operationId:<id>`, `"<METHOD> <path>"`, `graphql:<Root>.<field>` or `composite:<name>`. */
  key: string;
  /** sha256(JCS of the agent-visible definition). */
  defHash: string;
  /**
   * The copy-ready example agents see (contract 2), checked by the compiler: validated against the input schema and
   * run against a throwaway mock (lint `example_runs`). Absent in builds compiled before 0.3.
   */
  checkedExample?: { arguments: Record<string, unknown>; source: 'overlay' | 'spec' | 'synthesized'; runs: boolean | null; conforms: boolean | null; problem?: string; curatedProblem?: string };
  /** Overlay `readBack` (contract 2): the read that labels the write's target and shows before/after values. */
  readBack?: { tool: string; label?: string[] };
}

export const Diagnostic = z.object({
  severity: DiagnosticSeverity,
  code: z.string(),
  message: z.string(),
  /** JSON pointer into the spec (e.g. `/paths/~1pets/get`). */
  pointer: z.string().optional(),
  /** Overlay selector path (e.g. `tools["operationId:listPets"].args.hide`). */
  overlayPath: z.string().optional(),
  line: z.number().int().optional(),
  col: z.number().int().optional(),
  excerpt: z.string().optional(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;

export const LintRule = z.enum([
  'description_present',
  'description_actionable',
  'params_described',
  'params_typed',
  'names_clear',
  'toolset_size',
  'output_shaped',
  'examples_present',
  'writes_marked',
  'schema_depth',
  // contract 2 description standard (P5)
  'example_runs',
  'destructive_marked',
  'has_more_without_cursor',
  'envelope_conformance',
  'first_sentence',
  'description_length',
  'enum_in_schema',
]);
export type LintRule = z.infer<typeof LintRule>;

export const LintFinding = z.object({
  rule: LintRule,
  severity: DiagnosticSeverity,
  tool: z.string().optional(),
  message: z.string(),
  /** Suggested overlay patch operations (OverlayPatchOp[]), when the fix is mechanical. */
  fix: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type LintFinding = z.infer<typeof LintFinding>;

export const LintRuleResult = z.object({ rule: LintRule, weight: z.number(), score: z.number().min(0).max(1), passed: z.boolean(), detail: z.string() });
export type LintRuleResult = z.infer<typeof LintRuleResult>;

export const LintReport = z.object({ score: z.number().int().min(0).max(100), rules: z.array(LintRuleResult), findings: z.array(LintFinding) });
export type LintReport = z.infer<typeof LintReport>;

export interface CompileInput {
  spec: { bytes: Uint8Array; format?: SpecFormat | 'openapi' | 'graphql-sdl' | 'graphql-introspection'; baseUrlHint?: string; graphql?: { selectionDepth?: number; endpointPath?: string } };
  overlay?: string;
  /** Python namespace (the server slug with `-` → `_`). */
  namespace: string;
  options?: { maxTools?: number; discovery?: 'auto' | 'full' | 'search'; pinned?: string[] };
}
