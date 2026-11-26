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

Token figures in eval reports are comparable across providers: tokens of an attempt = uncached input +
cached input + output (reasoning included), summed over its turns; "tokens per multi-step task" is the
mean of that over the multi-step attempts. Cached input (OpenAI `cached_tokens`, Anthropic
`cache_read_input_tokens`, Gemini `total_cached_tokens`) is also reported on its own, and Anthropic cache
writes are counted as input. `--transcripts <file>` writes every attempt untrimmed (`--transcript-max-chars`
to cap each item).

## Agent contract

Tool results follow one of two contracts, chosen per session:

- **Contract 2** (default for servers created from this release on): every `tools/call` result is one envelope,
  `{"ok","data","page","truncated","error","state"}` (plus an optional `hint`), as the only text item and as
  `structuredContent`. `data` is the API's payload unchanged; `page` says `count`/`total`/`has_more` on list tools,
  with `next_cursor`: pass it as `cursor` to the same tool with the same other arguments for the next page, whatever
  the upstream's paging style (cursor tokens, page/per_page, offset/limit, `starting_after`, `Link` headers) and
  for the rest of a list Neurouter cut. Cursors are signed, bound to the tool, arguments and credential, and last
  1 hour. Every tool takes `fields` (dot paths, per item on lists; the overlay `include` is the default set) and
  list tools take `limit` (the upstream page size); names the upstream already uses get an `nr_` prefix.
  `truncated` names the object fields Neurouter clipped and the `fields` call that returns them; `error` has a code, a short message,
  every invalid field with its allowed values, `retry` and `next` (the exact call to make next); `state` carries the
  environment, write mode, task and call counter (and identical-result streaks). Unknown tools answer with an
  envelope (`unknown_tool` + closest names), not a JSON-RPC error. In `run_script`, tool functions return plain data
  and raise `LookupError`/`ValueError`/`PermissionError`/… whose message is the error object;
  `ops.pages(fn="ns.list_x", args={…}, max_items=500)` returns the items of every page.
- **Contract 1**: the 0.2.x shapes. Servers created before contract 2 keep it until switched.

A client picks a version with the capability `experimental["dev.neurouter/contract"] = {"versions":[2,1]}` or the
header `X-Neurouter-Contract: 2`; otherwise `exposure.contract` (server, or per environment in `neurouter.yaml`)
decides. `NEUROUTER_NEW_SERVER_CONTRACT` (default `2`) sets the contract of new servers. `exposure.outputSchema`
is `envelope` (default: the shared envelope schema with an open `data`), `none`, or `typed` (the shaped upstream
schema as `data`, validated before sending; a tool whose response does not match is re-listed without it and
reported in the inbox).

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
