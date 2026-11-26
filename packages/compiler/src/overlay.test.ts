import { describe, expect, it } from 'vitest';
import type { CompositeBinding, HttpBinding } from '@neurouter/shared';
import { parseOverlay } from './overlay/parse.js';
import { compileText, NOTES_SPEC } from './test/fixtures.js';

const tool = (r: Awaited<ReturnType<typeof compileText>>, name: string) => {
  const t = r.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}: ${r.tools.map((x) => x.name).join(',')}`);
  return t;
};

describe('overlay application', () => {
  it('applies name/title/description/hidden/pinned/deprecated/risk/tags/examples/response', async () => {
    const r = await compileText(
      NOTES_SPEC,
      `overlay: 1
tools:
  "operationId:listNotes":
    name: list_project_notes
    title: List notes
    description: List notes in a project. <b>Newest</b> first.
    pinned: true
    deprecated: true
    tags: [read-sensitive]
    examples:
      - title: Open notes
        arguments: { project: demo, state: open }
    response: { include: ["[].id", "[].title"], maxItems: 10 }
  "DELETE /projects/{project}/notes/{note_id}":
    hidden: true
    risk: { destructive: false }
`,
    );
    expect(r.ok).toBe(true);
    const t = tool(r, 'list_project_notes');
    expect(t).toMatchObject({ title: 'List notes', description: 'List notes in a project. Newest first.', pinned: true, deprecated: true, overlayApplied: ['operationId:listNotes'] });
    expect(t.tags).toEqual(['notes', 'read-sensitive']);
    expect(t.examples).toEqual([{ title: 'Open notes', arguments: { project: 'demo', state: 'open' }, source: 'overlay' }]);
    expect(t.shaping).toEqual({ include: ['[].id', '[].title'], maxItems: 10 });
    expect(t.pyName).toBe('test.list_project_notes');
    expect(Object.keys((t.outputSchema as any).properties.items.items.properties)).toEqual(['id', 'title']);
    const del = tool(r, 'delete_note');
    expect(del.hidden).toBe(true);
    expect(del.risk).toMatchObject({ destructive: false, write: true });
    expect(r.pythonStubs.test).not.toContain('def delete_note');
  });

  it('resolves defaults → "*" → tag → specific in that order', async () => {
    const r = await compileText(
      NOTES_SPEC,
      `overlay: 1
defaults: { hidden: true }
tools:
  "operationId:getNote": { hidden: false, title: Specific }
  "tag:notes": { hidden: false, title: From tag }
  "*": { tags: [all] }
`,
    );
    expect(tool(r, 'get_note').title).toBe('Specific');
    expect(tool(r, 'list_notes').title).toBe('From tag');
    expect(tool(r, 'delete_note').hidden).toBe(true);
    expect(r.tools.every((t) => t.tags.includes('all'))).toBe(true);
    expect(tool(r, 'get_note').overlayApplied).toEqual(['*', 'tag:notes', 'operationId:getNote']);
  });

  it('args: rename, hide (with default), defaults, describe, enum, required', async () => {
    const r = await compileText(
      NOTES_SPEC,
      `overlay: 1
tools:
  "operationId:listNotes":
    args:
      rename: { per_page: limit }
      hide: [page]
      defaults: { per_page: 50, page: 1, state: open }
      describe: { state: "open or closed" }
      enum: { state: [open] }
  "operationId:createNote":
    args:
      required: [body]
