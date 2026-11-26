# GitHub REST: raw spec vs agent-ready overlay

Measured on 2026-11-26 with the full GitHub REST description (1281 tools). All runs use the same frozen
20-task suite (`eval-suite.json`: 8 single, 6 multi-step, 3 ambiguous, 3 impossible) against Neurouter's
mock environment, not the real API.

| State | Mode | Model | Repeats | Score | Success | Tokens / multi-step task | Calls / task |
|---|---|---|---|---|---|---|---|
| Raw spec (1281 tools, search discovery) | tool | gpt-6-luna | 3 | **46** (Not ready) | 15% | 34,370 | 3.5 |
| `agent-ready.overlay.yaml` (40 tools) | tool | gpt-6-luna | 3 | **70** (Needs work) | 57% | 2,712 | 1.9 |
| `agent-ready.overlay.yaml` (40 tools) | code | gpt-6-luna | 3 | 70 | 57% | 8,171 | 2.0 |

Recommended mode for gpt-6-luna: tool. Model matrix on the overlay (1 repeat):

| Model | Tool mode | Code mode | Recommended |
|---|---|---|---|
| claude-sonnet-5-5 | 71 (55%) | 74 (60%) | code |
| gemini-3.5-flash-lite | 70 (55%) | 72 (60%) | tool (within 3 points) |

Tokens are Neurouter's reported figure: uncached input + output. Cache reads are not counted, so token
figures are not comparable across providers (OpenAI caches the tool list automatically).

## Files

- `agent-ready.overlay.yaml`: the overlay. Every entry is tagged `[auto]` (from `neurouter eval --suggest`),
  `[curated]` (from `curated.overlay.yaml`, without its renames) or `[manual]`. Tool names stay raw because
  eval assertions match tools by name.
- `eval-suite.json`: the frozen suite. It was generated from a 122-tool slice of the raw spec
  (`generation-scope.overlay.yaml`: issues, pulls, search and a few repo reads), because each generator call
  over all 1281 tools sends about 516k tokens of tool schemas.
- `curated.overlay.yaml`: the earlier hand-written overlay (renames tools; not used for these numbers).

## Reproduce

Needs the generator and mock fixes on the `demo/github-stripe` branch (or a release that includes them),
and `OPENAI_API_KEY` (plus `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` for the matrix).

```sh
curl -fsSLo github.yaml https://raw.githubusercontent.com/github/rest-api-description/36dd877176930e2f62cba7f678b818a7af1dad65/descriptions/api.github.com/api.github.com.yaml
# before
npx neurouter eval --spec github.yaml --suite eval-suite.json --modes tool --models gpt-6-luna --repeats 3 --out before.json --md before.md --suggest
# after
npx neurouter eval --spec github.yaml --overlay agent-ready.overlay.yaml --suite eval-suite.json --modes tool,code --models gpt-6-luna --repeats 3 --out after.json --md after.md
# model matrix
npx neurouter eval --spec github.yaml --overlay agent-ready.overlay.yaml --suite eval-suite.json --modes tool,code --models claude-sonnet-5-5 --repeats 1
npx neurouter eval --spec github.yaml --overlay agent-ready.overlay.yaml --suite eval-suite.json --modes tool,code --models gemini-3.5-flash-lite --repeats 1
```

LLM results vary between runs; expect a few points of spread, especially with one repeat.

## Caveats

- Mock environment: responses are generated from the spec. Some failures come from the mock, not the agent:
  `repos_list_commits` mock responses fail the tool's own output schema (`commit.author.date` is not a
  date-time), and a few generated `answer_contains` values (e.g. assignee logins) are not reproduced by the
  mock at run time.
- Single-call tasks in the raw run did return the right answer, but the generated `max_calls: 1` budget
  failed them: the raw responses were too large, so agents paged them with `neurouter_read_result`.
- The same overlay was checked live against `https://api.github.com` (read-only token, writes disabled):
  `repos_get`, `issues_list_for_repo`, `pulls_list`, `repos_list_commits`, `search_issues_and_pull_requests`
  and one `run_script` all returned shaped results.
