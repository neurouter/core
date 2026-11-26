# GitHub REST: raw spec vs agent-ready overlay

Measured on 2026-11-26 with **Neurouter 0.2.1 as released** (`npx -y neurouter@0.2.1`) and the full GitHub REST
description (1281 tools). All runs use the same frozen 20-task suite (`eval-suite-0.2.1.json`: 8 single,
6 multi-step, 3 ambiguous, 3 impossible) against Neurouter's mock environment, not the real API. Model: `gpt-6-luna`,
3 repeats per task and mode.

| State | Mode | Score | Success | single / multi / ambig / imposs. | Tokens / attempt (cached) | Tokens / multi-step task | Calls |
|---|---|---|---|---|---|---|---|
| Raw spec (1281 tools, search discovery) | tool | **56** (Needs work) | 33% | 50 / 17 / 11 / 44% | 54,744 (38,916) | 84,559 | 3.25 |
| `agent-ready.overlay.yaml` (67 tools, search discovery) | tool | 61 (Needs work) | 38% | 50 / 28 / 0 / 67% | 31,740 (25,633) | 51,098 | 1.75 |
| `agent-ready.overlay.yaml` (67 tools) | code | **64** (Needs work) | 43% | 50 / 39 / 0 / 78% | 15,897 (10,422) | **15,073** | 1.57 |

Recommended mode for gpt-6-luna: **code** ("+11 pts success, −71% tokens on multi-step tasks"). Lint: 66 raw, 81 with
the overlay. Tokens are 0.2.1's figure: uncached input + cached input + output. The model matrix
(claude-sonnet-5-5, gemini-3.5-flash-lite) was not re-run on 0.2.1.

## Files

- `agent-ready.overlay.yaml`: the overlay. Every entry is tagged `[auto]` (from `neurouter eval --suggest` on the
  0.2.1 BEFORE run), `[auto-0.2.0]` / `[curated]` (carried over from the 0.2.0 demo and `curated.overlay.yaml`),
  `[manual]`, or `[manual, suite-informed]`. Tool names stay raw; 0.2.1 resolves eval assertions by stable key
  (operationId), so renames would also work.
- `eval-suite-0.2.1.json`: the frozen suite for the numbers above, generated on 0.2.1 from the full raw spec
  (`--counts 8,6,3,3 --max-generator-tokens 300000`: 5 generator calls, 213,901 tokens).
- `eval-suite.json`, `generation-scope.overlay.yaml`: the 0.2.0 demo's suite and the 122-tool slice it was generated
  from (kept: the suite is also a test fixture). See "Earlier run".
- `curated.overlay.yaml`: the earlier hand-written overlay (renames tools; not used for these numbers).

## What the overlay does

1. Keeps the 40 curated tools (issues, comments, labels, milestones, pull requests, branches, commits, search) with
   their response shaping and descriptions, and hides everything else (`defaults: hidden: true`).
2. **Shows 27 more tools because the new suite needs them** (SSH signing keys, Codespaces, gitignore templates,
   Marketplace plans, app installations, OIDC, billing, repository public keys, org immutable-release settings,
   packages). Each area is shown as a family with siblings and look-alikes, not just the one tool a task calls.
   This is suite-informed curation; it says so in the file.
3. Applies 10 of 13 `--suggest` entries (descriptions, response caps, two examples) and rejects 3 that target tools
   the overlay keeps hidden.

## Reproduce

Needs `OPENAI_API_KEY`.

```sh
curl -fsSLo github.yaml https://raw.githubusercontent.com/github/rest-api-description/36dd877176930e2f62cba7f678b818a7af1dad65/descriptions/api.github.com/api.github.com.yaml
# before (raw spec)
npx -y neurouter@0.2.1 eval --spec github.yaml --suite eval-suite-0.2.1.json --modes tool --models gpt-6-luna --repeats 3 --out before.json --md before.md --suggest
# after (overlay, both modes)
npx -y neurouter@0.2.1 eval --spec github.yaml --overlay agent-ready.overlay.yaml --suite eval-suite-0.2.1.json --modes tool,code --models gpt-6-luna --repeats 3 --out after.json --md after.md
# generate a fresh suite instead (it also runs it once)
npx -y neurouter@0.2.1 eval --spec github.yaml --generate --counts 8,6,3,3 --max-generator-tokens 300000 --save-suite my-suite.json --modes tool --repeats 1
```

Measured cost on 0.2.1: about 3.3M tokens for the BEFORE run and 2.9M for AFTER (73% of both was cached input). LLM results
vary between runs; expect a few points of spread.

## Caveats

- **Mock environment.** Responses are generated from the spec.
- **Some tasks can't pass in 0.2.1, whatever the agent does** (4 of 17 scored tasks):
  `get_codespaces_repo_secret` and `github_multi_codespaces_secret` (the `secret_name` argument is recorded as
  redacted, so the `called` assertion never matches), `get_authenticated_user_ssh_signing_key` (`answer_contains` wants
  the literal ISO timestamp; agents write the date in words), and `list_octocat_repositories` (the assertion requires
  `per_page: 10`, which the prompt never asks for).
- **Generated budgets.** `list_accounts_for_plan_1313` and several multi-step tasks fail only on `max_calls`, because
  agents page through mock lists.
- **Ambiguous tasks** (0 of 9 after the overlay) are real agent misses: agents act instead of asking.
- **Suite-informed overlay.** 27 of 67 visible tools are there because the suite uses them, and every `[auto]` edit
  comes from suite failures. Read the AFTER numbers as "this overlay on this suite", not a general claim.
- The same overlay was checked live against `https://api.github.com` (read-only token, writes disabled) with
  `npx neurouter@0.2.1 serve`: `repos_get`, `repos_list_for_user`, `issues_get_label`, `gitignore_get_template`,
  `search_issues_and_pull_requests` and one `run_script` (3 inner calls) all returned shaped results.

## Earlier run (0.2.0, different suite and overlay)

The first demo (0.1.1 plus fixes, released as 0.2.0) used `eval-suite.json` and the 40-tool version of the overlay
(this file at commit `ffdd67b`): raw 46 (15% success, 34,370 tokens per multi-step task) → overlay 70 in tool and code
mode (57%, 2,712 / 8,171). Those token figures leave out cached input, and the suite was generated from a 122-tool
slice, so they are not comparable with the table above.
