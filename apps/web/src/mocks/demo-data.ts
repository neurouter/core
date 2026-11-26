/**
 * Fictional demo dataset (frontend spec §12, prototype renderVals()). Every company, API, person
 * and key is invented: Acme Corp, Acme Orders API, Lumen Inventory, Bluefin Billing API.
 * Timestamps are relative to page load so the demo always looks current.
 */

export const NOW = Date.now();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const iso = (ms: number) => new Date(ms).toISOString();
export const ago = (ms: number) => iso(NOW - ms);

/** Deterministic PRNG (mulberry32) so generated rows are stable across reloads. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const INSTANCE = { name: 'Acme Corp', version: '0.1.0' };

export const PEOPLE = {
  maya: { id: 'usr_maya', name: 'Maya Lindqvist', email: 'maya.lindqvist@acme.test', role: 'admin' as const },
  jon: { id: 'usr_jon', name: 'Jon Okafor', email: 'jon.okafor@acme.test', role: 'admin' as const },
  priya: { id: 'usr_priya', name: 'Priya Raman', email: 'priya.raman@acme.test', role: 'viewer' as const },
};

export const MODELS = ['gpt-6-luna', 'claude-sonnet-5-5', 'gemini-3.5-flash-lite'] as const;
export const CLIENTS = [
  { name: 'Claude Code', version: '2.4.1' },
  { name: 'Cursor', version: '1.9.0' },
  { name: 'VS Code', version: '1.104.0' },
  { name: 'custom-agent', version: '1.2' },
];

/* ------------------------------------------------------------------ servers */

export type ServerSeed = {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: 'openapi' | 'graphql';
  specFormat: 'openapi-3.0' | 'openapi-3.1' | 'graphql-sdl';
  specTitle: string;
  operations: number;
  specRev: number;
  overlayRev: number;
  envs: string[];
  importedDaysAgo: number;
};

export const SERVERS: ServerSeed[] = [
  {
    id: 'srv_acme_orders',
    slug: 'acme-orders',
    name: 'Acme Orders API',
    description: 'Orders, refunds, customers and shipments for the Acme storefront.',
    kind: 'openapi',
    specFormat: 'openapi-3.1',
    specTitle: 'Acme Orders API',
    operations: 46,
    specRev: 3,
    overlayRev: 4,
    envs: ['mock', 'dev', 'qa', 'prod'],
    importedDaysAgo: 2,
  },
  {
    id: 'srv_lumen',
    slug: 'lumen-inventory',
    name: 'Lumen Inventory',
    description: 'Stock levels, warehouses and purchase orders (GraphQL).',
    kind: 'graphql',
    specFormat: 'graphql-sdl',
    specTitle: 'Lumen Inventory',
    operations: 21,
    specRev: 2,
    overlayRev: 2,
    envs: ['mock', 'dev', 'prod'],
    importedDaysAgo: 9,
  },
  {
    id: 'srv_bluefin',
    slug: 'bluefin-billing',
    name: 'Bluefin Billing API',
    description: 'Invoices, subscriptions and payment methods.',
    kind: 'openapi',
    specFormat: 'openapi-3.0',
    specTitle: 'Bluefin Billing API',
    operations: 120,
    specRev: 1,
    overlayRev: 1,
    envs: ['mock', 'dev'],
    importedDaysAgo: 1,
  },
];

/* ------------------------------------------------------------------ tools */

export type ToolSeed = {
  name: string;
  orig: string;
  method?: string;
  path?: string;
  field?: string;
  write?: boolean;
  destructive?: boolean;
  hidden?: boolean;
  deprecated?: boolean;
  pinned?: boolean;
  quality: 'none' | 'short' | 'ok';
  calls7d: number;
  err: number;
  description: string;
  modified?: boolean;
  issues?: number;
  suggestHide?: string;
};