`,
    );
    const t = tool(r, 'list_notes');
    const props = t.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual(['project', 'state', 'limit']);
    expect(props.limit).toMatchObject({ default: 50 });
    expect(props.state).toMatchObject({ description: 'open or closed', enum: ['open'], default: 'open' });
    expect(t.args).toEqual({ renamed: { limit: 'per_page' }, hidden: { page: 1 }, defaults: { limit: 50, state: 'open' } });
    expect(t.pySignature).toContain('limit: int = 50');
    expect(tool(r, 'create_note').inputSchema.required).toEqual(['project', 'title', 'body']);
  });

  it('refuses to hide a required arg without a default', async () => {
    const r = await compileText(NOTES_SPEC, `overlay: 1\ntools:\n  "operationId:getNote":\n    args: { hide: [note_id] }\n`);
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.code === 'overlay_hides_required_arg')!;
    expect(d.line).toBe(3);
    expect(Object.keys(tool(r, 'get_note').inputSchema.properties as object)).toContain('note_id');
  });

  it('reports orphaned keys and unknown args, never failing the build for them', async () => {
    const r = await compileText(NOTES_SPEC, `overlay: 1\ntools:\n  "operationId:gone": { hidden: true }\n  "tag:nothing": { hidden: true }\n  "operationId:getNote": { args: { describe: { nope: x } } }\n`);
    expect(r.ok).toBe(true);
    expect(r.orphanedOverlayKeys).toEqual(['tag:nothing', 'operationId:gone']);
    expect(r.diagnostics.some((d) => d.code === 'overlay_unknown_arg')).toBe(true);
  });

  it('adds composites and profiles', async () => {
    const r = await compileText(
      NOTES_SPEC,
      `overlay: 1
composites:
  close_all:
    description: Close every open note in a project.
    inputSchema: { type: object, properties: { project: { type: string } }, required: [project] }
    write: true
    script: |
      notes = test.list_notes(project=project, state="open")
      return len(notes)
profiles:
  readers: { tools: [list_notes, get_note, missing_tool] }
`,
    );
    const c = tool(r, 'close_all');
    expect(c.kind).toBe('composite');
    expect((c.binding as CompositeBinding).namespace).toBe('test');
    expect(c.risk.write).toBe(true);
    expect(c.inputSchema.additionalProperties).toBe(false);
    expect(c.key).toBe('composite:close_all');
    expect(r.profiles).toEqual({ readers: ['list_notes', 'get_note', 'missing_tool'] });
    expect(r.diagnostics.some((d) => d.code === 'profile_unknown_tool')).toBe(true);
  });

  it('suffixes names that collide after renames', async () => {
    const r = await compileText(NOTES_SPEC, `overlay: 1\ntools:\n  "operationId:getNote": { name: list_notes }\n`);
    expect(r.tools.map((t) => t.name)).toContain('list_notes_2');
    expect(r.diagnostics.some((d) => d.code === 'name_collision')).toBe(true);
  });

  it('sets the idempotency header on HTTP tools', async () => {
    const r = await compileText(NOTES_SPEC, `overlay: 1\ntools:\n  "operationId:createNote": { idempotencyHeader: Idempotency-Key }\n`);
    expect((tool(r, 'create_note').binding as HttpBinding).idempotencyHeader).toBe('Idempotency-Key');
  });

  it('replaces a GraphQL selection', async () => {
    const r = await compileText('type Query { "Get a user." user(id: ID!): User }\ntype User { id: ID! name: String! email: String }', `overlay: 1\ntools:\n  "graphql:Query.user": { graphql: { selection: "{ id name }" } }\n`);
    expect((r.tools[0]!.binding as { document: string }).document).toBe('query user($id: ID!) {\n  user(id: $id) { id name }\n}');
  });
});

describe('parseOverlay', () => {
  it('accepts an empty overlay', () => {
    expect(parseOverlay('').overlay).toEqual({ overlay: 1 });
  });
  it('reports YAML errors and schema errors with line numbers', () => {
    expect(parseOverlay('overlay: 1\ntools: [').diagnostics[0]).toMatchObject({ code: 'overlay_yaml' });
    const bad = parseOverlay('overlay: 1\ntools:\n  "operationId:x":\n    hidden: yes-please\n    bogus: 1\n');
    expect(bad.overlay).toBeNull();
    const codes = bad.diagnostics.map((d) => [d.code, d.line]);
    expect(codes).toContainEqual(['overlay_invalid', 4]);
    expect(bad.diagnostics.some((d) => d.message.includes('bogus'))).toBe(true);
    expect(parseOverlay('overlay: 2').diagnostics[0]!.code).toBe('overlay_invalid');
  });
  it('validates response paths', () => {
    const r = parseOverlay('overlay: 1\ntools:\n  "*":\n    response: { include: ["a..b"] }\n');
    expect(r.diagnostics[0]).toMatchObject({ code: 'overlay_path', line: 4 });
  });
  it('rejects invalid tool names', () => {
    expect(parseOverlay('overlay: 1\ntools:\n  "*": { name: Bad-Name }\n').overlay).toBeNull();
  });
});
