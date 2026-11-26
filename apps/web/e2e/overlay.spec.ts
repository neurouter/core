import { expect, test } from '@playwright/test';

test('rename + description + response shaping → diff → publish v5 → tools list shows the new name', async ({ page }) => {
  await page.goto('/servers/srv_acme_orders/tools/srv_acme_orders__customersSearch');
  await page.getByLabel('Name', { exact: true }).fill('find_customers');
  await page.getByLabel('Description', { exact: true }).fill('Search customers by email, name or phone. Use list_customers to page through all customers.');
  await page.getByRole('checkbox', { name: 'Keep email' }).click();
  await expect(page.getByText(/1,920 → \d+ tokens/)).toBeVisible();
  await expect(page.getByText(/unpublished changes/)).toBeVisible();
  await page.getByRole('tab', { name: 'Diff' }).click();
  await expect(page.getByText('added:').first()).toBeAttached();
  await page.getByRole('link', { name: 'Review & publish' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Change note').fill('Rename and shape search');
  await dialog.getByRole('button', { name: 'Publish v5' }).click();
  await expect(page.getByRole('cell', { name: 'Rename and shape search' })).toBeVisible();
  await page.getByRole('link', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('link', { name: 'find_customers' })).toBeVisible();
});