export const ACME_TOOLS: ToolSeed[] = [
  { name: 'search_orders', orig: 'searchOrders', method: 'POST', path: '/v2/orders/search', quality: 'ok', calls7d: 6912, err: 0.004, pinned: true, description: 'Search orders by customer, status, date range or total. Returns up to 50 orders per page.' },
  { name: 'get_order', orig: 'getOrder', method: 'GET', path: '/v2/orders/{id}', quality: 'ok', calls7d: 5207, err: 0.002, pinned: true, description: 'Get one order by id, with line items, totals in minor units (cents) and the shipping address.' },
  { name: 'list_orders', orig: 'getOrdersV2', method: 'GET', path: '/v2/orders', quality: 'short', calls7d: 3880, err: 0.011, pinned: true, modified: true, description: 'List orders, newest first. Filter by status and age in days.' },
  { name: 'search_customers', orig: 'customersSearch', method: 'GET', path: '/customers/search', quality: 'short', calls7d: 2114, err: 0.029, modified: true, issues: 0, description: 'Search customers.' },
  { name: 'add_order_note', orig: 'createOrderNote', method: 'POST', path: '/v2/orders/{id}/notes', write: true, quality: 'ok', calls7d: 1406, err: 0.006, description: 'Add an internal note to an order. Notes are visible to support staff only.' },
  { name: 'get_customer', orig: 'getCustomer', method: 'GET', path: '/customers/{id}', quality: 'ok', calls7d: 1302, err: 0.003, pinned: true, description: 'Get a customer by id (C-1234), with contact details and default address.' },
  { name: 'list_customers', orig: 'listCustomers', method: 'GET', path: '/customers', quality: 'ok', calls7d: 640, err: 0.004, description: 'Page through all customers, oldest first. Use search_customers to find one customer.' },
  { name: 'create_refund', orig: 'postRefund', method: 'POST', path: '/v2/refunds', write: true, quality: 'ok', calls7d: 512, err: 0.031, modified: true, description: 'Refund an order fully or partly. amount_cents is in minor units (1299 = €12.99).' },
  { name: 'list_order_notes', orig: 'listOrderNotes', method: 'GET', path: '/v2/orders/{id}/notes', quality: 'ok', calls7d: 488, err: 0.001, description: 'List the internal notes of an order.' },
  { name: 'get_order_events', orig: 'getOrderEvents', method: 'GET', path: '/v2/orders/{id}/events', quality: 'short', calls7d: 431, err: 0.005, description: 'Order history events.' },
  { name: 'list_shipments', orig: 'listShipments', method: 'GET', path: '/v2/shipments', quality: 'ok', calls7d: 377, err: 0.002, description: 'List shipments, filter by order id or carrier.' },
  { name: 'track_shipment', orig: 'trackShipment', method: 'GET', path: '/v2/shipments/{id}/tracking', quality: 'ok', calls7d: 352, err: 0.018, description: 'Live tracking status of a shipment from the carrier.' },
  { name: 'update_order_address', orig: 'patchOrderAddress', method: 'PATCH', path: '/v2/orders/{id}/address', write: true, quality: 'short', calls7d: 210, err: 0.024, description: 'Change the shipping address of an order.' },
  { name: 'cancel_order', orig: 'cancelOrder', method: 'POST', path: '/v2/orders/{id}/cancel', write: true, destructive: true, quality: 'none', calls7d: 188, err: 0.012, description: '' },
  { name: 'list_refunds', orig: 'listRefunds', method: 'GET', path: '/v2/refunds', quality: 'ok', calls7d: 176, err: 0.001, description: 'List refunds, filter by order id or date.' },
  { name: 'get_refund', orig: 'getRefund', method: 'GET', path: '/v2/refunds/{id}', quality: 'ok', calls7d: 92, err: 0.0, description: 'Get one refund by id.' },
  { name: 'list_products', orig: 'listProducts', method: 'GET', path: '/v2/products', quality: 'ok', calls7d: 164, err: 0.001, description: 'List products in the catalogue.' },
  { name: 'get_product', orig: 'getProduct', method: 'GET', path: '/v2/products/{sku}', quality: 'ok', calls7d: 151, err: 0.002, description: 'Get a product by SKU.' },
  { name: 'search_products', orig: 'searchProducts', method: 'GET', path: '/v2/products/search', quality: 'short', calls7d: 133, err: 0.004, description: 'Search products.' },
  { name: 'get_shipment', orig: 'getShipment', method: 'GET', path: '/v2/shipments/{id}', quality: 'ok', calls7d: 98, err: 0.001, description: 'Get a shipment by id.' },
  { name: 'list_invoices', orig: 'listInvoices', method: 'GET', path: '/v2/invoices', quality: 'ok', calls7d: 87, err: 0.003, description: 'List invoices for an order or customer.' },
  { name: 'get_invoice', orig: 'getInvoice', method: 'GET', path: '/v2/invoices/{id}', quality: 'ok', calls7d: 61, err: 0.0, description: 'Get an invoice by id, with PDF link.' },
  { name: 'list_payments', orig: 'listPayments', method: 'GET', path: '/v2/payments', quality: 'short', calls7d: 58, err: 0.002, description: 'List payments.' },
  { name: 'get_payment', orig: 'getPayment', method: 'GET', path: '/v2/payments/{id}', quality: 'ok', calls7d: 41, err: 0.0, description: 'Get a payment by id.' },
  { name: 'get_inventory_level', orig: 'getInventoryLevel', method: 'GET', path: '/v2/inventory/{sku}', quality: 'ok', calls7d: 37, err: 0.005, description: 'Stock level for a SKU across warehouses.' },
  { name: 'list_warehouses', orig: 'listWarehouses', method: 'GET', path: '/v2/warehouses', quality: 'ok', calls7d: 12, err: 0.0, description: 'List warehouses.' },
  { name: 'create_order', orig: 'createOrder', method: 'POST', path: '/v2/orders', write: true, quality: 'ok', calls7d: 34, err: 0.029, description: 'Create a draft order for a customer.' },
  { name: 'delete_order_note', orig: 'deleteOrderNote', method: 'DELETE', path: '/v2/orders/{id}/notes/{noteId}', write: true, destructive: true, quality: 'short', calls7d: 9, err: 0.0, description: 'Delete a note.' },
  { name: 'update_order_status', orig: 'patchOrderStatus', method: 'PATCH', path: '/v2/orders/{id}/status', write: true, quality: 'ok', calls7d: 27, err: 0.037, description: 'Move an order to a new status (processing, shipped, delivered).' },
  { name: 'create_customer', orig: 'createCustomer', method: 'POST', path: '/customers', write: true, quality: 'ok', calls7d: 6, err: 0.0, description: 'Create a customer record.' },
  { name: 'update_customer', orig: 'patchCustomer', method: 'PATCH', path: '/customers/{id}', write: true, quality: 'short', calls7d: 14, err: 0.0, description: 'Update a customer.' },
  // hidden by overlay (15)
  { name: 'legacy_export_orders', orig: 'legacyExportOrders', method: 'GET', path: '/v1/export', hidden: true, deprecated: true, quality: 'none', calls7d: 0, err: 0, modified: true, description: '', suggestHide: 'deprecated' },
  { name: 'get_order_v1', orig: 'getOrderV1', method: 'GET', path: '/v1/orders/{id}', hidden: true, deprecated: true, quality: 'short', calls7d: 0, err: 0, description: 'Get order (v1).', suggestHide: 'deprecated' },
  { name: 'list_order_events_v1', orig: 'orderEventsV1', method: 'GET', path: '/v1/orders/{id}/events', hidden: true, deprecated: true, quality: 'none', calls7d: 0, err: 0, description: '', suggestHide: 'deprecated' },
  { name: 'admin_reindex_orders', orig: 'adminReindexOrders', method: 'POST', path: '/admin/reindex', hidden: true, quality: 'none', calls7d: 0, err: 0, description: '', suggestHide: 'admin-only path' },
  { name: 'admin_purge_cache', orig: 'adminPurgeCache', method: 'POST', path: '/admin/cache/purge', hidden: true, quality: 'none', calls7d: 0, err: 0, description: '', suggestHide: 'admin-only path' },
  { name: 'admin_list_audit', orig: 'adminListAudit', method: 'GET', path: '/admin/audit', hidden: true, quality: 'short', calls7d: 0, err: 0, description: 'Audit entries.', suggestHide: 'admin-only path' },
  { name: 'internal_health', orig: 'internalHealth', method: 'GET', path: '/internal/health', hidden: true, quality: 'none', calls7d: 0, err: 0, description: '', suggestHide: 'admin-only path' },
  { name: 'internal_metrics', orig: 'internalMetrics', method: 'GET', path: '/internal/metrics', hidden: true, quality: 'none', calls7d: 0, err: 0, description: '', suggestHide: 'admin-only path' },
  { name: 'list_webhooks', orig: 'listWebhooks', method: 'GET', path: '/v2/webhooks', hidden: true, quality: 'short', calls7d: 0, err: 0, description: 'Webhooks.' },
  { name: 'get_webhook', orig: 'getWebhook', method: 'GET', path: '/v2/webhooks/{id}', hidden: true, quality: 'short', calls7d: 0, err: 0, description: 'Webhook.' },
  { name: 'list_api_clients', orig: 'listApiClients', method: 'GET', path: '/v2/clients', hidden: true, quality: 'none', calls7d: 0, err: 0, description: '' },
  { name: 'get_rate_limits', orig: 'getRateLimits', method: 'GET', path: '/v2/rate-limits', hidden: true, quality: 'short', calls7d: 0, err: 0, description: 'Rate limits.' },
  { name: 'list_feature_flags', orig: 'listFeatureFlags', method: 'GET', path: '/v2/flags', hidden: true, quality: 'none', calls7d: 0, err: 0, description: '' },
  { name: 'get_openapi_spec', orig: 'getOpenapiSpec', method: 'GET', path: '/openapi.json', hidden: true, quality: 'ok', calls7d: 0, err: 0, description: 'Returns this OpenAPI document.' },
  { name: 'get_order_by_number', orig: 'getOrderByNumber', method: 'GET', path: '/v2/orders/by-number/{number}', hidden: true, quality: 'short', calls7d: 0, err: 0, description: 'Duplicate of get_order.', suggestHide: 'duplicate' },
];

