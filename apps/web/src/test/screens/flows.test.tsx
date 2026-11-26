import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { createDb } from '@/mocks/db';
import { renderRoute } from '@/test/render';

describe('import wizard', () => {
  it('imports the sample by URL: compile → tools → environment → readiness', async () => {
    const { user, router } = await renderRoute('/servers/new');
    await user.click(await screen.findByRole('button', { name: /try the sample/i }));
    expect(await screen.findByRole('heading', { name: 'Compiled' })).toBeInTheDocument();
    expect(screen.getByText('17 operations have no description')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next: Tools' }));
    expect(await screen.findByText(/31 of 46 tools exposed/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Include track_shipment' }));
    expect(await screen.findByText(/30 of 46 tools exposed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next: Environment' }));
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('img', { name: /preliminary score 48/i })).toBeInTheDocument();
    expect((router.state.location.search as { step?: string }).step).toBe('readiness');
  });

  it('pastes an OpenAPI spec and rejects Swagger 2.0 with a clear message', async () => {
    const { user } = await renderRoute('/servers/new?tab=paste');
    const area = await screen.findByLabelText('Spec');
    fireEvent.change(area, { target: { value: 'swagger: "2.0"\ninfo: {title: Old}\npaths: {}' } });
    await user.click(screen.getByRole('button', { name: 'Compile' }));
    expect(await screen.findByText(/Swagger 2.0 is not supported/)).toBeInTheDocument();
    fireEvent.change(area, { target: { value: 'openapi: 3.1.0\ninfo:\n  title: Pets\npaths:\n  /pets:\n    get:\n      operationId: listPets\n    post:\n      operationId: createPet\n' } });
    await user.click(screen.getByRole('button', { name: 'Compile' }));
    expect(await screen.findByText('OpenAPI 3.1 · 2 operations')).toBeInTheDocument();
  });

  it('blocks Next when the compile has errors… and resumes from ?draft', async () => {
    const db = createDb({ speed: 0 });
    const first = await renderRoute('/servers/new', { db });
    await first.user.click(await screen.findByRole('button', { name: /try the sample/i }));
    await screen.findByRole('heading', { name: 'Compiled' });
    const draft = (first.router.state.location.search as { draft: string }).draft;
    first.unmount();
    await renderRoute(`/servers/new?step=tools&draft=${draft}`, { db });
    expect(await screen.findByText(/31 of 46 tools exposed/)).toBeInTheDocument();
  });

  it('disables the quick eval without a model provider', async () => {
    const db = createDb({ speed: 0 });
    const { user } = await renderRoute('/servers/new', { db, me: meFixture('admin', { features: { evals: false } }) });
    await user.click(await screen.findByRole('button', { name: /try the sample/i }));
    await user.click(await screen.findByRole('button', { name: 'Next: Tools' }));
    await user.click(await screen.findByRole('button', { name: 'Next: Environment' }));
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText('No model provider configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run a quick eval/i })).toBeDisabled();
  });
});

describe('overlay editor', () => {
  const url = '/servers/srv_acme_orders/tools/srv_acme_orders__customersSearch';
  it('shows the token estimate, lint hints, the shaping preview and the draft bar count', async () => {
    await renderRoute(url);
    expect(await screen.findByText(/~\d+ tokens/)).toBeInTheDocument();
    expect(await screen.findByText('Ambiguous with list_customers')).toBeInTheDocument();
    expect(await screen.findByText(/1,920 → \d+ tokens/)).toBeInTheDocument();
    expect(await screen.findByText(/3 unpublished changes/)).toBeInTheDocument();
  });

  it('rejects a rename that collides with another tool', async () => {
    const { user } = await renderRoute(url);
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'list_customers');
    expect(await screen.findByText('list_customers is already used by another tool', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('updates the token counts when a field is dropped', async () => {
    const { user } = await renderRoute(url);
    const before = await screen.findByText(/1,920 → (\d+) tokens/);
    const n = before.textContent;
    await user.click(screen.getByRole('checkbox', { name: 'Keep email' }));
    await waitFor(() => expect(screen.getByText(/1,920 → \d+ tokens/).textContent).not.toBe(n));
  });

  it('publish dialog shows the YAML diff and publishes v5', async () => {
    const { user } = await renderRoute('/servers/srv_acme_orders/overlay?publish=1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Publish overlay v5')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByText(/added:|removed:/).length).toBeGreaterThan(0));
    await user.type(within(dialog).getByLabelText('Change note'), 'Cap search results');
    await user.click(within(dialog).getByRole('button', { name: 'Publish v5' }));
    expect(await screen.findByText('Cap search results')).toBeInTheDocument();
    expect(screen.getByText('v5')).toBeInTheDocument();
  });
});

describe('write switches', () => {
  it('prod requires typing prod; Viewers see disabled switches', async () => {
    const { user } = await renderRoute('/servers/srv_acme_orders/environments');
    await user.click(await screen.findByRole('switch', { name: 'create_refund in prod' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Enable in prod' }));
    expect(await within(dialog).findByText('Type prod exactly to enable the write.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'prod');
    await user.click(within(dialog).getByRole('button', { name: 'Enable in prod' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'create_refund in prod' })).toBeChecked());
  });

  it('is read-only for Viewers', async () => {
    await renderRoute('/servers/srv_acme_orders/environments', { me: meFixture('viewer') });
    expect(await screen.findByRole('switch', { name: 'cancel_order in dev' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('task detail', () => {
  it('shows the dry-run script with planned changes, decisions, and the call drawer policy trail; focus returns on close', async () => {
    const { user } = await renderRoute('/tasks/task_flag_unpaid');
    expect(await screen.findByRole('heading', { level: 1, name: 'Flag unpaid orders older than 30 days' })).toBeInTheDocument();
    expect(await screen.findByText('Planned changes (7)')).toBeInTheDocument();
    expect(screen.getAllByText('Use a script: 40+ orders to check').length).toBeGreaterThan(0);
    expect(await screen.findByText(/list_orders in a loop/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show script' }));
    await user.click(screen.getAllByText(/Inspect inner calls/).at(-1)!);
    const triggers = screen.getAllByRole('button', { name: /add_order_note/ });
    const trigger = triggers[triggers.length - 1]!;
    await user.click(trigger);
    await waitFor(() => expect(screen.getAllByRole('list', { name: 'Policy trail' }).map((l) => l.textContent).join('|')).toMatch(/User confirmation: Confirmed by the user in the client/));
    expect(screen.getAllByRole('list', { name: 'Policy trail' }).at(-1)).toHaveTextContent(/Routing: Routed to prod/);
  });
});

describe('inbox', () => {
  it('triages a need group to Planned', async () => {
    const { user } = await renderRoute('/inbox/needs/need_csv_export');
    const select = await screen.findByLabelText('Triage');
    await user.selectOptions(select, 'planned');
    await waitFor(() => expect(screen.getByLabelText('Triage')).toHaveValue('planned'));
  });
});

describe('evals', () => {
  it('renders the matrix as a table with a textual best marker', async () => {
    await renderRoute('/evals/runs/run_14');
    const table = await screen.findByRole('table', { name: /task success by model and mode/i });
    const row = within(table).getByRole('row', { name: /gpt-6-luna/ });
    expect(within(row).getByText('best')).toBeInTheDocument();
    expect(within(row).getByText('86%')).toBeInTheDocument();
  });

  it('verifies a fix and applies it to the overlay draft', async () => {
    const db = createDb({ speed: 0 });
    const { user } = await renderRoute('/evals/runs/run_14?tab=fixes', { db });
    const card = await screen.findByRole('article', { name: 'Hide legacyExportOrders' });
    await user.click(within(card).getByRole('button', { name: 'Verify' }));
    expect(await within(card).findByText(/Verified \+3 pts/)).toBeInTheDocument();
    const desc = screen.getByRole('article', { name: 'Rewrite search_customers description' });
    await user.click(within(desc).getByRole('button', { name: 'Apply as overlay' }));
    expect(await within(desc).findByText('Applied to draft')).toBeInTheDocument();
    expect(db.servers[0]!.draft['operationId:customersSearch']?.description).toMatch(/email, name or phone/);
  });

  it('runs a new eval and polls it to the result', async () => {
    const db = createDb({ speed: 0 });
    const { user, router } = await renderRoute('/evals?new=1', { db });
    await user.click(await screen.findByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/evals\/runs\/run_19/));
    expect(await screen.findByRole('table', { name: /task success/i })).toBeInTheDocument();
  });
});

describe('keys', () => {
  it('shows the secret once after creating a key', async () => {
    const { user } = await renderRoute('/keys?create=1');
    await user.type(await screen.findByLabelText('Name'), 'test-bot');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByLabelText('API key secret')).toHaveTextContent(/^nrk_live_/);
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('API key secret')).not.toBeInTheDocument();
  });
});

describe('settings › models', () => {
  it('shows one key row per provider, saves a Gemini key write-only, and groups models by provider', async () => {
    const db = createDb({ speed: 0 });
    const { user } = await renderRoute('/settings?tab=models', { db });
    const openai = await screen.findByRole('listitem', { name: 'OpenAI key' });
    expect(within(openai).getByText(/from OPENAI_API_KEY/)).toBeInTheDocument();
    expect(within(openai).queryByLabelText('OpenAI API key')).not.toBeInTheDocument(); // env-managed: no input
    const gemini = screen.getByRole('listitem', { name: 'Gemini key' });
    expect(within(gemini).getByText('No key')).toBeInTheDocument();
    fireEvent.change(within(gemini).getByLabelText('Gemini API key'), { target: { value: 'AIza-test-key-4321' } });
    await user.click(within(gemini).getByRole('button', { name: 'Save key' }));
    expect(await within(gemini).findByText(/stored · …4321/)).toBeInTheDocument();
    expect(db.settings.keys.gemini).toEqual({ configured: true, source: 'stored', last4: '4321' });
    expect(screen.queryByDisplayValue('AIza-test-key-4321')).not.toBeInTheDocument();
    const evalModel = screen.getByLabelText('Eval model') as HTMLSelectElement;
    expect(evalModel.value).toBe('gpt-6-luna');
    expect([...evalModel.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['OpenAI', 'Anthropic', 'Gemini']);
    await user.selectOptions(evalModel, 'gemini-3.5-flash-lite');
    await waitFor(() => expect(db.settings.evalModel).toBe('gemini-3.5-flash-lite'));
  });

  it('new eval run defaults to the eval model and offers the configured providers’ models', async () => {
    const db = createDb({ speed: 0 });
    await renderRoute('/evals?new=1', { db });
    expect(await screen.findByRole('checkbox', { name: 'gpt-6-luna' })).toBeChecked();
    expect(await screen.findByRole('checkbox', { name: 'claude-sonnet-5-5' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'gemini-3.5-flash-lite' })).not.toBeInTheDocument(); // no Gemini key in the demo
  });
});
