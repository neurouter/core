import { expect, test } from '@playwright/test';

test('add an environment with a credential ref, test it, enable a write in dev, prod needs the typed confirm', async ({ page }) => {
  await page.goto('/servers/srv_acme_orders/environments');
  await page.getByRole('button', { name: 'dev environment: edit' }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: /OK in/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('switch', { name: 'create_order in qa' }).click();
  await expect(page.getByRole('switch', { name: 'create_order in qa' })).toBeChecked();
  await page.getByRole('switch', { name: 'create_refund in prod' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Enable in prod' }).click();
  await expect(dialog.getByText('Type prod exactly to enable the write.')).toBeVisible();
  await dialog.getByLabel(/to confirm/).fill('prod');
  await dialog.getByRole('button', { name: 'Enable in prod' }).click();
  await expect(page.getByRole('switch', { name: 'create_refund in prod' })).toBeChecked();
});
