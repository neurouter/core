# Neurouter eval action

Scores how well AI agents can use your API through Neurouter (agent-readiness 0–100, tool vs code mode)
and writes the report to the job summary.

```yaml
jobs:
  agent-readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: neurouter/neurouter/actions/eval@v0.1.0
        with:
          spec: openapi.yaml
          suite: neurouter/suite.json      # optional: freeze a generated suite for stable CI
          min-score: 70
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Outputs: `score`, `recommended-mode`, `report-path`. The step fails when the CLI exits non-zero
(score below `min-score`, or an error).
