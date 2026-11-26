# Neurouter eval action

Scores how well AI agents can use your API through Neurouter (agent-readiness 0–100, tool vs code mode)
and writes the report to the job summary.

```yaml
jobs:
  agent-readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: neurouter/core/actions/eval@v0.3.1
        with:
          spec: openapi.yaml
          suite: neurouter/suite.json      # optional: freeze a generated suite for stable CI
          min-score: 70
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}   # default model gpt-6-luna
          # models: gpt-6-luna,claude-sonnet-5-5      # add anthropic-api-key / gemini-api-key for other providers
```

With a `neurouter.yaml`, pass `config` and `server` instead of `spec` (the eval runs against that
server's spec, overlay and environment):

```yaml
      - uses: neurouter/core/actions/eval@v0.3.1
        with:
          config: neurouter.yaml
          server: acme-orders
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

The action runs the `neurouter` CLI of its own version: the tag you reference (`@v0.3.1` → `neurouter@0.3.1`),
or the CLI version in the repository at that ref when you pin a branch or commit. Set `neurouter-version`
to override it.

`max-run-tokens` caps the run's spend (agent and judge tokens): no new attempt starts once it is reached and
the report marks the run incomplete.

Outputs: `score`, `recommended-mode`, `report-path`. The step fails when the CLI exits non-zero
(score below `min-score`, or an error).
