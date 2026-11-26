/**
 * OpenAPI 3.x → tool model (backend spec §8.2). Input: an OAS 3.1 document (already upgraded).
 */
import type { Diagnostic, HttpBinding, HttpParam, JsonSchema, ToolDef, ToolExample } from '@neurouter/shared';
import { nameFromMethodPath, snakeCase, toToolName, uniquify } from '../naming.js';
import { escapePointer, isObj, type Obj } from '../util.js';
import { SchemaResolver } from './schema.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'] as const;
const SKIPPED = ['options', 'trace'];
const MAX_DESC = 1024;
const MAX_SPREAD = 20;

export interface OpenApiCompileOutput {
  tools: ToolDef[];
  diagnostics: Diagnostic[];
  operationCount: number;
  title: string;
  apiVersion: string | null;
  serverUrl: string | null;
}

export function cleanDescription(summary: unknown, description: unknown, fallback: string): { text: string; fromSpec: boolean } {
  const parts = [summary, description].filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  if (parts.length === 2 && parts[1]!.startsWith(parts[0]!)) parts.shift();
  let text = parts.join('\n\n');
  if (!text) return { text: fallback, fromSpec: false };
  text = text
    .replace(/<\/?(?:p|br|div|span|code|pre|b|i|em|strong|a|ul|ol|li|h\d|table|tr|td|th|details|summary)(?:\s[^>]*)?\/?>/gi, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > MAX_DESC) text = `${text.slice(0, MAX_DESC - 1)}…`;
  return { text, fromSpec: true };
}

function firstSentence(text: string): string {
  const line = text.split('\n')[0] ?? text;
  const m = /^(.{1,200}?[.!?])(\s|$)/.exec(line);
  return (m ? m[1]! : line.slice(0, 120)).trim();
}

