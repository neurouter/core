# Stripe: raw spec vs agent-ready overlay

Measured on 2026-11-26 with **Neurouter 0.2.1 as released** (`npx -y neurouter@0.2.1`) and Stripe's full OpenAPI
description (`spec3.json`, API `2026-09-30.endive`, 612 tools). 0.2.1 is the first release that compiles it
(13.4 s, 0.97 GB peak memory). All runs use the same frozen 20-task suite (`eval-suite.json`: 8 single, 6 multi-step,
3 ambiguous, 3 impossible) against Neurouter's mock environment, not the real API. Model: `gpt-6-luna`, 3 repeats
per task and mode.

| State | Mode | Score | Success | single / multi / ambig / imposs. | Tokens / attempt (cached) | Tokens / multi-step task | Calls |
|---|---|---|---|---|---|---|---|
| Raw spec (612 tools, search discovery) | tool | **58** (Needs work) | 40% | 25 / 44 / 33 / 78% | 34,158 (25,517) | 22,006 | 3.90 |
| `agent-ready.overlay.yaml` (39 tools, listed directly) | tool | **77** (Ready) | 62% | 38 / 72 / 67 / 100% | 72,335 (68,829) | 76,066 | 1.77 |
| `agent-ready.overlay.yaml` (39 tools) | code | 66 (Needs work) | 45% | 29 / 33 / 67 / 89% | 12,999 (7,583) | 15,810 | 1.23 |

Recommended mode for gpt-6-luna: **tool** ("+39 pts success, +381% tokens on multi-step tasks"). Lint: 63 raw, 88 with
the overlay. Tokens are 0.2.1's figure: uncached input + cached input + output.

**The trade-off is real.** With 39 visible tools (under the 40-tool threshold), tool mode lists every tool directly.
Stripe's input schemas are large, so that `tools/list` is 94.7 KB and is sent on every turn: success went up by
22 points, but tokens per multi-step task more than tripled (most of it cached input). Code mode keeps the list
small (`search_tools` + `run_script`) at 15,810 tokens per multi-step task, with less success on this suite.

## Files

- `agent-ready.overlay.yaml`: the overlay. Every entry is tagged `[auto]` (from `neurouter eval --suggest` on the
  BEFORE run), `[manual]` (a read-mostly payments and billing support scope chosen without the suite), or
  `[manual, suite-informed]`. Tool names stay raw (`get_customers`, `get_invoices_invoice`, …).
- `eval-suite.json`: the frozen suite, generated on 0.2.1 from the full raw spec
  (`--counts 8,6,3,3 --max-generator-tokens 300000`: 5 generator calls, 242,970 tokens).

## What the overlay does

1. Hides 573 of 612 tools (`defaults: hidden: true`).
2. Shows 21 reads for payments and billing support (balance and balance transactions, customers, products, prices,
   invoices, payment intents, charges, refunds, subscriptions) and 2 writes on purpose (`post_refunds`, marked
   destructive, and `post_customers_customer`). These were chosen without the suite.
3. Shows 16 more tools **because the suite uses them** (events, coupons, credit notes, payment links, top-ups, charge
   refunds, Terminal configurations, Issuing tokens, Financial Connections).
4. Shapes 20 list responses (`data[].…` fields, `has_more`, `maxItems: 20`) and caps single-object reads at 8 KB.
5. Applies all 16 `--suggest` entries: 9 descriptions, 5 response caps (2 adapted), 3 examples. The three examples copy
   the suite's task values (`card: EiZtvv`, `charge: demo`, `limit: 1`); the file marks them.

## Reproduce

Needs `OPENAI_API_KEY`.

```sh
curl -fsSLo stripe.json https://raw.githubusercontent.com/stripe/openapi/a8f2a259ab96578fa3475562e91614d420283530/openapi/spec3.json
# before (raw spec)
npx -y neurouter@0.2.1 eval --spec stripe.json --suite eval-suite.json --modes tool --models gpt-6-luna --repeats 3 --out before.json --md before.md --suggest
# after (overlay, both modes)
npx -y neurouter@0.2.1 eval --spec stripe.json --overlay agent-ready.overlay.yaml --suite eval-suite.json --modes tool,code --models gpt-6-luna --repeats 3 --out after.json --md after.md
```

Measured cost on 0.2.1: about 2.0M tokens for BEFORE and 5.1M for AFTER (4.3M of it in tool mode; 90% of AFTER was cached input).
LLM results vary between runs; expect a few points of spread.

## Caveats

- **Mock environment.** Responses are generated from the spec: amounts like 11 or 92, currencies like `U4wnGR`, and
  filters are not applied (`amount.gte`, `is_account_default` return everything).
- **Some tasks can't pass in 0.2.1, whatever the agent does** (5 of 17 scored tasks): `retrieve_coupon` and
  `retrieve_payment_link` (`answer_contains` wants the literal `false`; agents write "not valid" / "inactive"),
  `list_active_issuing_tokens` (the `card` argument is recorded as redacted, and the assertion wants `mastercard` /
  `apple_pay` in lower case), `list_nondefault_terminal_config` (expects the id `configuration_2`, which the mock
  doesn't return at run time), and `high_value_topups_cutoff` (says "use your best judgment" but requires
  `amount.gte: 50`).
- **Suite-informed overlay.** 16 of 39 visible tools are there because the suite uses them, some shaped fields match
  what tasks ask for, and every `[auto]` edit comes from suite failures. Read the AFTER numbers as "this overlay on
  this suite", not a general claim.
- **No model matrix** on 0.2.1 yet (claude-sonnet-5-5, gemini-3.5-flash-lite).
- The same overlay was checked live against Stripe **test mode** (`livemode: false`, writes disabled) with
  `npx neurouter@0.2.1 serve`: `get_balance`, `get_customers_search` (`metadata['seed']:'neurouter-demo'`),
  `get_products`, `get_payment_intents`, `get_invoices` and one `run_script` (3 inner calls) all returned shaped
  results. No write endpoint was called.
