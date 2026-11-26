import { expect, test } from '@playwright/test';

test('a task shows the dry-run script with planned changes, then the call drawer policy trail', async ({ page }) => {
  await page.goto('/tasks');
  await page.getByRole('link', { name: 'Flag unpaid orders older than 30 days' }).click();
  await expect(page.getByText('Planned changes (7)')).toBeVisible();
  await expect(page.getByText('Confirmed by user (prod write)')).toBeVisible();
  await page.getByRole('button', { name: 'Show script' }).click();
  await page.getByText(/Inspect inner calls/).last().click();
  await page.getByRole('button', { name: /add_order_note/ }).last().click();
  await expect(page.getByRole('list', { name: 'Policy trail' })).toContainText('Routed to prod');
});

test('a blocked call shows the read-only reason', async ({ page }) => {
  await page.goto('/audit?decision=blocked');
  await page.getByRole('cell', { name: /blocked/ }).first().click();
  await expect(page.getByRole('list', { name: 'Policy trail' })).toContainText(/failed/);
});
