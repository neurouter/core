/**
 * GraphQL (SDL or introspection JSON) → tool model (backend spec §8.3). One tool per field of the
 * root Query (read) and Mutation (write) types; subscriptions are skipped.
 */
import {
  buildClientSchema,
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  valueFromASTUntyped,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLSchema,
} from 'graphql';
import type { Diagnostic, GraphqlBinding, JsonSchema, ToolDef } from '@neurouter/shared';
import { toToolName, uniquify } from '../naming.js';
import { isObj } from '../util.js';

export interface GraphqlCompileOutput {
  tools: ToolDef[];
  diagnostics: Diagnostic[];
  operationCount: number;
  title: string;
  schema: GraphQLSchema | null;
}

export function loadGraphqlSchema(text: string, format: 'graphql-sdl' | 'graphql-introspection'): GraphQLSchema {
  if (format === 'graphql-sdl') return buildSchema(text, { assumeValidSDL: false });
  const json = JSON.parse(text) as Record<string, unknown>;
  const data = (isObj(json.data) ? json.data : json) as unknown as Parameters<typeof buildClientSchema>[0];
  return buildClientSchema(data);
}

/** graphql 17 keeps argument defaults as `default: { value } | { literal }` (`defaultValue` in 16). */
export function argDefault(a: { defaultValue?: unknown; default?: { value?: unknown; literal?: unknown } }): unknown {
  if (a.defaultValue !== undefined) return a.defaultValue;
  const d = a.default;
  if (!d) return undefined;
  if (d.value !== undefined) return d.value;
  if (d.literal) {
    try {
      return valueFromASTUntyped(d.literal as Parameters<typeof valueFromASTUntyped>[0]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function scalarSchema(name: string): JsonSchema {
  switch (name) {
    case 'String':
    case 'ID':
      return { type: 'string' };
    case 'Int':
      return { type: 'integer' };
    case 'Float':
      return { type: 'number' };
    case 'Boolean':
      return { type: 'boolean' };
    default:
      return { type: 'string', 'x-graphql-scalar': name };
  }
}

function inputTypeSchema(t: GraphQLInputType, depth = 0): JsonSchema {
  if (isNonNullType(t)) return inputTypeSchema(t.ofType, depth);
  if (isListType(t)) return { type: 'array', items: inputTypeSchema(t.ofType as GraphQLInputType, depth) };
  if (isEnumType(t)) return { type: 'string', enum: t.getValues().map((v) => v.name), ...(t.description ? { description: t.description } : {}) };
  if (isScalarType(t)) return scalarSchema(t.name);
  if (isInputObjectType(t)) {
    if (depth > 6) return { type: 'object' };
    const props: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const f of Object.values(t.getFields())) {
      props[f.name] = { ...inputTypeSchema(f.type, depth + 1), ...(f.description ? { description: f.description } : {}) };
      if (isNonNullType(f.type) && argDefault(f as never) === undefined) required.push(f.name);
    }
    return { type: 'object', title: t.name, properties: props, ...(required.length ? { required } : {}), additionalProperties: false };
  }
  return {};
}

function gqlTypeString(t: GraphQLInputType): string {
  if (isNonNullType(t)) return `${gqlTypeString(t.ofType)}!`;
  if (isListType(t)) return `[${gqlTypeString(t.ofType as GraphQLInputType)}]`;
  return (t as GraphQLNamedType).name;
}

function isConnection(t: GraphQLNamedType): boolean {
  if (!isObjectType(t)) return false;
  const f = t.getFields();
  if (!f.edges || !f.pageInfo) return false;
  const edge = getNamedType(f.edges.type);
  return isObjectType(edge) && !!edge.getFields().node;
}

interface Selected {
  text: string;
  schema: JsonSchema;
}

/** Generates a selection set to `depth` levels (scalars + enums; objects recurse; connections detected). */
export function selectionFor(type: GraphQLOutputType, depth: number, indent = '  '): Selected {
  const inner = isNonNullType(type) ? type.ofType : type;
  if (isListType(inner)) {
    const s = selectionFor(inner.ofType as GraphQLOutputType, depth, indent);
    return { text: s.text, schema: { type: 'array', items: s.schema } };
  }
  const named = inner as GraphQLNamedType;
  if (isLeafType(named)) {
    const schema = isEnumType(named) ? { type: 'string', enum: named.getValues().map((v) => v.name) } : scalarSchema(named.name);
    return { text: '', schema };
  }
  if (isUnionType(named)) return { text: `{\n${indent}  __typename\n${indent}}`, schema: { type: 'object', properties: { __typename: { type: 'string' } } } };
  if (!(isObjectType(named) || isInterfaceType(named))) return { text: '{ __typename }', schema: { type: 'object' } };
  const fields = named.getFields();
  const lines: string[] = [];
  const props: Record<string, JsonSchema> = {};
  const connection = isConnection(named);
  for (const f of Object.values(fields)) {
    if (f.args.some((a) => isNonNullType(a.type))) continue;
    const fNamed = getNamedType(f.type);
    if (isLeafType(fNamed)) {
      lines.push(`${indent}  ${f.name}`);
      props[f.name] = selectionFor(f.type, 0).schema;
      continue;
    }
    const childDepth = connection && (f.name === 'edges' || f.name === 'pageInfo') ? depth : depth - 1;
    if (childDepth <= 0 && !(connection && f.name === 'pageInfo')) continue;
    if (connection && f.name === 'pageInfo') {
      const pi = fNamed as GraphQLNamedType;
      const piFields = isObjectType(pi) ? pi.getFields() : {};
      const pick = ['hasNextPage', 'endCursor'].filter((n) => n in piFields);
      if (pick.length) {
        lines.push(`${indent}  pageInfo { ${pick.join(' ')} }`);
        props.pageInfo = { type: 'object', properties: Object.fromEntries(pick.map((n) => [n, n === 'hasNextPage' ? { type: 'boolean' } : { type: 'string' }])) };
      }
      continue;
    }
    const sub = selectionFor(f.type, connection && f.name === 'edges' ? Math.max(depth, 2) : childDepth, `${indent}  `);
    if (!sub.text) continue;
    lines.push(`${indent}  ${f.name} ${sub.text}`);
    props[f.name] = sub.schema;
  }
  if (lines.length === 0) {
    lines.push(`${indent}  __typename`);
    props.__typename = { type: 'string' };
  }
  return { text: `{\n${lines.join('\n')}\n${indent}}`, schema: { type: 'object', ...(named.name ? { 'x-schema-name': named.name } : {}), properties: props } };
}

export function buildDocument(opType: 'query' | 'mutation', opName: string, field: GraphQLField<unknown, unknown>, selection: string): string {
  const vars = field.args.map((a) => `$${a.name}: ${gqlTypeString(a.type)}`);
  const callArgs = field.args.map((a) => `${a.name}: $${a.name}`);
  const sel = selection ? ` ${selection.trim()}` : '';
  return `${opType} ${opName}${vars.length ? `(${vars.join(', ')})` : ''} {\n  ${field.name}${callArgs.length ? `(${callArgs.join(', ')})` : ''}${sel}\n}`;
}

export function compileGraphql(schema: GraphQLSchema, opts: { selectionDepth: number; endpointPath: string; maxTools: number }): GraphqlCompileOutput {
  const diagnostics: Diagnostic[] = [];
  const drafts: Array<Omit<ToolDef, 'name' | 'pySignature' | 'defHash'> & { baseName: string; field: GraphQLField<unknown, unknown> }> = [];
  let operationCount = 0;
  const sub = schema.getSubscriptionType();
  if (sub) diagnostics.push({ severity: 'info', code: 'subscriptions_skipped', message: `Subscription fields (${Object.keys(sub.getFields()).length}) are not exposed as tools` });
  for (const [rootType, root] of [
    ['Query', schema.getQueryType()],
    ['Mutation', schema.getMutationType()],
  ] as const) {
    if (!root) continue;
    for (const field of Object.values(root.getFields())) {
      operationCount++;
      const opType = rootType === 'Query' ? 'query' : 'mutation';
      const baseName = toToolName(field.name);
      const props: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const a of field.args) {
        const dv = argDefault(a as never);
        props[a.name] = { ...inputTypeSchema(a.type), ...(a.description ? { description: a.description } : {}), ...(dv !== undefined && dv !== null && !(typeof dv === 'object' && Object.keys(dv).length === 0) ? { default: dv } : {}) };
        if (isNonNullType(a.type) && dv === undefined) required.push(a.name);
      }
      const sel = selectionFor(field.type, opts.selectionDepth);
      const outSchema: JsonSchema = sel.schema.type === 'array' ? { type: 'object', properties: { items: sel.schema }, 'x-neurouter-wrapped': 'items' } : sel.schema.type === 'object' ? sel.schema : { type: 'object', properties: { data: sel.schema }, 'x-neurouter-wrapped': 'data' };
      const binding: GraphqlBinding = {
        type: 'graphql',
        operationType: opType,
        document: buildDocument(opType, baseName, field, sel.text),
        variables: field.args.map((a) => ({ arg: a.name, name: a.name })),
        resultPath: [field.name],
        endpointPath: opts.endpointPath,
      };
      const write = opType === 'mutation';
      const desc = field.description?.trim() || `${rootType}.${field.name}`;
      if (!field.description) diagnostics.push({ severity: 'warning', code: 'description_missing', message: `${rootType}.${field.name} has no description` });
      const words = baseName.split('_').join(' ');
      drafts.push({
        baseName,
        field,
        pyName: '',
        title: words.charAt(0).toUpperCase() + words.slice(1),
        description: desc.length > 1024 ? `${desc.slice(0, 1023)}…` : desc,
        kind: 'graphql',
        inputSchema: { type: 'object', properties: props, ...(required.length ? { required } : {}), additionalProperties: false },
        outputSchema: outSchema,
        binding,
        risk: { readOnly: !write, destructive: write && /^(delete|remove|destroy)/i.test(field.name), idempotent: !write, openWorld: true, write },
        tags: [],
        hidden: false,
        pinned: false,
        deprecated: field.deprecationReason != null,
        examples: [],
        sourceRef: { rootType, field: field.name },
        overlayApplied: [],
        key: `graphql:${rootType}.${field.name}`,
      });
    }
  }
  if (drafts.length > opts.maxTools) {
    diagnostics.push({ severity: 'error', code: 'too_many_tools', message: `The schema has ${drafts.length} root fields; the limit is ${opts.maxTools}.` });
    drafts.length = opts.maxTools;
  }
  const { names, collided } = uniquify(drafts.map((d) => d.baseName));
  for (const i of collided) diagnostics.push({ severity: 'warning', code: 'name_collision', message: `Tool name "${drafts[i]!.baseName}" is used more than once; renamed to "${names[i]}"` });
  const tools = drafts.map(({ baseName: _b, field, ...d }, i) => {
    const name = names[i]!;
    if (name !== _b) (d.binding as GraphqlBinding).document = buildDocument((d.binding as GraphqlBinding).operationType, name, field, selectionFor(field.type, opts.selectionDepth).text);
    return { ...d, name, pySignature: '', defHash: '' };
  });
  return { tools, diagnostics, operationCount, title: schema.description ?? 'GraphQL API', schema };
}

/** Rebuilds a tool's document with an overlay-provided selection set (`graphql.selection`). */
export function documentWithSelection(schema: GraphQLSchema, binding: GraphqlBinding, opName: string, selection: string): string | null {
  const root = binding.operationType === 'query' ? schema.getQueryType() : schema.getMutationType();
  const field = root?.getFields()[binding.resultPath[0] ?? ''];
  if (!field) return null;
  const sel = selection.trim().startsWith('{') ? selection.trim() : `{ ${selection.trim()} }`;
  return buildDocument(binding.operationType, opName, field, sel);
}
