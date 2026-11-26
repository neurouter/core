import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SCREENS = ['/servers/srv_acme_orders', '/servers/new?step=tools', '/servers/srv_acme_orders/tools/srv_acme_orders__customersSearch', '/servers/srv_acme_orders/environments', '/tasks/task_flag_unpaid', '/inbox', '/evals/runs/run_14', '/evals/compare?base=run_14&head=run_18'];

for (const scheme of ['light', 'dark'] as const) {
  for (const url of SCREENS) {
    test(`axe ${scheme} ${url}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(url);
      await expect(page.locator('h1').first()).toBeVisible();
      await page.waitForTimeout(500);
      // syntax-highlight token colours come from the shiki theme (code stays readable); checked separately
      const r = await new AxeBuilder({ page }).exclude('.shiki-token').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });
  }
}
