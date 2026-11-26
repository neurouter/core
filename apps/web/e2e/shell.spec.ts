import { expect, test } from '@playwright/test';

test('sidebar: current page only, collapses to icons and remembers it', async ({ page }) => {
  await page.goto('/tasks');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Toggle sidebar (Ctrl+B)' }).click();
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('neurouter-console-sidebar-open'))).toBe('false');
});

test('theme toggle switches to dark and persists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /theme/i }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click().catch(async () => page.getByRole('menuitem', { name: 'Dark' }).click());
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('skip link and ⌘K palette', async ({ page }) => {
  await page.goto('/');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await skip.focus();
  await expect(skip).toBeVisible();
  await skip.press('Enter');
  await expect(page).toHaveURL(/#main/);
  await page.getByRole('button', { name: 'Search tools, tasks and pages' }).click();
  await page.getByRole('combobox', { name: /Search tools/ }).fill('refund');
  await expect(page.getByRole('option', { name: /create_refund/ }).first()).toBeVisible();
});
