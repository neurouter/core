/** Meta-tools and ops tools (backend §9.5, §11). All satisfy ^[a-zA-Z0-9_-]{1,64}$. */
export const SEARCH_TOOLS = 'search_tools';
export const CALL_TOOL = 'call_tool';
export const RUN_SCRIPT = 'run_script';
export const META_TOOL_NAMES = [SEARCH_TOOLS, CALL_TOOL, RUN_SCRIPT] as const;

export const OPS_PREFIX = 'neurouter_';
/** The 8 toggleable MVP ops tools (OpsToolToggles keys). */
export const OPS_TOOLS = ['begin_task', 'end_task', 'log_decision', 'report_unmet_need', 'report_issue', 'explain_error', 'get_examples', 'whoami'] as const;
export type OpsTool = (typeof OPS_TOOLS)[number];
/** Always available (not toggleable): paging through truncated results. */
export const READ_RESULT = 'read_result';
export type OpsToolToggles = Record<OpsTool, boolean>;
export const DEFAULT_OPS_TOGGLES: OpsToolToggles = Object.fromEntries(OPS_TOOLS.map((t) => [t, true])) as OpsToolToggles;

export const OPS_VISIBILITY: Record<OpsTool | typeof READ_RESULT, 'pinned' | 'search' | 'hint'> = {
  begin_task: 'pinned',
  end_task: 'pinned',
  report_unmet_need: 'pinned',
  log_decision: 'search',
  report_issue: 'search',
  explain_error: 'search',
  get_examples: 'search',
  whoami: 'search',
  read_result: 'hint',
};

export function opsMcpName(tool: string): string {
  return `${OPS_PREFIX}${tool}`;
}

/** MCP tool name rule for every exposed tool. */
export const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** API tool name rule (compiler output, §8.1). */
export const API_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
