import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '@neurouter/compiler';
import { validateGenerated } from './generate.js';
import { resolveTaskTools, sourceNameOfKey, stampToolKeys } from './tool-identity.js';
import { task } from './test/fixtures.js';
import type { EvalTask, GenTool, SuiteFile } from './types.js';

const REPO = resolve(import.meta.dirname, '../../..');

describe('tool identity (suites survive overlay renames)', () => {
  const t = task({
    assertions: [{ type: 'called', tool: 'issues_get', toolKey: 'operationId:issues/get', args: { issue_number: 1 } }, { type: 'not_called', tool: 'issues_update' }, { type: 'max_calls', n: 2 }],
    referenceCalls: [{ tool: 'issues_get', toolKey: 'operationId:issues/get', arguments: { issue_number: 1 } }],
  });

  it('resolves by key, then by name, then by the pre-overlay name', () => {
    const tools = [
      { name: 'get_issue', key: 'operationId:issues/get' },
      { name: 'update_issue', key: 'operationId:issues/update' },
    ];
    const [r] = resolveTaskTools([t], tools);
    expect(r!.assertions[0]).toMatchObject({ type: 'called', tool: 'get_issue', toolKey: 'operationId:issues/get', args: { issue_number: 1 } });
    // no key (older suite): the raw name issues_update is the source name of operationId issues/update
    expect(r!.assertions[1]).toEqual({ type: 'not_called', tool: 'update_issue' });
    expect(r!.referenceCalls[0]!.tool).toBe('get_issue');
    // unchanged when nothing matches; untouched assertions stay as they are
    expect(resolveTaskTools([task({ assertions: [{ type: 'called', tool: 'nope' }] })], tools)[0]!.assertions[0]).toEqual({ type: 'called', tool: 'nope' });
    expect(sourceNameOfKey('GET /repos/{owner}/{repo}')).toBeTruthy();
  });

  it('stamps keys on generated tasks', async () => {
    const tools: GenTool[] = [{ name: 'issues_get', description: '', inputSchema: {}, write: false, key: 'operationId:issues/get' }];
    const v = await validateGenerated({ key: 'k', category: 'single', prompt: 'Get issue 1', rubric: '', assertions: [{ type: 'called', tool: 'issues_get' }], reference_calls: [{ tool: 'issues_get', arguments: { issue_number: 1 } }] }, 'single', { tools }, new Set());
    expect(v.ok).toBe(true);
    const task = (v as { task: EvalTask }).task;
    expect(task.assertions[0]).toEqual({ type: 'called', tool: 'issues_get', toolKey: 'operationId:issues/get' });
    expect(task.referenceCalls[0]).toEqual({ tool: 'issues_get', toolKey: 'operationId:issues/get', arguments: { issue_number: 1 }, required: ['issue_number'] });
    expect(stampToolKeys(task, [{ name: 'issues_get', key: 'other' }]).assertions[0]).toMatchObject({ toolKey: 'operationId:issues/get' });
  });

  it('runs the frozen GitHub suite (raw names, no keys) against an overlay that renames tools', async () => {
    const suite = JSON.parse(readFileSync(resolve(REPO, 'examples/github/eval-suite.json'), 'utf8')) as SuiteFile;
    const spec = readFileSync(resolve(REPO, 'examples/github/github-subset.json'));
    const raw = await compile({ spec: { bytes: spec }, namespace: 'github' });
    const overlay = 'overlay: 1\ntools:\n  "operationId:issues/get": { name: get_issue }\n  "operationId:issues/list-for-repo": { name: list_repo_issues }\n';
    const renamed = await compile({ spec: { bytes: spec }, namespace: 'github', overlay });
    expect(renamed.ok).toBe(true);
    const names = (ts: typeof raw.tools) => new Set(ts.map((x) => x.name));
    const used = (tasks: EvalTask[]) => tasks.flatMap((x) => x.assertions.flatMap((a) => (a.type === 'called' ? [a.tool] : [])));
    const inSubset = suite.tasks.filter((x) => used([x]).every((n) => names(raw.tools).has(n)));
    expect(used(inSubset)).toContain('issues_get');
    const resolved = resolveTaskTools(inSubset, renamed.tools);
    expect(used(resolved).every((n) => names(renamed.tools).has(n))).toBe(true);
    expect(used(resolved)).toContain('get_issue');
    expect(used(resolved)).not.toContain('issues_get');
    // stamped once, a later rename resolves by key
    const stamped = inSubset.map((x) => stampToolKeys(x, raw.tools));
    const again = await compile({ spec: { bytes: spec }, namespace: 'github', overlay: overlay.replace('get_issue', 'fetch_issue') });
    expect(used(resolveTaskTools(stamped, again.tools))).toContain('fetch_issue');
  }, 30_000);
});
