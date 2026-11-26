#!/usr/bin/env node
// Builds github-subset.json (issues/pulls/repos/labels/comments) from the full GitHub REST description.
// Usage: node examples/github/subset.mjs [spec/api.github.com.json] [github-subset.json]
/* global console */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ?? path.join(here, 'spec/api.github.com.json');
const out = process.argv[3] ?? path.join(here, 'github-subset.json');
const OPS = new Set(`repos/get repos/list-for-user repos/list-for-org repos/update repos/list-branches repos/get-branch repos/list-commits repos/list-tags repos/list-contributors
issues/list-for-repo issues/create issues/get issues/update issues/lock issues/unlock
issues/list-comments issues/create-comment issues/get-comment issues/update-comment issues/delete-comment issues/list-comments-for-repo
issues/list-labels-on-issue issues/add-labels issues/remove-label issues/set-labels issues/list-labels-for-repo issues/create-label issues/get-label issues/update-label issues/delete-label
issues/list-assignees issues/add-assignees issues/list-milestones issues/create-milestone
pulls/list pulls/create pulls/get pulls/update pulls/list-commits pulls/list-files pulls/merge pulls/check-if-merged pulls/list-review-comments pulls/create-review-comment pulls/list-reviews pulls/create-review pulls/request-reviewers
search/issues-and-pull-requests`.split(/\s+/).filter(Boolean));
const doc = JSON.parse(fs.readFileSync(src, 'utf8'));
const paths = {};
for (const [p, item] of Object.entries(doc.paths)) {
  const keep = {};
  for (const [m, op] of Object.entries(item)) if (op && typeof op === 'object' && OPS.has(op.operationId)) keep[m] = op;
  if (Object.keys(keep).length) paths[p] = { ...(item.parameters ? { parameters: item.parameters } : {}), ...keep };
}
// transitive component closure
const comps = {};
const queue = [];
const scan = (v) => {
  if (Array.isArray(v)) return v.forEach(scan);
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string') queue.push(x);
      else scan(x);
    }
  }
};
scan(paths);
while (queue.length) {
  const ref = queue.pop();
  const [, , kind, name] = ref.split('/');
  comps[kind] ??= {};
  if (comps[kind][name]) continue;
  comps[kind][name] = doc.components[kind][name];
  scan(comps[kind][name]);
}
if (doc.components.securitySchemes) comps.securitySchemes = doc.components.securitySchemes;
const subset = { openapi: doc.openapi, info: { ...doc.info, title: 'GitHub REST API (issues, pulls, repos subset)' }, servers: doc.servers, tags: doc.tags.filter((t) => ['issues', 'pulls', 'repos', 'search'].includes(t.name)), paths, components: comps };
fs.writeFileSync(out, JSON.stringify(subset, null, 1) + '\n');
console.log(`ops kept: ${Object.values(paths).reduce((n, i) => n + Object.keys(i).filter((k) => k !== 'parameters').length, 0)} / wanted ${OPS.size}; bytes ${fs.statSync(out).size}`);
