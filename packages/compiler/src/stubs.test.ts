import { describe, expect, it } from 'vitest';
import type { ToolDef } from '@neurouter/shared';
import { finalize } from './compile.js';
import { generateOpsStub, generateStubs, pyArgMap } from './stubs.js';
import { compileFile, compileText, NOTES_SPEC, PETSTORE, spec31 } from './test/fixtures.js';

describe('python stubs', () => {
  it('matches the Petstore snapshot', async () => {
    const r = await compileFile(PETSTORE, undefined, 'petstore');
    expect(r.pythonStubs.petstore).toMatchSnapshot();
  });

  it('renders keyword-only args, defaults, Literal enums, TypedDicts and docstrings', async () => {
    const r = await compileText(NOTES_SPEC, 'overlay: 1\ntools:\n  "operationId:listNotes": { response: { maxItems: 5 } }\n', 'notes');
    const pyi = r.pythonStubs.notes!;
    expect(pyi).toMatch(/^# notes\.pyi {2}\(generated; Neurouter compiler 0\.1\.0; build [0-9a-f]{12}\)\n# Built-ins: len, range, .*isinstance, type, iter, next.*\n# Inside run_script, tool results are whole values .*\nfrom typing import Any, Literal, NotRequired, TypedDict\n/);
    expect(pyi).toContain('class Note(TypedDict):\n    id: int\n    title: str\n    body: NotRequired[str]\n    state: NotRequired[Literal["open", "closed"]]');
    expect(pyi).toContain('def list_notes(*, project: str, state: Literal["open", "closed"] | None = None, per_page: int = 30, page: int = 1) -> list[Note]:');
    expect(pyi).toContain('    """List notes in a project\n\n    Args:\n        project (required): Project key\n        state: Filter by state\n        per_page: Page size\n        page: Page number\n\n    Read-only."""');
    expect(pyi).toContain('def create_note(*, project: str, title: str, body: str | None = None, state: Literal["open", "closed"] | None = None) -> dict[str, Any]:');
    expect(pyi).toContain('WRITE: in dry_run mode returns a planned change instead of calling the API.');
  });

  it('escapes Python keywords and exposes the arg map', async () => {
    const r = await compileText(spec31({ '/x': { get: { operationId: 'getX', parameters: [{ name: 'from', in: 'query', schema: { type: 'string' } }, { name: 'class', in: 'query', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'ok' } } } } }));
    const t = r.tools[0]!;
    expect(t.pySignature).toBe('def get_x(*, class_: int, from_: str | None = None) -> Any');
    expect(pyArgMap(t)).toEqual({ from_: 'from', class_: 'class' });
  });

  it('skips hidden tools and caps TypedDicts', async () => {
    const mk = (i: number): ToolDef =>
      finalize(
        {
          name: `get_thing_${i}`,
          pyName: '',
          title: 't',
          description: 'Get a thing.',
          kind: 'http',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', title: `Thing${i}`, properties: { [`f${i}`]: { type: 'string' } } },
          binding: { type: 'http', method: 'GET', pathTemplate: '/', params: [], successStatuses: [200], responseContentType: null, security: [] },
          risk: { readOnly: true, destructive: false, idempotent: true, openWorld: true, write: false },
          tags: [],
          hidden: i === 0,
          pinned: false,
          deprecated: false,
          examples: [],
          pySignature: '',
          sourceRef: { pointer: '/' },
          overlayApplied: [],
          key: `k${i}`,
          defHash: '',
        },
        'ns',
      );
    const tools = Array.from({ length: 6 }, (_, i) => mk(i));
    const pyi = generateStubs(tools, 'ns', { maxTypedDicts: 3 });
    expect(pyi).not.toContain('def get_thing_0');
    expect((pyi.match(/^class /gm) ?? []).length).toBe(3);
    expect(pyi).toContain('def get_thing_5() -> dict[str, Any]');
  });

  it('generates the ops stub with helpers and enabled tools only', () => {
    const pyi = generateOpsStub(['begin_task', 'end_task', 'whoami']);
    expect(pyi).toContain('def parallel(calls: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:');
    expect(pyi).toContain('def days_since(iso: str) -> float:');
    expect(pyi).toContain('def now() -> str:');
    expect(pyi).toContain('def begin_task(*, goal: str) -> dict[str, Any]:');
    expect(pyi).not.toContain('report_issue');
  });
});
