import { createServer } from 'node:http';
import { compile, handleMockRequest, MemoryMockStateStore } from '@neurouter/compiler';
import { readSpec } from './common.js';

/** `npx neurouter mock`: the in-process mock handler (§16) over HTTP. */
export async function cmdMock(o: { spec: string; port: string; seed: string }): Promise<void> {
  const bytes = await readSpec(o.spec);
  const r = await compile({ spec: { bytes }, namespace: 'api' });
  const model = r.mockModel;
  if (!model) throw new Error('this spec has no mockable operations');
  const store = new MemoryMockStateStore({ seed: Number(o.seed) });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      const query: Record<string, string | string[]> = {};
      for (const [k, v] of url.searchParams) query[k] = query[k] === undefined ? v : ([] as string[]).concat(query[k]!, v);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      void handleMockRequest(model as never, store, 'cli', { method: req.method ?? 'GET', path: url.pathname, query, body }).then((out) => {
        res.writeHead(out.status, out.headers);
        res.end(out.body === undefined || out.status === 204 ? undefined : JSON.stringify(out.body));
      });
    });
  });
  server.listen(Number(o.port), () => console.log(`mock ${r.title} on http://localhost:${o.port} (${r.tools.length} operations, seed ${o.seed})`));
}
