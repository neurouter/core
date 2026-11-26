/**
 * Versioned prompts. Generator and judge prompts carry a machine-readable marker plus a JSON input
 * block, so the deterministic stub provider reads exactly what a real model reads.
 */
export const GENERATOR_PROMPT_VERSION = 'gen-1';
export const AGENT_PROMPT_VERSION = 'agent-1';
export const JUDGE_PROMPT_VERSION = 'judge-1';
export const SUGGEST_PROMPT_VERSION = 'suggest-1';

export const GENERATOR_MARKER = '<<NEUROUTER_GENERATOR';
export const JUDGE_MARKER = '<<NEUROUTER_JUDGE';
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
Reference ids and values that exist in the provided sample entities so the tasks can be checked against the mock API.
Return JSON only, matching the schema. Categories:
- single: one tool call solves it.
- multi: needs 2-4 calls, the later ones using results of earlier ones.
- ambiguous: the request is underspecified; a good agent asks a clarifying question or makes a reasonable, stated choice.
- impossible: no tool can do it; a good agent says so and calls neurouter_report_unmet_need, and never writes.
Assertions use this DSL: called {tool,args?,argsMatch?,minTimes?}, not_called {tool}, no_writes, max_calls {n},
state {resource,scope?,where,expect}, answer_contains {anyOf}, answer_matches {regex}, unmet_need_reported_or_declined, framing, judge {criterion}.
Always include a framing assertion. For impossible tasks include unmet_need_reported_or_declined and no called assertions.`;

export function agentSystemPrompt(instructions: string | null): string {
  const base = `You are a helpful assistant that completes the user's request by using the available tools. Be efficient: call only the tools you need. When you are done, answer the user concisely and include the key values you found.`;
  return instructions ? `${base}\n\nThe tool server says:\n${instructions}` : base;
}

export const JUDGE_SYSTEM = `You grade whether an AI agent's work satisfies a rubric. Be strict and concise. Return JSON only: {"score": 0..1, "verdict": "pass"|"fail", "reasons": [up to 3 short strings]}. Verdict pass requires score >= 0.7.`;

export const SUGGEST_SYSTEM = `You improve MCP tool definitions so AI agents pick the right tool and pass correct arguments. Return JSON only, matching the schema. Descriptions start with a verb, are specific, at most 600 characters, and contrast confusable tools.`;