export const LUMEN_TOOLS: ToolSeed[] = [
  { name: 'stock_level', orig: 'stockLevel', field: 'Query.stockLevel', quality: 'ok', calls7d: 2210, err: 0.003, pinned: true, description: 'Current stock for a SKU in each warehouse.' },
  { name: 'warehouses', orig: 'warehouses', field: 'Query.warehouses', quality: 'ok', calls7d: 640, err: 0.0, description: 'All warehouses with their region and capacity.' },
  { name: 'purchase_orders', orig: 'purchaseOrders', field: 'Query.purchaseOrders', quality: 'short', calls7d: 512, err: 0.008, description: 'Purchase orders.' },
  { name: 'purchase_order', orig: 'purchaseOrder', field: 'Query.purchaseOrder', quality: 'ok', calls7d: 301, err: 0.002, description: 'One purchase order by id, with lines and supplier.' },
  { name: 'suppliers', orig: 'suppliers', field: 'Query.suppliers', quality: 'ok', calls7d: 204, err: 0.0, description: 'Suppliers and their lead times.' },
  { name: 'sku', orig: 'sku', field: 'Query.sku', quality: 'ok', calls7d: 190, err: 0.001, description: 'A SKU with dimensions and reorder point.' },
  { name: 'search_skus', orig: 'searchSkus', field: 'Query.searchSkus', quality: 'short', calls7d: 176, err: 0.006, description: 'Search SKUs.' },
  { name: 'stock_movements', orig: 'stockMovements', field: 'Query.stockMovements', quality: 'ok', calls7d: 120, err: 0.004, description: 'Stock movements for a SKU over a date range.' },
  { name: 'reorder_suggestions', orig: 'reorderSuggestions', field: 'Query.reorderSuggestions', quality: 'ok', calls7d: 88, err: 0.0, description: 'SKUs below their reorder point.' },
  { name: 'bins', orig: 'bins', field: 'Query.bins', quality: 'none', calls7d: 31, err: 0.0, description: '' },
  { name: 'transfer', orig: 'transfer', field: 'Query.transfer', quality: 'short', calls7d: 22, err: 0.0, description: 'A transfer.' },
  { name: 'adjust_stock', orig: 'adjustStock', field: 'Mutation.adjustStock', write: true, quality: 'ok', calls7d: 96, err: 0.021, description: 'Adjust the stock of a SKU in one warehouse (positive or negative quantity).' },
  { name: 'create_purchase_order', orig: 'createPurchaseOrder', field: 'Mutation.createPurchaseOrder', write: true, quality: 'ok', calls7d: 41, err: 0.0, description: 'Create a draft purchase order for a supplier.' },
  { name: 'receive_purchase_order', orig: 'receivePurchaseOrder', field: 'Mutation.receivePurchaseOrder', write: true, quality: 'short', calls7d: 18, err: 0.0, description: 'Receive a PO.' },
  { name: 'create_transfer', orig: 'createTransfer', field: 'Mutation.createTransfer', write: true, quality: 'ok', calls7d: 12, err: 0.0, description: 'Move stock between warehouses.' },
  { name: 'cancel_purchase_order', orig: 'cancelPurchaseOrder', field: 'Mutation.cancelPurchaseOrder', write: true, destructive: true, quality: 'none', calls7d: 3, err: 0.0, description: '' },
  { name: 'update_reorder_point', orig: 'updateReorderPoint', field: 'Mutation.updateReorderPoint', write: true, quality: 'ok', calls7d: 9, err: 0.0, description: 'Set the reorder point of a SKU.' },
  { name: 'set_bin', orig: 'setBin', field: 'Mutation.setBin', write: true, quality: 'none', calls7d: 2, err: 0.0, description: '' },
  { name: 'internal_sync', orig: 'internalSync', field: 'Mutation.internalSync', write: true, hidden: true, quality: 'none', calls7d: 0, err: 0, description: '', suggestHide: 'admin-only path' },
  { name: 'debug_cache', orig: 'debugCache', field: 'Query.debugCache', hidden: true, quality: 'none', calls7d: 0, err: 0, description: '', suggestHide: 'admin-only path' },
  { name: 'legacy_stock', orig: 'legacyStock', field: 'Query.legacyStock', hidden: true, deprecated: true, quality: 'short', calls7d: 0, err: 0, description: 'Old stock query.', suggestHide: 'deprecated' },
];

