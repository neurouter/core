import { expect, test } from '@playwright/test';

test('run → matrix → verify fix → apply → overlay draft has it → compare', async ({ page }) => {
  await page.goto('/evals/runs/run_14?tab=fixes');
  const hide = page.getByRole('article', { name: 'Hide legacyExportOrders' });
  await hide.getByRole('button', { name: 'Verify' }).click();
  await expect(hide.getByText(/Verified \+\d+ pts/)).toBeVisible({ timeout: 10_000 });
  await hide.getByRole('button', { name: 'Apply as overlay' }).click();
  await expect(hide.getByText('Applied to draft')).toBeVisible();
  const desc = page.getByRole('article', { name: 'Rewrite search_customers description' });
  await desc.getByRole('button', { name: 'Apply as overlay' }).click();
  await expect(desc.getByText('Applied to draft')).toBeVisible();
  await desc.getByRole('link', { name: 'Review the draft' }).click();
  await expect(page.getByText(/Description changed, 2 → \d+ words/)).toBeVisible();
  await page.goto('/evals/compare?base=run_14&head=run_18');
  await expect(page.getByText('+35 pts')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Flipped to pass \(14\)/ })).toBeVisible();
});

test('start a run against mock; the matrix renders as a table', async ({ page }) => {
  await page.goto('/evals?new=1');
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page).toHaveURL(/\/evals\/runs\//);
  await expect(page.getByRole('table', { name: /Task success by model and mode/ })).toBeVisible({ timeout: 25_000 });
});
