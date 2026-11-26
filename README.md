# Neurouter

Turn an OpenAPI or GraphQL API into a governed MCP server that AI agents can actually use:

- **Compiler**: OpenAPI 3.0/3.1 and GraphQL (SDL or introspection) → a curated tool model, with
  overlays (rename, describe, hide, shape responses, composites) that survive spec re-imports.
- **Data plane**: one stateless MCP endpoint per server and environment (`/mcp/{server}/{env}`,
  protocol 2026-07-28 plus the 2025-11-25 path), read-only by default, prod writes confirmed by the
  user through MCP elicitation, policies, rate limits, kill switches, hash-chained audit log.
- **Code mode**: `run_script` runs short Python scripts (Pydantic Monty, sandboxed in a separate
  executor process) that call the API tools as functions, with dry runs and planned changes.
- **Ops tools**: `neurouter_begin_task`, `end_task`, `report_unmet_need`, `report_issue`,
  `explain_error`, … so agents frame their work and tell you what the API is missing.
- **Evals**: generated agent tasks run in tool and code mode, an agent-readiness score (0–100) and
  fix suggestions as overlay patches (`npx neurouter eval`, GitHub Action).

Apache-2.0. © Neurouter contributors.

## Quickstart

```bash
npm install
npx tsx --conditions=@neurouter/source packages/cli/src/main.ts serve --config neurouter.example.yaml
# published package: npx neurouter serve --config neurouter.example.yaml
```

The example loads the Swagger Petstore against the in-process mock:

```bash
TOKEN=$(npx tsx --conditions=@neurouter/source packages/cli/src/main.ts keys create --server petstore --env dev --scopes tools:read,code:run)
claude mcp add --transport http petstore http://localhost:3000/mcp/petstore/dev --header "Authorization: Bearer $TOKEN"
```

Evals without an API key (deterministic stub provider, not a real model):

```bash
NEUROUTER_EVAL_LLM=stub npx tsx --conditions=@neurouter/source packages/cli/src/main.ts eval \
  --spec examples/petstore/openapi.yaml --generate --repeats 1 --md report.md
```

With `OPENAI_API_KEY` set, the same command uses the default model `gpt-6-luna` (BYOK). Evals also run
on Anthropic (`ANTHROPIC_API_KEY`, `claude-*` models) and Gemini (`GEMINI_API_KEY`, `gemini-*` models):
pass `--models gpt-6-luna,claude-sonnet-5-5,gemini-3.5-flash-lite` to compare them; each model goes to
its provider (`provider:model` forces one). Keys can also be stored, encrypted, in the console
(Settings › Models).

## Development

| Command | What |
|---|---|
| `npm run dev` | server (tsx watch, embedded executor) + console dev server |
| `npm test` | Vitest (unit + in-process integration tests); `NEUROUTER_TEST_PG_URL=postgres://…` adds Postgres runs |
| `npm run typecheck` / `npm run lint` | TypeScript project build + test configs; ESLint incl. the data/control plane boundary |
| `npm run keys -- gen` | crypto values for `.env` |

Layout: `packages/shared` (REST contract the console imports), `packages/compiler`, `packages/evals`,
`apps/executor` (Monty pool behind a socket frame protocol), `apps/server` (`kernel/`, `dataplane/`,
`controlplane/`), `apps/web` (console), `packages/cli` (npm `neurouter`).

Local dev uses SQLite (no Docker). Production uses Postgres with pgvector.

## Deploy

- Docker: `docker build -t neurouter-core .` then `docker run -p 3000:3000 --env-file .env -e NEUROUTER_CONFIG=/app/neurouter.example.yaml neurouter-core`.
- Docker image: `ghcr.io/neurouter/core:<version>`.
- Kubernetes: the `neurouter-core` chart, `helm install neurouter oci://ghcr.io/neurouter/charts/neurouter-core --version <version> -f values.yaml`
  (source in `deploy/helm/neurouter-core`; executor as a sidecar, or a separate Deployment with a deny-all
  egress NetworkPolicy, recommended for production). Model provider keys: `openai.existingSecret`,
  `anthropic.existingSecret`, `gemini.existingSecret`.
- Cloud Run demo: `deploy/cloudrun/setup.sh` and `deploy/cloudrun/deploy.sh` (reviewed and run by a human).

See [SECURITY.md](SECURITY.md) for the code-mode threat model.
