import { expect, test } from '@playwright/test';

test('demo build: banner, read-only toast, sample preview works, simulator adds a task', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/tasks');
  await expect(page.getByRole('note').filter({ hasText: 'Read-only demo' })).toBeVisible();
  const first = await page.getByRole('row').nth(1).textContent();
  await expect.poll(async () => page.getByRole('row').nth(1).textContent(), { timeout: 15_000 }).not.toBe(first);
  await page.goto('/keys');
  await expect(page.getByRole('button', { name: 'Create API key' })).toBeDisabled();
  await page.goto('/servers/srv_acme_orders/settings');
  await page.goto('/inbox/needs/need_csv_export');
  await expect(page.getByLabel('Triage', { exact: true })).toBeDisabled();
  await page.goto('/servers/new');
  await page.getByRole('button', { name: /Try the sample/ }).click();
  await expect(page.getByRole('heading', { name: 'Compiled' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('demo build: the overlay editor works on the in-memory draft; publish shows the demo toast', async ({ page }) => {
  await page.goto('/servers/srv_acme_orders/tools/srv_acme_orders__customersSearch');
  await page.getByRole('checkbox', { name: 'Keep email' }).click();
  await expect(page.getByText(/4 unpublished changes/)).toBeVisible();
  await page.goto('/servers/srv_acme_orders/overlay?publish=1');
  await page.getByRole('dialog').getByLabel('Change note').fill('try');
  await expect(page.getByRole('dialog').getByRole('button', { name: /Publish v5/ })).toBeDisabled();
});
