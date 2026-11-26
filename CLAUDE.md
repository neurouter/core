# Neurouter

Turns an OpenAPI or GraphQL API into a governed MCP server with code mode (Python via Pydantic Monty), ops tools and evals. Apache-2.0. Not Neurouter Hub (a separate product and repo; code was copied from it, never imported).

- Spec and plans live outside this repo (`neurouter/internal` checkout): backend spec, frontend spec, progress log `backend-progress.md`.
- npm workspaces: `packages/shared` (zod REST contract the console imports; isomorphic, zod only), `packages/compiler` (pure spec → tool model), `packages/evals`, `apps/executor` (Monty pool behind a socket frame protocol), `apps/server` (Fastify: `kernel/`, `dataplane/`, `controlplane/`), `apps/web` (console, separate workstream), `packages/cli` (npm `neurouter`).
- Plane boundary is enforced by ESLint: `dataplane/**` never imports `controlplane/**` and vice versa; both use `kernel/**`. Only `deps.ts`, `routes.ts`, `server.ts` wire both.
- Local dev uses SQLite (no Docker). Postgres (pgvector) is supported; set `DATABASE_URL=postgres://…`.
- Tests: Vitest unit tests (+ in-process integration tests with `fastify`/real HTTP on 127.0.0.1). `npm test`, `npm run typecheck`, `npm run lint`.
- Never require a real `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` in tests: use `NEUROUTER_EVAL_LLM=stub` (deterministic) or the fake fixture provider.
- `kernel/db/schema.ts` is generated: `npx tsx --conditions=@neurouter/source apps/server/src/scripts/gen-schema.ts` (run from `apps/server`).