/** Bluefin: 120 operations, 24 exposed by default (the compiler hides the rest as admin/duplicate). */
export const BLUEFIN_TOOLS: ToolSeed[] = (() => {
  const names = [
    'list_invoices', 'get_invoice', 'create_invoice', 'void_invoice', 'list_subscriptions', 'get_subscription', 'cancel_subscription', 'update_subscription',
    'list_customers', 'get_customer', 'create_customer', 'list_payment_methods', 'attach_payment_method', 'list_charges', 'get_charge', 'refund_charge',
    'list_plans', 'get_plan', 'list_coupons', 'get_coupon', 'list_credit_notes', 'get_credit_note', 'get_balance', 'list_payouts',
  ];
  const writes = new Set(['create_invoice', 'void_invoice', 'cancel_subscription', 'update_subscription', 'create_customer', 'attach_payment_method', 'refund_charge']);
  const out: ToolSeed[] = names.map((n, i) => ({
    name: n,
    orig: n.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    method: writes.has(n) ? 'POST' : 'GET',
    path: `/v1/${n.split('_').slice(1).join('-')}`,
    write: writes.has(n),
    quality: i % 3 === 0 ? 'none' : i % 3 === 1 ? 'short' : 'ok',
    calls7d: 0,
    err: 0,
    description: i % 3 === 0 ? '' : `${n.replaceAll('_', ' ')}.`,
  }));
  for (let i = 0; i < 96; i++) out.push({ name: `admin_op_${i + 1}`, orig: `adminOp${i + 1}`, method: 'GET', path: `/v1/admin/op-${i + 1}`, hidden: true, quality: 'none', calls7d: 0, err: 0, description: '', suggestHide: 'admin-only path' });
  return out;
})();

