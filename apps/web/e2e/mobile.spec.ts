import { expect, test } from '@playwright/test';

for (const url of ['/', '/servers/srv_acme_orders', '/tasks', '/inbox', '/evals/runs/run_14']) {
  test(`390px read flow ${url}: no horizontal page scroll`, async ({ page }) => {
    await page.goto(url);
    await expect(page.locator('h1').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('the sidebar is a sheet on phones and closes after navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle sidebar (Ctrl+B)' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Inbox' }).click();
  await expect(page).toHaveURL(/\/inbox/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
