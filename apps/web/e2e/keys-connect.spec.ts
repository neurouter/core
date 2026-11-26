import { expect, test } from '@playwright/test';

test('create a key for dev, copy the Claude Code snippet, revoke it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/keys');
  await page.getByRole('button', { name: 'Create API key' }).click();
  await page.getByLabel('Name').fill('e2e-bot');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByLabel('API key secret')).toContainText('nrk_live_');
  await page.getByRole('button', { name: 'Copy the Claude Code snippet' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('claude mcp add');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Revoke e2e-bot' }).click();
  await page.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByRole('row', { name: /e2e-bot/ })).toContainText('Revoked');
});