export const TOOLS_BY_SERVER: Record<string, ToolSeed[]> = { srv_acme_orders: ACME_TOOLS, srv_lumen: LUMEN_TOOLS, srv_bluefin: BLUEFIN_TOOLS };

/* ------------------------------------------------------------------ environments */

export type EnvSeed = {
  slug: string;
  kind: 'dev' | 'qa' | 'prod';
  isMock?: boolean;
  baseUrl: string | null;
  authType: 'none' | 'header' | 'bearer' | 'oauth_passthrough' | 'oauth_client_credentials';
  secretRef: string | null;
  health: 'up' | 'down' | 'unknown';
  latencyMs: number;
  writesOn: string[] | 'all';
  lastCallMin: number;
  buildRev: 'draft' | number;
  managedBy?: 'file' | 'console';
};

export const ENVS: Record<string, EnvSeed[]> = {
  srv_acme_orders: [
    { slug: 'mock', kind: 'dev', isMock: true, baseUrl: null, authType: 'none', secretRef: null, health: 'up', latencyMs: 4, writesOn: 'all', lastCallMin: 2, buildRev: 4 },
    { slug: 'dev', kind: 'dev', baseUrl: 'https://dev.orders.acme.test', authType: 'header', secretRef: 'env:ACME_DEV_TOKEN', health: 'up', latencyMs: 120, writesOn: 'all', lastCallMin: 6, buildRev: 4 },
    { slug: 'qa', kind: 'qa', baseUrl: 'https://qa.orders.acme.test', authType: 'oauth_client_credentials', secretRef: 'secret:ACME_QA_CLIENT', health: 'up', latencyMs: 180, writesOn: ['create_refund', 'update_order_address', 'add_order_note'], lastCallMin: 60, buildRev: 4 },
    { slug: 'prod', kind: 'prod', baseUrl: 'https://api.orders.acme.test', authType: 'oauth_passthrough', secretRef: null, health: 'up', latencyMs: 1800, writesOn: ['add_order_note'], lastCallMin: 0, buildRev: 4 },
  ],
  srv_lumen: [
    { slug: 'mock', kind: 'dev', isMock: true, baseUrl: null, authType: 'none', secretRef: null, health: 'up', latencyMs: 3, writesOn: 'all', lastCallMin: 40, buildRev: 2 },
    { slug: 'dev', kind: 'dev', baseUrl: 'https://dev.lumen.test/graphql', authType: 'bearer', secretRef: 'env:LUMEN_DEV_TOKEN', health: 'up', latencyMs: 90, writesOn: 'all', lastCallMin: 25, buildRev: 2 },
    { slug: 'prod', kind: 'prod', baseUrl: 'https://lumen.test/graphql', authType: 'bearer', secretRef: 'secret:LUMEN_PROD_TOKEN', health: 'down', latencyMs: 0, writesOn: [], lastCallMin: 190, buildRev: 2, managedBy: 'file' },
  ],
  srv_bluefin: [
    { slug: 'mock', kind: 'dev', isMock: true, baseUrl: null, authType: 'none', secretRef: null, health: 'up', latencyMs: 3, writesOn: 'all', lastCallMin: 300, buildRev: 1 },
    { slug: 'dev', kind: 'dev', baseUrl: 'https://sandbox.bluefin.test/v1', authType: 'bearer', secretRef: 'env:BLUEFIN_SANDBOX_KEY', health: 'unknown', latencyMs: 0, writesOn: [], lastCallMin: -1, buildRev: 1 },
  ],
};

/* ------------------------------------------------------------------ readiness */

export const ACME_BREAKDOWN = [
  { key: 'success', label: 'Task success', weight: 0.35, score: 0.84, detail: '34 of 40 tasks pass in the best mode per model', fixCount: 1 },
  { key: 'efficiency', label: 'Efficiency', weight: 0.15, score: 0.79, detail: '2.4 calls and 3.6k tokens per task on average', fixCount: 0 },
  { key: 'impossible', label: 'Impossible-task handling', weight: 0.15, score: 0.7, detail: 'Agents report an unmet need or ask in 7 of 10 impossible tasks', fixCount: 1 },
  { key: 'framing', label: 'Task framing', weight: 0.1, score: 0.95, detail: 'begin_task / end_task used in 95% of tasks', fixCount: 0 },
  { key: 'quality', label: 'Spec quality', weight: 0.15, score: 0.76, detail: '17 operations still have no description', fixCount: 2 },
  { key: 'stability', label: 'Stability', weight: 0.1, score: 0.88, detail: '3 flaky tasks across N = 3 repetitions', fixCount: 0 },
] as const;

