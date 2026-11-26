# Security

Report vulnerabilities privately through GitHub security advisories on `neurouter/neurouter`.

## What the gateway guarantees (backend spec §18)

- Read-only by default; write tools are refused until an environment enables writes. Production
  writes need the user's confirmation through MCP elicitation (2026-07-28 clients); clients that
  cannot elicit cannot write to production.
- Unknown, hidden and not-permitted tools produce identical answers.
- Upstream credentials (`env:NAME` / `secret:NAME` references, AES-256-GCM envelope encryption) never
  reach tool results, errors, audit rows, logs, the executor, the API or traces.
- No SSRF: tools never take URLs, path parameters are percent-encoded, outbound requests go only to the
  environment's `allowedHosts` through an SSRF guard with pinned DNS; cloud metadata is always denied.
- API keys and OAuth tokens are HMAC-SHA256 hashed with `HASH_PEPPER`; OAuth tokens are audience-bound
  to one `/mcp/{server}/{env}`; external JWTs are verified (iss, aud, exp, RS256/ES256/EdDSA only).
- The audit log is hash-chained with HMAC-signed checkpoints; tool calls fail closed when it cannot
  keep up.

## Code mode threat model

Scripts run in Pydantic Monty, a restricted Python interpreter with no file system, network or OS
access, inside a separate executor process:

| Layer | Control |
|---|---|
| L1 language | Source validator (no imports, classes, dunders, eval/exec/open, async), Monty without mounts, `os` callbacks denied, frozen clock, seeded random, 16 KiB source cap |
| L2 runtime | CPU time (Linux) / wall time, 64 MiB heap, recursion 200, 200 tool calls, 1 MiB result; one session per worker, worker discarded after every run; Monty binary pinned by path + sha256 |
| L3 process | Monty worker subprocesses with an empty environment; executor child process with a minimal environment and no secrets; non-root image |
| L4 egress | **Not enforceable inside one container** (Docker, Cloud Run): the executor holds no secrets and only knows its socket. On Kubernetes use `executor.mode: deployment` (deny-all egress NetworkPolicy) |
| L5 capabilities | Per-run capability token, allowed-function list per principal, every inner call through the full policy pipeline |

The executor treats nothing from the server as code to trust and the server treats every executor
frame as untrusted (size-limited, schema-validated, checked against the run capability).
