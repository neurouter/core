import { expect, test } from '@playwright/test';

test('filter by decision, open the drawer, export CSV', async ({ page }) => {
  await page.goto('/audit');
  await page.getByRole('radio', { name: 'Dry run' }).click();
  await page.getByRole('cell', { name: /dry run/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Policy trail');
  await page.keyboard.press('Escape');
  // the export is a plain download link carrying the active filters (streamed by the server)
  await expect(page.getByRole('link', { name: 'CSV' })).toHaveAttribute('href', /\/api\/audit\/export\?.*decision=dry_run.*format=csv/);
});