export const ACME_BASELINE_BREAKDOWN = [
  { key: 'success', label: 'Task success', weight: 0.35, score: 0.54, detail: '22 of 40 tasks pass', fixCount: 3 },
  { key: 'efficiency', label: 'Efficiency', weight: 0.15, score: 0.41, detail: '7.1 calls and 9.4k tokens per task on average', fixCount: 1 },
  { key: 'impossible', label: 'Impossible-task handling', weight: 0.15, score: 0.5, detail: 'Agents guess in half of the impossible tasks', fixCount: 1 },
  { key: 'framing', label: 'Task framing', weight: 0.1, score: 0.8, detail: 'begin_task / end_task used in 80% of tasks', fixCount: 0 },
  { key: 'quality', label: 'Spec quality', weight: 0.15, score: 0.48, detail: '29 operations have no description', fixCount: 3 },
  { key: 'stability', label: 'Stability', weight: 0.1, score: 0.62, detail: '9 flaky tasks', fixCount: 0 },
] as const;

export const LUMEN_BREAKDOWN = [
  { key: 'success', label: 'Task success', weight: 0.35, score: 0.76, detail: '23 of 30 tasks pass', fixCount: 1 },
  { key: 'efficiency', label: 'Efficiency', weight: 0.15, score: 0.71, detail: '3.1 calls per task', fixCount: 0 },
  { key: 'impossible', label: 'Impossible-task handling', weight: 0.15, score: 0.66, detail: '', fixCount: 1 },
  { key: 'framing', label: 'Task framing', weight: 0.1, score: 0.9, detail: '', fixCount: 0 },
  { key: 'quality', label: 'Spec quality', weight: 0.15, score: 0.7, detail: '', fixCount: 1 },
  { key: 'stability', label: 'Stability', weight: 0.1, score: 0.8, detail: '', fixCount: 0 },
] as const;

/** Spec lint (backend §8.6), prototype ImportReadiness: descriptions 61%, examples 22%, naming 80%. */
export const ACME_LINT = {
  score: 48,
  rules: [
    { rule: 'description_present' as const, weight: 15, score: 0.61, passed: false, detail: '17 operations have no description' },
    { rule: 'examples_present' as const, weight: 5, score: 0.22, passed: false, detail: '36 operations have no example' },
    { rule: 'names_clear' as const, weight: 10, score: 0.8, passed: true, detail: '4 operationIds missing, names were generated' },
    { rule: 'params_described' as const, weight: 15, score: 0.44, passed: false, detail: '56% of arguments have no description' },
    { rule: 'toolset_size' as const, weight: 15, score: 1, passed: true, detail: '31 visible tools' },
  ],
  findings: [
    { rule: 'description_present' as const, severity: 'warning' as const, tool: 'cancel_order', message: 'cancel_order has no description' },
    { rule: 'examples_present' as const, severity: 'warning' as const, tool: 'create_refund', message: 'POST /v2/refunds has no example' },
    { rule: 'names_clear' as const, severity: 'info' as const, message: 'operationId missing on 4 operations, names were generated' },
  ],
};

export const BLUEFIN_LINT = {
  score: 41,
  rules: [
    { rule: 'description_present' as const, weight: 15, score: 0.44, passed: false, detail: '67 operations have no description' },
    { rule: 'examples_present' as const, weight: 5, score: 0.12, passed: false, detail: 'Almost no examples' },
    { rule: 'names_clear' as const, weight: 10, score: 0.72, passed: true, detail: '' },
  ],
  findings: [{ rule: 'description_present' as const, severity: 'warning' as const, message: '67 operations have no description' }],
};

/* ------------------------------------------------------------------ eval runs */

export type RunSeed = {
  id: string;
  number: number;
  serverId: string;
  score: number;
  overlayRev: number;
  modes: ('tool' | 'code')[];
  daysAgo: number;
  label?: string;
  trigger: 'console' | 'cli' | 'ci';
  matrix: Record<string, { tool: [number, number, number] | null; code: [number, number, number] | null }>;
  status?: 'succeeded' | 'running' | 'failed';
};

