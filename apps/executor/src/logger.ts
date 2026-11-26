import type { ExecLogger } from './types.js';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;
type Level = keyof typeof LEVELS;

/** JSON-lines logger on stderr (the executor has no pino dependency). */
export function createStderrLogger(level: string = 'info', name = 'neurouter-executor'): ExecLogger {
  const min = LEVELS[(level in LEVELS ? level : 'info') as Level];
  const write = (lvl: Level) => (obj: object, msg?: string) => {
    if (LEVELS[lvl] < min) return;
    const rec: Record<string, unknown> = { level: LEVELS[lvl], time: Date.now(), name, pid: process.pid, ...serializeErrors(obj) };
    if (msg) rec.msg = msg;
    process.stderr.write(JSON.stringify(rec) + '\n');
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

function serializeErrors(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
  return out;
}

export const silentLogger: ExecLogger = { debug() {}, info() {}, warn() {}, error() {} };
