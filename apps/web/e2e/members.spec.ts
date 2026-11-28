import { expect, test, type Page } from '@playwright/test';

/**
 * Members, invites and the organization switcher (multi-tenancy spec §13 P1 frontend acceptance).
 * The mock bundle keeps its tenancy state (session, members, invites) in localStorage, so it
 * survives page loads. Mock-only identity switch: the console-link token `as:<email>` signs in as
 * that email.
 */
async function signInAs(page: Page, email: string) {
  await page.goto(`/auth/login?token=${encodeURIComponent(`as:${email}`)}`);
  await expect(page).toHaveURL(/\/$/);
}

test('invite flow: an owner creates a link, a new user signs in through it, accepts and is listed', async ({ page }) => {
  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
  await page.getByRole('button', { name: 'Invite member' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite a member' });
  await dialog.getByLabel('Email').fill('sam.e2e@acme.test');
  await dialog.getByRole('radio', { name: /Admin/ }).check();
  await dialog.getByRole('button', { name: 'Create invite link' }).click();
  const link = page.getByLabel('Invite link', { exact: true });
  await expect(link).toContainText('/invite#t=');
  const url = (await link.textContent())!.trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('table', { name: 'Invites' }).getByRole('row', { name: /sam\.e2e@acme\.test/ })).toContainText('Pending');

  // the owner signs out; the invited person opens the link while signed out
  await page.getByRole('button', { name: /User menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/auth\/logged-out/);
  await page.goto(url);
  await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Finvite/);
  expect(await page.evaluate(() => sessionStorage.getItem('neurouter-invite-token'))).toBe(url.split('#t=')[1]);

  // sign in as the invited email, back to /invite, accept
  await page.getByLabel('Console link').fill('as:sam.e2e@acme.test');
  await page.getByRole('button', { name: 'Sign in with the link' }).click();
  await expect(page.getByRole('heading', { name: 'Join Acme Corp' })).toBeVisible();
  await expect(page.getByText("You're invited as admin.")).toBeVisible();
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => sessionStorage.getItem('neurouter-tenant'))).toBe('acme');

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Members' }).click();
  const row = page.getByRole('table', { name: 'Members' }).getByRole('row', { name: /sam\.e2e@acme\.test/ });
  await expect(row).toContainText('(you)');
  await expect(row).toContainText('Admin');
  // an admin invites but does not manage roles
  await expect(page.getByRole('button', { name: 'Invite member' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: /Role of/ })).toHaveCount(0);
});

test('a viewer sees the members but no invite button', async ({ page }) => {
  await signInAs(page, 'priya.raman@acme.test');
  await expect(page.getByText('Viewer · read-only')).toBeVisible();
  await page.goto('/settings/members');
  await expect(page.getByRole('table', { name: 'Members' }).getByRole('row', { name: /maya\.lindqvist@acme\.test/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite member' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Invites' })).toHaveCount(0);
});

test('the organization switcher is hidden on a single-tenant (OSS) install', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByText('Acme Corp')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Organization:/ })).toHaveCount(0);
});

test('multi-tenant: the switcher lists organizations, switching pins one to the tab, ?org= deep links', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('neurouter-mock-preset', 'multi'));
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Organization: Acme Corp' }).click();
  await page.getByRole('menuitem', { name: /Bluefin Labs/ }).click();
  await expect(page.getByRole('button', { name: 'Organization: Bluefin Labs' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Viewer · read-only')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('neurouter-tenant'))).toBe('bluefin');

  // a deep link picks the organization for this tab and is stripped from the address bar
  await page.goto('/tasks?org=acme');
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('button', { name: 'Organization: Acme Corp' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('neurouter-tenant'))).toBe('acme');
});
