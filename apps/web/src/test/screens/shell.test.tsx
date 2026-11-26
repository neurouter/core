import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { createDb } from '@/mocks/db';
import { renderRoute } from '@/test/render';
import { buildNav } from '@/app/nav';

describe('shell', () => {
  it('redirects unauthenticated users to the login page with returnTo', async () => {
    const { router } = await renderRoute('/tasks?q=x', { me: null });
    await waitFor(() => expect(router.state.location.pathname).toBe('/auth/login'));
    expect(await screen.findByRole('button', { name: /sign in with acme sso/i })).toBeInTheDocument();
  });

  it('renders the sidebar IA with the inbox badge and marks only the current page', async () => {
    await renderRoute('/servers');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    for (const g of ['Build', 'Operate', 'Evaluate', 'Govern', 'Settings']) expect(within(nav).getAllByText(g).length).toBeGreaterThan(0);
    expect(await within(nav).findByLabelText(/\d+ open/)).toBeInTheDocument();
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Servers' })).toHaveAttribute('aria-current', 'page'));
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(document.title).toBe('Servers · Neurouter');
  });

  it('shows the Viewer pill, hides mutation-only nav and disables mutations with a reason', async () => {
    await renderRoute('/servers', { me: meFixture('viewer') });
    expect(await screen.findByText('Viewer · read-only')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).queryByRole('link', { name: 'Import a spec' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import a spec/i })).toBeDisabled();
  });

  it('hides the server switcher when there is a single server', async () => {
    const db = createDb({ speed: 0 });
    db.servers = db.servers.slice(0, 1);
    await renderRoute('/tasks', { db });
    await screen.findByRole('heading', { level: 1, name: 'Tasks' });
    expect(screen.queryByRole('button', { name: /^Server:/ })).not.toBeInTheDocument();
  });

  it('filters nav by capability (unit)', () => {
    const viewer = buildNav(meFixture('viewer'), { inboxOpen: 3, evalsRunning: 0 });
    expect(viewer.flatMap((g) => g.items.map((i) => i.id))).not.toContain('import');
    expect(viewer.find((g) => g.id === 'build')?.note).toBe('read-only');
    expect(viewer.flatMap((g) => g.items).find((i) => i.id === 'inbox')?.badge).toBe(3);
  });
});
