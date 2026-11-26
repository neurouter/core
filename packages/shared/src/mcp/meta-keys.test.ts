import { describe, expect, it } from 'vitest';
import * as keys from './meta-keys.js';
import { DEFAULT_OPS_TOGGLES, MCP_TOOL_NAME_RE, META_TOOL_NAMES, OPS_TOOLS, OPS_VISIBILITY, READ_RESULT, opsMcpName } from './tool-names.js';

describe('MCP _meta keys and tool names', () => {
  it('Neurouter _meta keys share the dev.neurouter/ prefix and are unique', () => {
    const values = Object.entries(keys).filter(([k, v]) => k.startsWith('META_') && typeof v === 'string' && k !== 'META_PREFIX').map(([, v]) => v as string);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) if (v !== 'traceparent' && v !== 'tracestate') expect(v.startsWith(keys.META_PREFIX), v).toBe(true);
  });
  it('eval headers are lower-case', () => {
    expect(keys.HEADER_MOCK_STATE).toBe(keys.HEADER_MOCK_STATE.toLowerCase());
    expect(keys.HEADER_EXPOSURE).toBe(keys.HEADER_EXPOSURE.toLowerCase());
  });
  it('every meta and ops tool name satisfies the MCP name rule', () => {
    for (const n of [...META_TOOL_NAMES, ...OPS_TOOLS.map(opsMcpName), opsMcpName(READ_RESULT)]) expect(MCP_TOOL_NAME_RE.test(n), n).toBe(true);
    expect(opsMcpName('begin_task')).toBe('neurouter_begin_task');
  });
  it('ops toggles default on; visibility covers every tool', () => {
    expect(Object.values(DEFAULT_OPS_TOGGLES).every(Boolean)).toBe(true);
    expect(Object.keys(OPS_VISIBILITY).sort()).toEqual([...OPS_TOOLS, READ_RESULT].sort());
  });
});