/** matrix value tuples: [successRate, avgCalls, avgTokens] */
export const RUNS: RunSeed[] = [
  {
    id: 'run_18', number: 18, serverId: 'srv_acme_orders', score: 87, overlayRev: 4, modes: ['tool', 'code'], daysAgo: 0.09, label: 'after fixes', trigger: 'console',
    matrix: { 'gpt-6-luna': { tool: [0.88, 3.1, 4300], code: [0.94, 1.1, 2900] }, 'claude-sonnet-5-5': { tool: [0.85, 3.3, 4100], code: [0.92, 1.2, 2700] }, 'gemini-3.5-flash-lite': { tool: [0.74, 3.9, 3900], code: [0.86, 1.4, 2500] } },
  },
  {
    id: 'run_17', number: 17, serverId: 'srv_acme_orders', score: 79, overlayRev: 3, modes: ['tool', 'code'], daysAgo: 0.6, trigger: 'ci',
    matrix: { 'gpt-6-luna': { tool: [0.8, 4.2, 6100], code: [0.91, 1.2, 3100] }, 'claude-sonnet-5-5': { tool: [0.78, 4.4, 5900], code: [0.89, 1.3, 2900] }, 'gemini-3.5-flash-lite': { tool: [0.66, 5.0, 5400], code: [0.8, 1.6, 2800] } },
  },
  {
    id: 'run_16', number: 16, serverId: 'srv_acme_orders', score: 70, overlayRev: 3, modes: ['tool'], daysAgo: 1.1, trigger: 'console',
    matrix: { 'gpt-6-luna': { tool: [0.76, 4.8, 6900], code: null }, 'claude-sonnet-5-5': { tool: [0.73, 5.0, 6600], code: null }, 'gemini-3.5-flash-lite': { tool: [0.6, 5.9, 6100], code: null } },
  },
  {
    id: 'run_15', number: 15, serverId: 'srv_acme_orders', score: 61, overlayRev: 2, modes: ['tool'], daysAgo: 1.6, trigger: 'cli',
    matrix: { 'gpt-6-luna': { tool: [0.7, 5.9, 8100], code: null }, 'claude-sonnet-5-5': { tool: [0.67, 6.2, 7800], code: null }, 'gemini-3.5-flash-lite': { tool: [0.55, 7.1, 7300], code: null } },
  },
  {
    id: 'run_14', number: 14, serverId: 'srv_acme_orders', score: 52, overlayRev: 1, modes: ['tool', 'code'], daysAgo: 2, label: 'baseline', trigger: 'console',
    matrix: { 'gpt-6-luna': { tool: [0.64, 6.9, 9800], code: [0.86, 1.3, 3900] }, 'claude-sonnet-5-5': { tool: [0.61, 7.1, 9100], code: [0.84, 1.4, 3500] }, 'gemini-3.5-flash-lite': { tool: [0.48, 8.0, 8400], code: [0.71, 1.8, 3200] } },
  },
  {
    id: 'run_6', number: 6, serverId: 'srv_lumen', score: 74, overlayRev: 2, modes: ['tool', 'code'], daysAgo: 3, trigger: 'console',
    matrix: { 'gpt-6-luna': { tool: [0.8, 3.0, 4100], code: [0.83, 1.2, 2600] }, 'claude-sonnet-5-5': { tool: [0.77, 3.2, 3900], code: [0.8, 1.3, 2500] }, 'gemini-3.5-flash-lite': { tool: [0.62, 3.9, 3600], code: [0.7, 1.6, 2400] } },
  },
];

export const EVAL_TASK_PROMPTS: { key: string; category: 'single' | 'multi' | 'ambiguous' | 'impossible'; prompt: string }[] = [
  { key: 't01', category: 'single', prompt: 'Look up a single order by id (ORD-55120)' },
  { key: 't02', category: 'single', prompt: 'Which customer has the email jon@acme.test?' },
  { key: 't03', category: 'single', prompt: 'What is the tracking status of shipment SH-2231?' },
  { key: 't04', category: 'single', prompt: 'Show the refunds issued for order ORD-51877' },
  { key: 't05', category: 'single', prompt: 'How many units of SKU KB-104 are in stock?' },
  { key: 't06', category: 'single', prompt: 'Get the invoice for order ORD-50411' },
  { key: 't07', category: 'multi', prompt: 'Refund the two most recent orders for customer C-1042' },
  { key: 't08', category: 'multi', prompt: 'Find all unpaid orders over €500 from last month' },
  { key: 't09', category: 'multi', prompt: 'Add a note to every order shipped to Tampere this week' },
  { key: 't10', category: 'multi', prompt: 'Find the three most recent unpaid orders for customer C-1042' },
  { key: 't11', category: 'multi', prompt: 'Cancel every draft order older than 14 days' },
  { key: 't12', category: 'multi', prompt: 'Summarise refunds per day for the last week' },
  { key: 't13', category: 'ambiguous', prompt: 'Find Maya’s last order' },
  { key: 't14', category: 'ambiguous', prompt: 'Fix the address on the Helsinki order' },
  { key: 't15', category: 'ambiguous', prompt: 'Refund the broken keyboard' },
  { key: 't16', category: 'impossible', prompt: 'Export all orders as an XLSX file' },
  { key: 't17', category: 'impossible', prompt: 'Refund six orders in one call' },
  { key: 't18', category: 'impossible', prompt: 'Change the shipping address of a dispatched order' },
];

/* ------------------------------------------------------------------ inbox */

