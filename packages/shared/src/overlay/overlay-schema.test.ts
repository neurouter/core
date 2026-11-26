import { describe, expect, it } from 'vitest';
import { Overlay, OverlayPatchOp, overlayJsonSchema } from './schema.js';

/** The example overlay from backend spec §8.4 (as parsed YAML). */
const SPEC_EXAMPLE = {
  overlay: 1,
  info: { title: 'GitHub curated', notes: 'Demo toolset for issues and pulls' },
  defaults: { hidden: true },
  tools: {
    'operationId:issues/list-for-repo': {
      name: 'list_issues',
      hidden: false,
      pinned: true,
      description: 'List issues in a repository.',
      args: { rename: { per_page: 'limit' }, hide: ['accept'], defaults: { per_page: 30, state: 'open' }, describe: { labels: 'Comma-separated label names' }, enum: { sort: ['created', 'updated', 'comments'] } },
      response: { include: ['[].number', '[].title'], flatten: { '[].user.login': 'author' }, maxItems: 50, maxBytes: 16384 },
      examples: [{ title: 'Open bugs', arguments: { owner: 'octocat', repo: 'hello-world', labels: 'bug' } }],
      tags: ['read-sensitive'],
    },
    'operationId:issues/create': { name: 'create_issue', hidden: false, risk: { write: true, destructive: false }, tags: ['external-write'] },
    'tag:actions': { hidden: true },
  },
  composites: {
    triage_stale_issues: { title: 'Triage stale issues', description: 'Label stale issues.', inputSchema: { type: 'object', properties: { owner: { type: 'string' } }, required: ['owner'] }, write: true, script: 'return 1' },
  },
  profiles: { triage: { tools: ['list_issues', 'create_issue'] } },
};

describe('overlay schema', () => {
  it('accepts the spec example', () => {
    const r = Overlay.safeParse(SPEC_EXAMPLE);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('rejects unknown fields, bad names and wrong versions', () => {
    expect(Overlay.safeParse({ overlay: 2 }).success).toBe(false);
    expect(Overlay.safeParse({ overlay: 1, tools: { '*': { bogus: true } } }).success).toBe(false);
    expect(Overlay.safeParse({ overlay: 1, tools: { '*': { name: 'Has-Dash' } } }).success).toBe(false);
    expect(Overlay.safeParse({ overlay: 1, composites: { x: { description: 'no script' } } }).success).toBe(false);
  });

  it('validates patch ops', () => {
    expect(OverlayPatchOp.safeParse({ op: 'set', selector: '*', field: 'hidden', value: true }).success).toBe(true);
    expect(OverlayPatchOp.safeParse({ op: 'set', selector: '*', field: 'nope', value: true }).success).toBe(false);
    expect(OverlayPatchOp.safeParse({ op: 'set_default', field: 'hidden', value: 'x' }).success).toBe(false);
  });

  it('exports a JSON Schema', () => {
    const s = overlayJsonSchema();
    expect(s.type).toBe('object');
    expect(Object.keys(s.properties as object)).toEqual(expect.arrayContaining(['overlay', 'tools', 'composites', 'profiles']));
  });
});
