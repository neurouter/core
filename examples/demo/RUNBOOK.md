# Launch demo runbook (raw → curated)

Prerequisites: `npm install` and an Anthropic key (`ANTHROPIC_API_KEY`). Without a key, prefix the
commands with `NEUROUTER_EVAL_LLM=stub` to run the deterministic stub provider (not a real model; the
report says so).

1. Measure the raw spec (tool mode), keep the generated suite frozen for later runs:

   ```
   npx neurouter eval --config examples/demo/neurouter.yaml --server github-raw --modes tool \
     --generate --save-suite examples/demo/suite.json --suggest --out raw.json --md raw.md
   ```

2. Apply suggestions (console: Evals → run → Fixes → Apply as draft → Publish) and/or use the curated
   overlay `examples/github/curated.overlay.yaml` (server `github`).
3. Re-run both modes with the frozen suite:

   ```
   npx neurouter eval --config examples/demo/neurouter.yaml --server github --suite examples/demo/suite.json \
     --modes tool,code --out curated.json --md curated.md
   ```

4. Compare: console `/evals/compare?base=<raw run id>&head=<curated run id>` (score rise and token drop).

On the Cloud Run demo (`deploy/cloudrun/deploy.sh`) the admin runs the same from the console; anonymous
visitors see the stored runs, the compare page and the public report `/public/servers/github/report`.
