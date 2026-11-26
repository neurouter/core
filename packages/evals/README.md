# @neurouter/evals

Agent-readiness evals for Neurouter: suite generation, the agent runner (tool and code mode, OpenAI /
Anthropic / Gemini or the deterministic stub), the checker, the LLM judge, scoring, and fix suggestions.
`npx neurouter eval` and the console use it; this file documents what a score measures.

Since 0.2.2 the harness measures the agent, not itself: expected values come from the API's own
behaviour at run time, arguments the prompt does not ask for are never pinned, answers are compared by
meaning, call budgets count efficiency instead of failing tasks, and a suite is only accepted when each
task's own reference solution passes its checks.

## Tasks and checks

A task has a prompt, a rubric, **reference calls** (a correct path through the API) and assertions.

| Assertion | Passes when |
|---|---|
| `called {tool, args?, anyOf?, minTimes?}` | The tool, or an equivalent one in `anyOf`, was called successfully with the **required** arguments. |
| `not_called {tool}` | The tool was not called. |
| `no_writes` | No write took effect (dry runs and blocked writes are not writes). |
| `max_calls {n, hard?}` | Call budget, see [Call budgets](#call-budgets). |
| `state {resource, where, expect}` | The mock's data afterwards matches. |
| `answer_contains {from \| anyOf, match?, kind?}` | The final answer states the expected value(s), see [Answer matching](#answer-matching). |
| `answer_matches {regex}` | The final answer matches the regex. |
| `unmet_need_reported_or_declined` | The agent reported an unmet need, or declined without writing. |
| `framing` | Contract 1: `neurouter_begin_task` first, `end_task` last. Scored separately; **n/a** on contract 2 (no framing tools), where the component is left out and the weights renormalize. |
| `judge {criterion, groundTruth?, kind?}` | The LLM judge's verdict (score ≥ 0.7). `groundTruth`: the judge also gets the task's expected values. `kind: choice`: see below. |

Calls are read from Neurouter's audit log (including calls inside `run_script`), so tool mode and code
mode are checked the same way. The audit log stores arguments redacted (`secret_name`, `card`, …); the
checker reads the **clear** arguments from an in-memory, eval-only copy kept for the attempt's eval key
and dropped when the attempt ends. The audit log itself stays redacted.

### Ground truth

Expected values are computed at run time: the task's reference calls run against a fresh mock namespace
with the **same seed and data version** as the agent's, through the same MCP pipeline (shaping, contract).
Assertions name values of that outcome by path instead of freezing literals:

```json
{ "type": "answer_contains", "from": "ref[1].data.status", "anyOf": ["succeeded"] }
{ "type": "answer_contains", "from": "ref[0].data.data[*].id" }
{ "type": "called", "tool": "get_refund", "args": { "refund": { "$from": "ref[0].data.data[0].id" } } }
```

`ref[i].data` is the tool's result value (the contract-2 envelope's `data`, or the contract-1 body with
its `{"items": …}` array wrapper removed, so paths are the same on both contracts). `[*]` expands every
element; a path with `[*]` needs every value (`match: all`), otherwise one is enough. `anyOf` next to
`from` is only a hint (reports, and the fallback when no ground truth is available). When an agent used
an equivalent tool (`anyOf` / reference `alternatives`), that tool's outcome is the ground truth.

### Required and incidental arguments

The generator marks which arguments the **prompt** requires (`required_args` on each reference call).
`called.args` holds only those; everything the generator chose itself (page sizes, limits, cursors,
`expand`, sort direction defaults) is recorded as `incidental` and never compared. Paging arguments are
never compared even when a suite pins them. Matching is a subset match with normalized types: strings
case- and space-insensitive (`Hello-World` = `hello-world`), numbers and numeric strings by value,
booleans and `"true"`, arrays as sets.

Equivalent endpoints are accepted: the generator lists `alternatives`, and GET operations whose paths
end in the same two literal segments under the same path parameters (the four "repository public key"
endpoints) are added automatically.

"Use your judgment" tasks (an ambiguous prompt that leaves a cutoff or interpretation to the agent)
never pin a value: they get `judge {kind: "choice"}`, which passes when the answer states the choice it
made and the reported results are consistent with that choice and with the tool results the agent saw.

### Answer matching

1. **Literal**: the value appears as is, not glued to other letters or digits (`topup_1` is not in `topup_12`).
2. **Normalized**, by kind (inferred from the value and its field, or `kind`):
   - text and ids: case, whitespace, punctuation, `_`/`-` as spaces, diacritics (`apple_pay` = "Apple Pay");
     long values (templates, bodies) by token recall ≥ 80%;
   - booleans by meaning and field: `valid: false` = "not valid" / "invalid", `active: false` = "inactive";
   - numbers: thousand separators, decimals, `k`/`M`; money in minor units also in major units when the
     value sits next to a `currency` (1250 = "12.50");
   - dates and times: ISO, natural language ("September 23, 2025 at 05:04 UTC"), unix seconds, explicit
     offsets; a date without a time matches the UTC date.
3. **Judge**: when normalized matching fails, one equivalence-judge call per attempt gets the expected
   values and the answer; if it rules them stated, the check passes with `matchedBy: "judge"`.

`normalize: false` (or the legacy `caseInsensitive`) keeps a check literal.

## Call budgets

Budgets are efficiency, not correctness.

- **Derived** from the reference path: `max(3, ceil(2 × reference calls) + 2 × paginated reference calls)`
  (a call is paginated when its tool has a page/limit/cursor parameter). Generated budgets are ignored.
- **Counted**: upstream API calls only. Calls inside `run_script` count; `search_tools`, `run_script`
  itself, ops tools (`neurouter_*`, including `read_result` and begin/end task) and calls rejected
  before the upstream (`invalid_args`) do not.
- **Soft**: an attempt over its budget still passes and is reported as over budget
  (`overBudget`, `AssertionResult.overBudget`, "N passed over budget"). Beyond `max(10, 4 × n)` calls it
  fails as `over_budget` (a runaway loop).
- **Hard**: `n: 0` ("answer without calling the API", clarification tasks) and `hard: true` fail at `n + 1`.

## Calibration gate

Before a suite is accepted (generation, `eval --suite`), each task's reference solution runs through its
own assertions in the mock: the reference calls must succeed, every `from` path must resolve, literal
answer values must occur in the reference outcome, and every deterministic assertion must pass on the
reference path (judge assertions are not run). A task that fails is **rejected** with the reasons:
generation regenerates it (one round), `eval --suite` disables it for the run, and it is never scored.

`--calibrate-with <model>` adds one tool-mode pass with that model and **flags** tasks whose results
disagree with the ground truth for human review (flagged tasks stay in the suite). The calibration result
is stored with the suite (`calibration` in the suite file and the console's suite record).

## Mock data

The mock is deterministic per namespace seed and **data version**:

- filters: equality (comma lists, enums, booleans), range objects (`amount[gte]=50`, `created[lt]=…`);
- sorting: `sort` / `direction` / `order` (dates descending by default);
- pagination: `page`/`per_page`, `limit`/`offset`, cursors, Stripe `starting_after`/`ending_before` with
  `has_more`, page-size defaults and maxima from the spec;
- stable ids: item ids resolve through `$ref`/`allOf` item schemas, and from data version 2 a nested
  collection of a top-level resource's objects (`/v1/charges/{charge}/refunds`) shares that resource's
  objects (`refund_1` is the same refund in both).
- **Data version 2** (0.2.2 default): realistic values by field semantics (person and repository names,
  labels, product and company names, ISO currencies, minor-unit amounts, English titles and
  descriptions, addresses), timestamps that decrease with the item index (newest first).
- **Data version 1**: the 0.2.1 values, kept unchanged for suites frozen on 0.2.1 (their prompts name
  those values). Version-1 suite files (and suites stored before 0.2.2) run on data version 1.

## Topic balance

For large APIs the generator samples one topic (tag/resource cluster) per task, weighted by importance:
√(operations in the cluster) × 2 when the overlay pins one of its tools × 1.5 for common resources
(issues, pull requests, customers, payments, invoices, …). Topics are distinct while they last, then
capped at ⌈count/topics⌉ + 1 each. Near-duplicate tasks (the same reference path and required arguments,
or prompt token Jaccard ≥ 0.75) are rejected. The report lists coverage by tag.

## Score

Each (model, mode) cell; weights renormalize when a component is missing.

| Component | Weight | Definition |
|---|---:|---|
| Task success | 45% | Mean pass rate of single, multi-step and ambiguous tasks. Over-budget passes count. |
| Tool quality | 20% | Spec lint score. |
| Impossible-task handling | 10% | Mean pass rate of impossible tasks. |
| Efficiency | 10% | Mean over passed attempts of `min(1, (reference calls + 1) / (upstream calls + 1))`. |
| Stability | 10% | 1 − flaky tasks / measured tasks. |
| Framing | 5% | Contract 1 only (n/a on contract 2). |
| API correctness | 10% | Reserved. |

Excluded from scoring and counted separately: attempts served by a fallback model, and **provider
refusals** (`failureCause: provider_refusal`: the model provider's policy filter refused the prompt).

**Recommended mode**: the higher cell (within 3 points, tool mode unless code mode is ≥ 10 points better on
multi-step tasks), then a cost rule: if the pick needs ≥ 2× the other mode's tokens per multi-step task
while the other mode's success is within 10 points, the cheaper mode is recommended. Tool mode's cost
grows with the size of `tools/list` (resent with every turn: bytes × turns), not the number of tools; the
report shows the mean `tools/list` size per cell.

## Spend

- `--max-generator-tokens`: budget for suite generation (default 400,000).
- `--max-run-tokens`: hard cap for the run (agent and judge tokens). No new attempt starts once it is
  reached (attempts in flight finish); the run is marked incomplete and its scores cover the attempts
  that ran.
- Judge usage (rubric and equivalence judge) is counted per attempt and reported per judge model.
- Suggestions name the suite's task keys.

## Suite files and migration

`--save-suite` writes version 2 files (`mockDataVersion`, `calibration`, `coverage`). Version-1 files load
as data version 1. `neurouter eval --spec <spec> --migrate-suite old.json --save-suite new.json` converts
a 0.2.1 suite: required-only `called.args` (paging and judgment-task values become `incidental`),
derived soft budgets, equivalent tools, `$from` for arguments taken from earlier results, literal answer
values bound to ground-truth paths (ranked by the fields the prompt names), choice judges for "use your
judgment" tasks, ground truth for judges whose criteria name values. It records per-task notes in
`migration.notes` and runs the calibration gate.

`neurouter eval --spec <spec> --suite suite.json --regrade transcripts.json [--judge-model m] [--max-judge-tokens n]`
re-scores the attempts of an `--transcripts` file with the current grader, without running agents. It
reuses the recorded rubric verdicts (re-judging only new `choice` criteria and failed verdicts of criteria
that now get the ground truth), recovers redacted arguments from the agent's own tool-mode calls, and
caps judge tokens (default 300,000).
