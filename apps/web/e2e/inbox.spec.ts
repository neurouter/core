import { expect, test } from '@playwright/test';

test('unmet needs are grouped and can be triaged to Planned', async ({ page }) => {
  await page.goto('/inbox');
  await expect(page.getByRole('button', { name: 'Refund several orders at once' })).toBeVisible();
  await page.getByRole('button', { name: 'Export orders as CSV' }).click();
  await page.getByLabel('Triage', { exact: true }).selectOption('planned');
  await expect(page.getByRole('row', { name: /Export orders as CSV/ })).toContainText('Planned');
});
