import { execSync } from 'node:child_process';
import type { HostBridge, HostCallResult, RunRequest } from '../types.js';

/** Minimal stand-in for the server's wrapScript (body indented under a function). */
export function wrap(body: string): { code: string; lineOffset: number; colOffset: number } {
  const lines = body.split('\n').map((l) => (l.trim() ? `    ${l}` : l));
  return { code: `def __neurouter_main__():\n${lines.join('\n')}\n__neurouter_main__()`, lineOffset: 1, colOffset: 4 };
}

export const GITHUB_STUBS = `from typing import Any
def list_issues(*, owner: str, repo: str, state: str = "open", limit: int = 30) -> list[dict[str, Any]]: ...
def add_labels(*, owner: str, repo: str, issue_number: int, labels: list[str]) -> dict[str, Any]: ...
def get_issue(*, owner: str, repo: str, issue_number: int) -> dict[str, Any]: ...
`;

export function request(body: string, over: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: `run_${Math.random().toString(36).slice(2)}`,
    capability: 'rc_test_capability',
    ...wrap(body),
    modules: { github: { functions: ['list_issues', 'add_labels', 'get_issue'], stubs: GITHUB_STUBS } },
    inputs: {},
    limits: { cpuTimeSec: 5, wallTimeSec: 20, maxMemoryMb: 64, maxToolCalls: 200, maxConcurrentCalls: 8, maxResultBytes: 1024 * 1024 },
    osPolicy: { datetime: '2026-11-26T12:00:00.000Z', seed: 42 },
    ...over,
  };
}

export interface RecordingHost extends HostBridge {
  calls: Array<{ fn: string; kwargs: Record<string, unknown> }>;
}

/** Fake host: 30 issues, two of them stale; add_labels records; get_issue answers after `delayMs`. */
export function fakeHost(handler?: (fn: string, kwargs: Record<string, unknown>) => Promise<HostCallResult> | HostCallResult): RecordingHost {
  const calls: RecordingHost['calls'] = [];
  return {
    calls,
    async call(fn, kwargs) {
      calls.push({ fn, kwargs });
      if (handler) return handler(fn, kwargs);
      if (fn === 'github.list_issues') {
        return {
          ok: true,
          value: Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, updated_at: i < 2 ? '2026-09-01T00:00:00Z' : '2026-11-20T00:00:00Z' })),
        };
      }
      if (fn === 'github.add_labels') return { ok: true, value: { ok: true, issue_number: kwargs.issue_number } };
      if (fn === 'github.get_issue') {
        const n = Number(kwargs.issue_number);
        await new Promise((r) => setTimeout(r, (10 - n) * 15));
        return n === 3 ? { ok: false, error: { code: 'upstream_not_found', message: 'Issue 3 not found', errorId: 'err_abc' } } : { ok: true, value: { number: n } };
      }
      return { ok: false, error: { code: 'unknown_tool', message: 'Tool not found or not permitted' } };
    },
  };
}

/** PIDs of `monty` worker processes that are children of this process. */
export function montyWorkerPids(): number[] {
  try {
    return execSync(`ps -A -o pid=,ppid=,comm=`, { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 3 && Number(p[1]) === process.pid && /monty$/.test(p.slice(2).join(' ')))
      .map((p) => Number(p[0]));
  } catch {
    return [];
  }
}

export const STALE_SCRIPT = `issues = github.list_issues(owner="octo", repo="demo", state="open", limit=30)
stale = [i for i in issues if ops.days_since(i["updated_at"]) > 30]
for i in stale:
    github.add_labels(owner="octo", repo="demo", issue_number=i["number"], labels=["stale"])
return {"checked": len(issues), "labelled": [i["number"] for i in stale]}`;
