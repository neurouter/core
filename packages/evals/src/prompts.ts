/**
 * Versioned prompts. Generator and judge prompts carry a machine-readable marker plus a JSON input
 * block, so the deterministic stub provider reads exactly what a real model reads.
 */
export const GENERATOR_PROMPT_VERSION = 'gen-3';
export const AGENT_PROMPT_VERSION = 'agent-1';
export const JUDGE_PROMPT_VERSION = 'judge-3';
export const DECLINE_PROMPT_VERSION = 'decline-1';
export const EQUIV_PROMPT_VERSION = 'equiv-1';
export const SUGGEST_PROMPT_VERSION = 'suggest-1';

export const GENERATOR_MARKER = '<<NEUROUTER_GENERATOR';
export const JUDGE_MARKER = '<<NEUROUTER_JUDGE';
export const EQUIV_MARKER = '<<NEUROUTER_EQUIV';
export const DECLINE_MARKER = '<<NEUROUTER_DECLINE';
export const SUGGEST_MARKER = '<<NEUROUTER_SUGGEST';

export function markerMessage(marker: string, version: string, input: unknown, instructions: string): string {
  return `${marker} ${version}>>\n${instructions}\n<input>\n${JSON.stringify(input)}\n</input>`;
}

export function readMarkerInput(text: string, marker: string): unknown | null {
  if (!text.includes(marker)) return null;
  const m = /<input>\n?([\s\S]*?)\n?<\/input>/.exec(text);
  return m?.[1] ? JSON.parse(m[1]) : null;
}

export const GENERATOR_SYSTEM = `You write evaluation tasks that measure how well an AI agent can use an API through MCP tools.
Each task is a realistic user request. Tasks must be answerable with the listed tools (except category "impossible").
Use the tools in "tools" (they have full schemas) for called assertions and reference_calls. "otherTools", when present, only
names further tools of the API: they exist, so do not write "impossible" tasks that one of them could solve.
Reference ids and values that exist in the provided sample entities so the tasks can be checked against the mock API.
When "topics" is given, write task i about topics[i] (an area of the API); never write two tasks that differ only in wording
(see "existingPrompts"). Return JSON only, matching the schema. Categories:
- single: one tool call solves it.
- multi: needs 2-4 calls, the later ones using results of earlier ones.
- ambiguous: the request is underspecified; a good agent asks a clarifying question or makes a reasonable, stated choice.
- impossible: no tool can do it; a good agent says so and calls neurouter_report_unmet_need, and never writes.
Checks are outcome-based: expected values are computed at run time by executing your reference_calls on the same mock data.
- reference_calls[]: {tool, arguments, required_args, alternatives?}. required_args lists ONLY the argument names the PROMPT
  states or clearly implies (ids, names, filters the user asked for). Page size, limits, cursors, sort direction defaults and
  other arguments you chose yourself are incidental: leave them out of required_args. alternatives: other listed tools that
  would answer the request equally well (e.g. several "get public key" endpoints).
- called {tool, args}: args = the required arguments only. Never pin a value the prompt leaves to the agent.
- answer_contains {anyOf: [value]}: a value from the reference result the answer must state (an id, a name, a status). You
  may instead give {from: "ref[<i>].data.<path>"} (e.g. "ref[0].data.name", "ref[0].data.data[*].id" for each listed id).
- For an ambiguous task that says "use your judgment": no called args and no answer values; add
  judge {kind: "choice", criterion: "states the chosen <cutoff/interpretation> and the results are consistent with it"}.
- Do not write max_calls; budgets are derived from reference_calls.
Assertions use this DSL: called {tool,args?,minTimes?}, not_called {tool}, no_writes, state {resource,scope?,where,expect},
answer_contains {anyOf|from}, answer_matches {regex}, unmet_need_reported_or_declined, framing, judge {criterion, kind?}.
For impossible tasks include unmet_need_reported_or_declined and no called assertions.`;

export function agentSystemPrompt(instructions: string | null): string {
  const base = `You are a helpful assistant that completes the user's request by using the available tools. Be efficient: call only the tools you need. When you are done, answer the user concisely and include the key values you found.`;
  return instructions ? `${base}\n\nThe tool server says:\n${instructions}` : base;
}

export const JUDGE_SYSTEM = `You grade whether an AI agent's work satisfies a rubric. Be strict and concise. "results" holds the tool results the agent saw (cut only when very long): a fact in the answer that appears there is supported. When "groundTruth" is given, it holds the API's actual results for this task: judge facts against it, and accept equivalent forms (Yes/true, "September 23, 2025"/2025-09-23T…, "$12.50"/1250 cents, "Apple Pay"/apple_pay). Return JSON only: {"score": 0..1, "verdict": "pass"|"fail", "reasons": [up to 3 short strings]}. Verdict pass requires score >= 0.7.`;

/** Appended to `judge {kind: "choice"}` criteria (ambiguous "use your judgment" tasks). */
export const JUDGE_CHOICE_RUBRIC = `This is a judgment call: any reasonable choice passes. Pass when the answer states the choice it made (e.g. the cutoff or interpretation) and the results it reports are consistent with that choice and with the tool results in "results". Fail when no choice is stated, the results contradict the stated choice, or values are invented.`;

/**
 * Appended to the rubric criteria of ambiguous tasks (not `kind: choice`). Both ways of handling an underspecified
 * request pass; the rubric says what the ambiguity is. Writes are checked deterministically (no_writes).
 */
export const JUDGE_AMBIGUOUS_RUBRIC = `This request is ambiguous; the rubric names the ambiguity. Two ways pass: (a) the agent asks a clarifying question about that ambiguity (it may look things up first, and may ask about more than one point); or (b) the agent states an explicit assumption, a reasonable reading of the ambiguous part, and what it reports or does is consistent with that assumption. Fail when it neither asks nor states its assumption (it silently picks a reading), asks only about something the request already says, or changes data without asking. Set "path": "asked", "assumed" or "neither".`;

export const DECLINE_SYSTEM = `You check how an AI agent answered a request that the available API cannot fulfil. "declined" is true when the answer declines or explains that the request cannot be done (the API does not expose it, it is not retrievable, not supported, the agent cannot provide it), possibly offering alternatives, and does not claim to have done it or invent the requested value. Return JSON only: {"declined": true|false, "reason": "<short>"}.`;

export const EQUIV_SYSTEM = `You check whether an answer states expected values. Each item has the expected value(s) from the API and the field they come from. An item is equivalent when the answer states the same fact in another form: casing, spacing, booleans in words (false = "not valid"/"inactive"/"no"), numbers with separators or in major units for minor-unit amounts (1250 = "12.50"), dates in words or another time zone for the same instant, names or ids with different punctuation. With several expected values, all must be stated unless they are alternatives. Not equivalent: a different value, a vaguer statement, or the value missing. Return JSON only: {"items": [{"index", "equivalent", "reason"}]}.`;

export const SUGGEST_SYSTEM = `You improve MCP tool definitions so AI agents pick the right tool and pass correct arguments. Return JSON only, matching the schema. Descriptions start with a verb, are specific, at most 600 characters, and contrast confusable tools.`;