function titleFrom(summary: unknown, name: string): string {
  if (typeof summary === 'string' && summary.trim()) return firstSentence(summary.trim()).replace(/\.$/, '');
  const words = name.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function pickMedia(content: unknown, prefer: string[]): { type: string; media: Obj } | null {
  if (!isObj(content)) return null;
  for (const p of prefer) {
    for (const [type, media] of Object.entries(content)) {
      const base = type.split(';')[0]!.trim().toLowerCase();
      if ((p === '+json' ? base.endsWith('+json') : base === p) && isObj(media)) return { type: base, media };
    }
  }
  return null;
}

/** Spec authors sometimes mark auth headers as parameters; those are the gateway's job (§8.2.5). */
function authParamNames(doc: Obj): { header: Set<string>; query: Set<string>; cookie: Set<string> } {
  const out = { header: new Set(['authorization', 'cookie', 'proxy-authorization']), query: new Set<string>(), cookie: new Set<string>() };
  const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : {};
  for (const s of Object.values(schemes)) {
    if (isObj(s) && s.type === 'apiKey' && typeof s.name === 'string') {
      const where = s.in === 'query' ? out.query : s.in === 'cookie' ? out.cookie : out.header;
      where.add(s.name.toLowerCase());
    }
  }
  return out;
}

function exampleOf(p: Obj, schema: Obj): unknown {
  if (p.example !== undefined) return p.example;
  if (isObj(p.examples)) {
    const first = Object.values(p.examples)[0];
    if (isObj(first) && first.value !== undefined) return first.value;
  }
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  return undefined;
}

function detectPagination(paramNames: string[], responses: Obj, resolver: SchemaResolver): HttpBinding['pagination'] | undefined {
  for (const r of Object.values(responses)) {
    const res = resolver.deref<Obj>(r);
    if (isObj(res) && isObj(res.headers) && Object.keys(res.headers).some((h) => h.toLowerCase() === 'link')) return { style: 'link' };
  }
  const lower = paramNames.map((n) => n.toLowerCase());
  const cursor = lower.find((n) => ['cursor', 'page_token', 'pagetoken', 'after', 'next_token'].includes(n));
  if (cursor) return { style: 'cursor', param: cursor };
  if (lower.includes('page') && (lower.includes('per_page') || lower.includes('page_size') || lower.includes('pagesize'))) return { style: 'page', param: 'page' };
  if (lower.includes('offset') && lower.includes('limit')) return { style: 'offset', param: 'offset' };
  return undefined;
}

export function compileOpenApi(doc: Obj, opts: { maxTools: number }): OpenApiCompileOutput {
  const resolver = new SchemaResolver(doc);
  const diagnostics: Diagnostic[] = [];
  const info = isObj(doc.info) ? doc.info : {};
  const title = typeof info.title === 'string' ? info.title : 'API';
  const apiVersion = typeof info.version === 'string' ? info.version : null;
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const serverUrl = isObj(servers[0]) && typeof servers[0].url === 'string' ? servers[0].url : null;
  const auth = authParamNames(doc);
  const globalSecurity = Array.isArray(doc.security) ? (doc.security as Array<Record<string, string[]>>) : [];

  const drafts: Array<Omit<ToolDef, 'name' | 'pySignature' | 'defHash'> & { baseName: string }> = [];
  let operationCount = 0;
  const paths = isObj(doc.paths) ? doc.paths : {};

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolver.deref<Obj>(rawItem);
    if (!isObj(item)) continue;
    for (const m of SKIPPED) if (isObj(item[m])) diagnostics.push({ severity: 'info', code: 'method_skipped', message: `${m.toUpperCase()} ${path} is not exposed as a tool`, pointer: `/paths/${escapePointer(path)}/${m}` });
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      operationCount++;
      const pointer = `/paths/${escapePointer(path)}/${method}`;
      const METHOD = method.toUpperCase() as HttpBinding['method'];
      const operationId = typeof op.operationId === 'string' && op.operationId.trim() ? op.operationId.trim() : undefined;
      const baseName = operationId ? toToolName(operationId) : nameFromMethodPath(method, path);

      // ---- parameters (path-level merged with op-level; op-level wins by name+in)
      const merged = new Map<string, Obj>();
      for (const src of [item.parameters, op.parameters]) {
        if (!Array.isArray(src)) continue;
        for (const raw of src) {
          const p = resolver.deref<Obj>(raw);
          if (!isObj(p) || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
          merged.set(`${p.in}:${p.name}`, p);
        }
      }
      const params: HttpParam[] = [];
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const exampleArgs: Record<string, unknown> = {};
      const rootDefs: Obj = {};
      let missingExample = false;
      const plist = [...merged.values()].filter((p) => {
        const where = p.in as 'path' | 'query' | 'header' | 'cookie';
        const lname = (p.name as string).toLowerCase();
        if ((where === 'header' && auth.header.has(lname)) || (where === 'query' && auth.query.has(lname)) || (where === 'cookie' && auth.cookie.has(lname))) {
          diagnostics.push({ severity: 'info', code: 'auth_param_stripped', message: `${METHOD} ${path}: ${where} parameter "${p.name}" is a credential and is set by the gateway`, pointer });
          return false;
        }
        return ['path', 'query', 'header', 'cookie'].includes(where);
      });
      const snakeCounts = new Map<string, number>();
      for (const p of plist) snakeCounts.set(snakeCase(p.name as string) || 'param', (snakeCounts.get(snakeCase(p.name as string) || 'param') ?? 0) + 1);
      for (const p of plist) {
        const name = p.name as string;
        const where = p.in as HttpParam['in'];
        let arg = snakeCase(name) || 'param';
        if ((snakeCounts.get(arg) ?? 0) > 1) arg = `${where}_${arg}`;
        const { schema, defs } = resolver.convert(p.schema ?? (isObj(p.content) ? (Object.values(p.content)[0] as Obj | undefined)?.schema : undefined), { drop: 'readOnly' });
        const prop: Obj = { ...schema };
        if (typeof p.description === 'string' && p.description.trim()) prop.description = cleanDescription(undefined, p.description, '').text;
        if (p.deprecated === true) prop.deprecated = true;
        const ex = exampleOf(p, schema);
        if (ex !== undefined && prop.examples === undefined) prop.examples = [ex];
        Object.assign(rootDefs, defs);
        properties[arg] = prop;
        const isRequired = where === 'path' || p.required === true;
        if (isRequired) {
          required.push(arg);
          if (ex !== undefined) exampleArgs[arg] = ex;
          else missingExample = true;
        }
        params.push({ arg, in: where, name, required: isRequired, ...(typeof p.style === 'string' ? { style: p.style } : {}), ...(typeof p.explode === 'boolean' ? { explode: p.explode } : {}) });
      }

      // ---- request body
      let body: HttpBinding['body'];
      const rb = resolver.deref<Obj>(op.requestBody);
      if (isObj(rb) && isObj(rb.content)) {
        const picked = pickMedia(rb.content, ['application/json', '+json', 'application/x-www-form-urlencoded', 'multipart/form-data']);
        if (!picked) {
          diagnostics.push({ severity: 'warning', code: 'body_unsupported', message: `${METHOD} ${path}: request body types ${Object.keys(rb.content).join(', ')} are not supported; the tool sends no body`, pointer: `${pointer}/requestBody` });
        } else {
          const contentType = (picked.type.endsWith('+json') ? 'application/json' : picked.type) as NonNullable<HttpBinding['body']>['contentType'];
          const { schema, defs } = resolver.convert(picked.media.schema, { drop: 'readOnly' });
          const bodyRequired = rb.required === true;
          Object.assign(rootDefs, defs);
          const bodyProps = isObj(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : null;
          const bodyExample = picked.media.example ?? (isObj(picked.media.examples) ? (Object.values(picked.media.examples)[0] as Obj | undefined)?.value : undefined) ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined);
          const clash = bodyProps ? Object.keys(bodyProps).some((k) => k in properties) : true;
          const spread = !!bodyProps && (schema.type === 'object' || schema.type === undefined) && Object.keys(bodyProps).length <= MAX_SPREAD && Object.keys(bodyProps).length > 0 && !clash;
          if (spread) {
            const req = new Set((schema.required as string[] | undefined) ?? []);
            for (const [k, v] of Object.entries(bodyProps)) {
              properties[k] = v;
              if (req.has(k) && bodyRequired) required.push(k);
              if (req.has(k)) {
                if (isObj(bodyExample) && bodyExample[k] !== undefined) exampleArgs[k] = bodyExample[k];
                else if (Array.isArray(v.examples) && v.examples.length) exampleArgs[k] = v.examples[0];
                else missingExample = true;
              }
            }
            body = { arg: null, contentType, spread: true, properties: Object.keys(bodyProps) };
          } else {
            const argName = 'body' in properties ? 'request_body' : 'body';
            const s: Obj = { ...schema };
            if (typeof rb.description === 'string' && !s.description) s.description = rb.description;
            Object.assign(rootDefs, defs);
            properties[argName] = s;
            if (bodyRequired) {
              required.push(argName);
              if (bodyExample !== undefined) exampleArgs[argName] = bodyExample;
              else missingExample = true;
            }
            body = { arg: argName, contentType, spread: false };
          }
        }
      }

      // ---- responses
      const responses = isObj(op.responses) ? op.responses : {};
      const successStatuses: number[] = [];
      let outputSchema: JsonSchema | undefined;
      let responseContentType: string | null = null;
      for (const [code, rawRes] of Object.entries(responses)) {
        const n = /^2\d\d$/.test(code) ? Number(code) : code.toUpperCase() === '2XX' ? 200 : NaN;
        if (Number.isNaN(n)) continue;
        successStatuses.push(n);
        const res = resolver.deref<Obj>(rawRes);
        if (outputSchema || !isObj(res)) continue;
        const media = pickMedia(res.content, ['application/json', '+json']);
        if (media) {
          responseContentType = media.type;
          const { schema, defs } = resolver.convert(media.media.schema, { drop: 'writeOnly' });
          let out: Obj = schema;
          if (schema.type === 'array') out = { type: 'object', properties: { items: schema }, 'x-neurouter-wrapped': 'items' };
          else if (!(schema.type === 'object' || isObj(schema.properties))) out = { type: 'object', properties: { data: schema }, 'x-neurouter-wrapped': 'data' };
          if (Object.keys(defs).length) out = { ...out, $defs: defs };
          outputSchema = out;
        } else if (isObj(res.content)) {
          responseContentType = Object.keys(res.content)[0] ?? null;
        }
      }
      if (successStatuses.length === 0) successStatuses.push(200);

      // ---- risk
      const readOnly = METHOD === 'GET' || METHOD === 'HEAD';
      const risk = { readOnly, destructive: METHOD === 'DELETE', idempotent: ['GET', 'HEAD', 'PUT', 'DELETE'].includes(METHOD), openWorld: true, write: !readOnly };
      const xr = op['x-neurouter-risk'];
      if (isObj(xr)) for (const k of Object.keys(risk) as Array<keyof typeof risk>) if (typeof xr[k] === 'boolean') risk[k] = xr[k] as boolean;
      if (isObj(xr) && typeof xr.readOnly === 'boolean' && typeof xr.write !== 'boolean') risk.write = !risk.readOnly;

      const desc = cleanDescription(op.summary, op.description, `${METHOD} ${path}`);
      if (!desc.fromSpec) diagnostics.push({ severity: 'warning', code: 'description_missing', message: `${METHOD} ${path} has no summary or description`, pointer });
      const examples: ToolExample[] = !missingExample && required.length > 0 ? [{ title: 'From the spec', arguments: exampleArgs, source: 'spec' }] : [];
      const security = Array.isArray(op.security) ? (op.security as Array<Record<string, string[]>>) : globalSecurity;
      const inputSchema: JsonSchema = { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}), additionalProperties: false, ...(Object.keys(rootDefs).length ? { $defs: rootDefs } : {}) };
      const pagination = detectPagination(params.map((p) => p.name), responses, resolver);

      drafts.push({
        baseName,
        pyName: '',
        title: titleFrom(op.summary, baseName),
        description: desc.text,
        kind: 'http',
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        binding: {
          type: 'http',
          method: METHOD,
          pathTemplate: path,
          params,
          ...(body ? { body } : {}),
          successStatuses: successStatuses.sort((a, b) => a - b),
          responseContentType,
          ...(pagination ? { pagination } : {}),
          security,
        },
        risk,
        tags: Array.isArray(op.tags) ? (op.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
        hidden: false,
        pinned: false,
        deprecated: op.deprecated === true,
        examples,
        sourceRef: { ...(operationId ? { operationId } : {}), method: METHOD, path, pointer },
        overlayApplied: [],
        key: operationId ? `operationId:${operationId}` : `${METHOD} ${path}`,
      });
    }
  }

  if (drafts.length > opts.maxTools) {
    diagnostics.push({ severity: 'error', code: 'too_many_tools', message: `The spec has ${drafts.length} operations; the limit is ${opts.maxTools}. Only the first ${opts.maxTools} are compiled.` });
    drafts.length = opts.maxTools;
  }
  const { names, collided } = uniquify(drafts.map((d) => d.baseName));
  for (const i of collided) diagnostics.push({ severity: 'warning', code: 'name_collision', message: `Tool name "${drafts[i]!.baseName}" is used more than once; renamed to "${names[i]}"`, pointer: (drafts[i]!.sourceRef as { pointer: string }).pointer });
  const tools: ToolDef[] = drafts.map(({ baseName: _b, ...d }, i) => ({ ...d, name: names[i]!, pySignature: '', defHash: '' }));
  return { tools, diagnostics, operationCount, title, apiVersion, serverUrl };
}
