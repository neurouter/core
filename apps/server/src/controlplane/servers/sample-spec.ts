/**
 * The bundled sample spec (fictional Acme Orders API) behind the console's "Try the sample". A copy of
 * examples/acme-orders/openapi.yaml (a test keeps them equal), bundled so a fresh `npx neurouter serve`
 * imports it without network access: the spec fetcher answers SAMPLE_SPEC_URL from here.
 */
export const SAMPLE_SPEC_YAML = `openapi: 3.1.0
info:
  title: Acme Orders API
  version: 2.3.0
  description: >-
    Orders, customers, refunds and shipments for the Acme storefront. Acme is fictional: this is the
    sample spec behind the console's "Try the sample" button and runs against the generated mock.
servers:
  - url: https://api.acme.example.test/v2
tags:
  - name: orders
  - name: customers
  - name: refunds
  - name: shipments
  - name: products
paths:
  /orders:
    get:
      operationId: listOrders
      tags: [orders]
      summary: List orders
      description: Lists orders, newest first. Filter by status or customer.
      parameters:
        - { name: status, in: query, description: Only orders in this status., schema: { $ref: '#/components/schemas/OrderStatus' } }
        - { name: customerId, in: query, description: Only orders of this customer., schema: { type: string } }
        - { $ref: '#/components/parameters/Limit' }
        - { $ref: '#/components/parameters/Cursor' }
      responses:
        '200':
          description: A page of orders.
          content:
            application/json:
              schema:
                type: object
                required: [items]
                properties:
                  items: { type: array, items: { $ref: '#/components/schemas/Order' } }
                  nextCursor: { type: [string, 'null'] }
    post:
      operationId: createOrder
      tags: [orders]
      summary: Create an order
      description: Creates a pending order for a customer with one or more line items.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/OrderCreate' }
      responses:
        '201':
          description: The created order.
          content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } }
  /orders/{orderId}:
    parameters:
      - { $ref: '#/components/parameters/OrderId' }
    get:
      operationId: getOrder
      tags: [orders]
      summary: Get an order
      description: Returns one order with its line items, totals and status.
      responses:
        '200':
          description: The order.
          content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } }
        '404': { description: No such order. }
    patch:
      operationId: updateOrder
      tags: [orders]
      summary: Update an order
      description: Changes the shipping address or the note of an order that has not shipped yet.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                shippingAddress: { $ref: '#/components/schemas/Address' }
                note: { type: string, maxLength: 500, description: Internal note shown to support agents. }
      responses:
        '200':
          description: The updated order.
          content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } }
  /orders/{orderId}/cancel:
    parameters:
      - { $ref: '#/components/parameters/OrderId' }
    post:
      operationId: cancelOrder
      tags: [orders]
      summary: Cancel an order
      description: Cancels an order that has not shipped. Paid orders are refunded in full automatically.
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                reason: { type: string, enum: [customer_request, out_of_stock, fraud, other], description: Why the order is cancelled. }
      responses:
        '200':
          description: The cancelled order.
          content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } }
  /orders/{orderId}/refunds:
    parameters:
      - { $ref: '#/components/parameters/OrderId' }
    get:
      operationId: listOrderRefunds
      tags: [refunds]
      summary: List refunds of an order
      description: Lists the refunds issued for one order.
      responses:
        '200':
          description: Refunds.
          content:
            application/json:
              schema:
                type: object
                required: [items]
                properties:
                  items: { type: array, items: { $ref: '#/components/schemas/Refund' } }
    post:
      operationId: createRefund
      tags: [refunds]
      summary: Refund an order
      description: Refunds part or all of a paid order. The amount cannot exceed what is left to refund.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount, reason]
              properties:
                amount: { type: number, minimum: 0.01, description: Amount to refund, in the order currency. }
                reason: { type: string, enum: [damaged, not_received, wrong_item, goodwill], description: Why the money is returned. }
      responses:
        '201':
          description: The refund.
          content: { application/json: { schema: { $ref: '#/components/schemas/Refund' } } }
  /customers:
    get:
      operationId: listCustomers
      tags: [customers]
      summary: List customers
      description: Lists customers. Search by name or email with q.
      parameters:
        - { name: q, in: query, description: Text to match in the name or email., schema: { type: string } }
        - { $ref: '#/components/parameters/Limit' }
        - { $ref: '#/components/parameters/Cursor' }
      responses:
        '200':
          description: A page of customers.
          content:
            application/json:
              schema:
                type: object
                required: [items]
                properties:
                  items: { type: array, items: { $ref: '#/components/schemas/Customer' } }
                  nextCursor: { type: [string, 'null'] }
    post:
      operationId: createCustomer
      tags: [customers]
      summary: Create a customer
      description: Creates a customer account.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, email]
              properties:
                name: { type: string, description: Full name. }
                email: { type: string, format: email, description: Contact email, unique per customer. }
                phone: { type: string, description: Phone number in E.164 format. }
      responses:
        '201':
          description: The customer.
          content: { application/json: { schema: { $ref: '#/components/schemas/Customer' } } }
  /customers/{customerId}:
    parameters:
      - { name: customerId, in: path, required: true, description: The customer id., schema: { type: string } }
    get:
      operationId: getCustomer
      tags: [customers]
      summary: Get a customer
      description: Returns one customer with their lifetime order count and spend.
      responses:
        '200':
          description: The customer.
          content: { application/json: { schema: { $ref: '#/components/schemas/Customer' } } }
        '404': { description: No such customer. }
  /shipments:
    get:
      operationId: listShipments
      tags: [shipments]
      summary: List shipments
      description: Lists shipments, optionally only those of one order.
      parameters:
        - { name: orderId, in: query, description: Only shipments of this order., schema: { type: string } }
        - { $ref: '#/components/parameters/Limit' }
      responses:
        '200':
          description: Shipments.
          content:
            application/json:
              schema:
                type: object
                required: [items]
                properties:
                  items: { type: array, items: { $ref: '#/components/schemas/Shipment' } }
  /shipments/{shipmentId}:
    parameters:
      - { name: shipmentId, in: path, required: true, description: The shipment id., schema: { type: string } }
    get:
      operationId: getShipment
      tags: [shipments]
      summary: Track a shipment
      description: Returns the carrier, tracking number and delivery status of a shipment.
      responses:
        '200':
          description: The shipment.
          content: { application/json: { schema: { $ref: '#/components/schemas/Shipment' } } }
        '404': { description: No such shipment. }
  /products:
    get:
      operationId: listProducts
      tags: [products]
      summary: List products
      description: Lists products in the catalog with price and stock.
      parameters:
        - { name: q, in: query, description: Text to match in the product name or SKU., schema: { type: string } }
        - { $ref: '#/components/parameters/Limit' }
      responses:
        '200':
          description: Products.
          content:
            application/json:
              schema:
                type: object
                required: [items]
                properties:
                  items: { type: array, items: { $ref: '#/components/schemas/Product' } }
  /products/{sku}:
    parameters:
      - { name: sku, in: path, required: true, description: The product SKU., schema: { type: string } }
    get:
      operationId: getProduct
      tags: [products]
      summary: Get a product
      description: Returns one product with its price and stock level.
      responses:
        '200':
          description: The product.
          content: { application/json: { schema: { $ref: '#/components/schemas/Product' } } }
        '404': { description: No such product. }
components:
  parameters:
    OrderId: { name: orderId, in: path, required: true, description: The order id., schema: { type: string } }
    Limit: { name: limit, in: query, description: Page size (default 20)., schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
    Cursor: { name: cursor, in: query, description: Cursor from the previous page's nextCursor., schema: { type: string } }
  schemas:
    OrderStatus: { type: string, enum: [pending, paid, shipped, delivered, cancelled, refunded] }
    Address:
      type: object
      required: [line1, city, postalCode, country]
      properties:
        line1: { type: string }
        line2: { type: string }
        city: { type: string }
        postalCode: { type: string }
        country: { type: string, description: ISO 3166-1 alpha-2 country code. }
    LineItem:
      type: object
      required: [sku, quantity]
      properties:
        sku: { type: string }
        quantity: { type: integer, minimum: 1 }
        unitPrice: { type: number, readOnly: true }
    OrderCreate:
      type: object
      required: [customerId, items]
      properties:
        customerId: { type: string, description: The customer who places the order. }
        items: { type: array, minItems: 1, items: { $ref: '#/components/schemas/LineItem' } }
        shippingAddress: { $ref: '#/components/schemas/Address' }
    Order:
      type: object
      required: [id, customerId, status, total, currency, createdAt]
      properties:
        id: { type: string }
        customerId: { type: string }
        status: { $ref: '#/components/schemas/OrderStatus' }
        items: { type: array, items: { $ref: '#/components/schemas/LineItem' } }
        total: { type: number }
        currency: { type: string, example: EUR }
        shippingAddress: { $ref: '#/components/schemas/Address' }
        note: { type: string }
        createdAt: { type: string, format: date-time }
    Customer:
      type: object
      required: [id, name, email]
      properties:
        id: { type: string }
        name: { type: string }
        email: { type: string, format: email }
        phone: { type: string }
        orderCount: { type: integer }
        lifetimeSpend: { type: number }
        createdAt: { type: string, format: date-time }
    Refund:
      type: object
      required: [id, orderId, amount, status]
      properties:
        id: { type: string }
        orderId: { type: string }
        amount: { type: number }
        reason: { type: string }
        status: { type: string, enum: [pending, succeeded, failed] }
        createdAt: { type: string, format: date-time }
    Shipment:
      type: object
      required: [id, orderId, carrier, status]
      properties:
        id: { type: string }
        orderId: { type: string }
        carrier: { type: string, enum: [dhl, ups, posti, fedex] }
        trackingNumber: { type: string }
        status: { type: string, enum: [label_created, in_transit, out_for_delivery, delivered, exception] }
        estimatedDelivery: { type: string, format: date }
    Product:
      type: object
      required: [sku, name, price]
      properties:
        sku: { type: string }
        name: { type: string }
        price: { type: number }
        currency: { type: string }
        stock: { type: integer }
`;