export const NEED_GROUPS = [
  {
    id: 'need_bulk_refund', label: 'Refund several orders at once', count: 23, keys: 9, status: 'planned' as const, firstDays: 14, lastMin: 120,
    daily: [2, 3, 2, 5, 4, 6, 8, 7, 9, 11, 10, 13, 15, 17], covered: null as string | null,
    reports: [
      { intent: 'Customer wants refunds for all 6 items of a split shipment.', attempted: 'called create_refund 6 times', key: 'support-copilot', days: 1 },
      { intent: 'Bulk refund after a duplicate charge incident.', attempted: 'none, stopped to ask', key: 'ops-nightly', days: 2 },
      { intent: 'Refund every order in a cancelled B2B contract.', attempted: 'listed orders, then gave up after 12 refunds', key: 'support-copilot', days: 3 },
      { intent: 'Partial refunds for a batch of late deliveries.', attempted: 'called create_refund 9 times', key: 'dev-sandbox', days: 5 },
    ],
    tried: [{ tool: 'create_refund', count: 31 }, { tool: 'list_orders', count: 19 }],
  },
  {
    id: 'need_address_after_dispatch', label: 'Change shipping address after dispatch', count: 14, keys: 6, status: 'open' as const, firstDays: 12, lastMin: 300,
    daily: [1, 2, 4, 3, 5, 4, 6, 6, 7, 8, 7, 9, 10, 11], covered: null,
    reports: [
      { intent: 'Customer moved after the parcel left the warehouse.', attempted: 'update_order_address returned 409 order_dispatched', key: 'support-copilot', days: 1 },
      { intent: 'Redirect a parcel to a pickup point.', attempted: 'none', key: 'support-copilot', days: 4 },
    ],
    tried: [{ tool: 'update_order_address', count: 14 }, { tool: 'track_shipment', count: 9 }],
  },
  {
    id: 'need_csv_export', label: 'Export orders as CSV', count: 11, keys: 4, status: 'open' as const, firstDays: 13, lastMin: 1300,
    daily: [5, 6, 5, 7, 6, 6, 5, 7, 6, 5, 6, 7, 6, 6], covered: null,
    reports: [{ intent: 'Finance wants last month’s orders in a spreadsheet.', attempted: 'paged list_orders 40 times', key: 'ops-nightly', days: 1 }],
    tried: [{ tool: 'list_orders', count: 44 }],
  },
  {
    id: 'need_orders_by_email', label: 'Find orders by customer email', count: 8, keys: 5, status: 'open' as const, firstDays: 10, lastMin: 2900,
    daily: [3, 4, 4, 5, 4, 3, 4, 5, 4, 3, 3, 4, 3, 2], covered: 'search_orders',
    reports: [{ intent: 'Look up all orders for maya@acme.test.', attempted: 'search_customers, then list_orders per customer', key: 'support-copilot', days: 2 }],
    tried: [{ tool: 'search_customers', count: 8 }, { tool: 'list_orders', count: 8 }],
  },
];

export const ISSUES = [
  { id: 'iss_total_string', tool: 'get_order', problem: 'get_order returns `total` as a string, schema says number', evidence: 'Response had "total": "129.90" while the output schema declares type number. Parsing failed in a script.', env: 'prod', status: 'open' as const, dup: 6, lastMin: 240, key: 'support-copilot' },
  { id: 'iss_cursor_page3', tool: 'list_orders', problem: 'list_orders ignores `cursor` after page 3', evidence: 'Pages 4 and 5 returned the same orders as page 3 (ORD-50110 … ORD-50159).', env: 'qa', status: 'acknowledged' as const, dup: 2, lastMin: 1600, key: 'ops-nightly' },
];

/* ------------------------------------------------------------------ keys */

export const KEYS = [
  { id: 'key_support_copilot', name: 'support-copilot', prefix: 'nr_prod_3f9a', server: 'srv_acme_orders', env: 'prod', scopes: ['tools:read', 'tools:write', 'code:run'] as const, owner: 'maya', createdDays: 40, lastMin: 1, expiresDays: 50 },
  { id: 'key_ops_nightly', name: 'ops-nightly', prefix: 'nr_prod_81c2', server: 'srv_acme_orders', env: 'prod', scopes: ['tools:read', 'code:run'] as const, owner: 'jon', createdDays: 30, lastMin: 420, expiresDays: 60 },
  { id: 'key_dev_sandbox', name: 'dev-sandbox', prefix: 'nr_dev_7d10', server: 'srv_acme_orders', env: 'dev', scopes: ['tools:read', 'tools:write', 'code:run'] as const, owner: 'maya', createdDays: 20, lastMin: 6, expiresDays: null },
  { id: 'key_lumen_support', name: 'support-copilot-lumen', prefix: 'nr_prod_c4e1', server: 'srv_lumen', env: 'prod', scopes: ['tools:read'] as const, owner: 'maya', createdDays: 9, lastMin: 190, expiresDays: 81 },
  { id: 'key_old_import', name: 'import-script', prefix: 'nr_dev_02bb', server: 'srv_acme_orders', env: 'dev', scopes: ['tools:read'] as const, owner: 'jon', createdDays: 120, lastMin: 60 * 24 * 40, expiresDays: -30 },
];

/* ------------------------------------------------------------------ tasks (featured) */

export const TASK_GOALS = [
  'Find the order status for customer C-1042',
  'Refund a damaged keyboard on ORD-55120',
  'List unpaid orders from last week',
  'Check where shipment SH-2231 is',
  'Add a note about a late delivery',
  'Find orders shipped to Tampere this week',
  'Answer: what did customer C-2087 buy in October?',
  'Cancel a duplicate draft order',
  'Summarise refunds issued yesterday',
  'Update the address on ORD-55301',
  'Look up invoice for ORD-50411',
  'Find the customer with email jon@acme.test',
  'How many keyboards are in stock in Tampere?',
  'Reorder SKUs below their reorder point',
  'Flag orders over €1,000 for review',
];
