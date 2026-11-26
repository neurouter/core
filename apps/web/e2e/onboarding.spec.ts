import { expect, test } from '@playwright/test';

test('import the sample spec → compile → hide 2 tools → skip env → preliminary score → Finish → server overview', async ({ page }) => {
  await page.goto('/servers/new');
  await page.getByRole('button', { name: /Try the sample/ }).click();
  await expect(page.getByRole('heading', { name: 'Compiled' })).toBeVisible();
  await page.getByRole('button', { name: 'Next: Tools' }).click();
  await expect(page.getByText('31 of 46 tools exposed')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Include track_shipment' }).click();
  await page.getByRole('checkbox', { name: 'Include list_warehouses' }).click();
  await expect(page.getByText('29 of 46 tools exposed')).toBeVisible();
  await page.getByRole('button', { name: 'Next: Environment' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).last().click();
  await expect(page.getByRole('img', { name: /Preliminary score 48/ })).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page).toHaveURL(/\/servers\/srv_acme_orders/);
  await expect(page.getByRole('dialog', { name: 'Connect a client' })).toBeVisible();
});

test('upload YAML and GraphQL SDL; Swagger 2.0 is rejected', async ({ page }) => {
  await page.goto('/servers/new?tab=upload');
  await page.locator('input[type=file]').setInputFiles({ name: 'swagger.yaml', mimeType: 'text/yaml', buffer: Buffer.from('swagger: "2.0"\ninfo: {title: Old}\npaths: {}\n') });
  await page.getByRole('button', { name: 'Compile' }).click();
  await expect(page.getByText(/Swagger 2.0 is not supported/)).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'inventory.graphql', mimeType: 'text/plain', buffer: Buffer.from('type Query {\n  sku(id: ID!): Sku\n  skus: [Sku]\n}\ntype Mutation {\n  adjustStock(id: ID!, qty: Int!): Sku\n}\ntype Sku { id: ID! }\n') });
  await page.getByRole('button', { name: 'Compile' }).click();
  await expect(page.getByText('GraphQL SDL · 3 operations')).toBeVisible();
});
