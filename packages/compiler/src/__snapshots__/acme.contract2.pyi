# acme.pyi  (generated; Neurouter compiler 0.1.0; contract 2)
# Call as acme.<function>(name=value, ...): keyword arguments only; results are plain data (whole values, no cuts).
# Lists: acme.<fn>.pages(..., max_items=500) → all items; acme.<fn>.page(...) → Result(.data, .items, .page, .next()).
# Errors: except NotFound / InvalidArgs / Forbidden / WritesDisabled / ConfirmationRequired / RateLimited / Timeout / UpstreamError, or ToolError for all; ops.error(e) → {code, message, next, fields, retry, …}.
# Built-ins: len, range, enumerate, zip, sorted, reversed, min, max, sum, any, all, abs, round, divmod, pow, int, float, str, bool, list, dict, set, frozenset, tuple, isinstance, type, iter, next, repr, chr, ord, hex, print, getattr, hasattr (type takes one argument). No map/filter (use comprehensions); tool results are dicts/lists (d["key"]).
from typing import Any, Literal, NotRequired, TypedDict

class LineItem(TypedDict):
    sku: str
    quantity: int
    unitPrice: NotRequired[float]

class Address(TypedDict):
    line1: str
    line2: NotRequired[str]
    city: str
    postalCode: str
    country: str

class Order(TypedDict):
    id: str
    customerId: str
    status: Literal["pending", "paid", "shipped", "delivered", "cancelled", "refunded"]
    items: NotRequired[list[LineItem]]
    total: float
    currency: str
    shippingAddress: NotRequired[Address]
    note: NotRequired[str]
    createdAt: str

class ListOrdersResult(TypedDict):
    items: list[Order]
    nextCursor: NotRequired[str | None]

class LineItem2(TypedDict):
    sku: str
    quantity: int

class Refund(TypedDict):
    id: str
    orderId: str
    amount: float
    reason: NotRequired[str]
    status: Literal["pending", "succeeded", "failed"]
    createdAt: NotRequired[str]

class ListOrderRefundsResult(TypedDict):
    items: list[Refund]

class Customer(TypedDict):
    id: str
    name: str
    email: str
    phone: NotRequired[str]
    orderCount: NotRequired[int]
    lifetimeSpend: NotRequired[float]
    createdAt: NotRequired[str]

class ListCustomersResult(TypedDict):
    items: list[Customer]
    nextCursor: NotRequired[str | None]

class Shipment(TypedDict):
    id: str
    orderId: str
    carrier: Literal["dhl", "ups", "posti", "fedex"]
    trackingNumber: NotRequired[str]
    status: Literal["label_created", "in_transit", "out_for_delivery", "delivered", "exception"]
    estimatedDelivery: NotRequired[str]

class ListShipmentsResult(TypedDict):
    items: list[Shipment]

class Product(TypedDict):
    sku: str
    name: str
    price: float
    currency: NotRequired[str]
    stock: NotRequired[int]

class ListProductsResult(TypedDict):
    items: list[Product]

def list_orders(*, status: Literal["pending", "paid", "shipped", "delivered", "cancelled", "refunded"] | None = None, customer_id: str | None = None, limit: int = 20, cursor: str | None = None) -> ListOrdersResult:
    """Lists orders, newest first.

    Args:
        status (Literal["pending", "paid", "shipped", "delivered", "cancelled", "refunded"]): Only orders in this status.
        customer_id (str): Only orders of this customer.
        limit (int, 1..100, default 20): Page size (default 20).
        cursor (str): Cursor from the previous page's nextCursor.

    Returns:
        A dict with "items" (list) and nextCursor; each item has id, customerId, status, items, total, currency, shippingAddress, note, createdAt.

    Raises:
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        acme.list_orders.pages(..., max_items=500) returns the items of every page (one call per page);
        acme.list_orders.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        acme.list_orders(limit=5)"""

def create_order(*, customer_id: str, items: list[LineItem2], shipping_address: Address | None = None) -> dict[str, Any]:
    """Creates a pending order for a customer with one or more line items.

    Args:
        customer_id (str, required): The customer who places the order.
        items (list[LineItem2], required)
        shipping_address (Address)

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        acme.create_order(customer_id="customer_1", items=[{"sku": "product_1", "quantity": 1}])"""

def get_order(*, order_id: str) -> Order:
    """Returns one order with its line items, totals and status.

    Args:
        order_id (str, required): The order id.

    Returns:
        A dict with id, customerId, status, items, total, currency, shippingAddress, note, createdAt.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        acme.get_order(order_id="order_1")"""

def update_order(*, order_id: str, shipping_address: Address | None = None, note: str | None = None) -> dict[str, Any]:
    """Changes the shipping address or the note of an order that has not shipped yet.

    Args:
        order_id (str, required): The order id.
        shipping_address (Address)
        note (str, ≤ 500 chars): Internal note shown to support agents.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        acme.update_order(order_id="order_1")"""

def cancel_order(*, order_id: str, reason: Literal["customer_request", "out_of_stock", "fraud", "other"] | None = None) -> dict[str, Any]:
    """Cancels an order that has not shipped.

    Args:
        order_id (str, required): The order id.
        reason (Literal["customer_request", "out_of_stock", "fraud", "other"]): Why the order is cancelled.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.
        ConfirmationRequired: not in the confirmed plan; ops.error(e)["plan"] says what it would change.

    Writes:
        Irreversible. run_script(mode="dry_run") plans it without calling the API; outside prod the run then needs the confirm token from that dry run.

    Example:
        acme.cancel_order(order_id="order_1")"""

def list_order_refunds(*, order_id: str) -> ListOrderRefundsResult:
    """Lists the refunds issued for one order.

    Args:
        order_id (str, required): The order id.

    Returns:
        A dict with "items" (list); each item has id, orderId, amount, reason, status, createdAt.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        acme.list_order_refunds.pages(..., max_items=500) returns the items of every page (one call per page);
        acme.list_order_refunds.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        acme.list_order_refunds(order_id="order_1")"""

def create_refund(*, order_id: str, amount: float, reason: Literal["damaged", "not_received", "wrong_item", "goodwill"]) -> dict[str, Any]:
    """Refunds part or all of a paid order.

    Args:
        order_id (str, required): The order id.
        amount (float, required, ≥ 0.01): Amount to refund
        reason (Literal["damaged", "not_received", "wrong_item", "goodwill"], required): Why the money is returned.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.
        ConfirmationRequired: not in the confirmed plan; ops.error(e)["plan"] says what it would change.

    Writes:
        Irreversible. run_script(mode="dry_run") plans it without calling the API; outside prod the run then needs the confirm token from that dry run.

    Example:
        acme.create_refund(order_id="order_1", amount=0.01, reason="damaged")"""

def list_customers(*, q: str | None = None, limit: int = 20, cursor: str | None = None) -> ListCustomersResult:
    """Lists customers.

    Args:
        q (str): Text to match in the name or email.
        limit (int, 1..100, default 20): Page size (default 20).
        cursor (str): Cursor from the previous page's nextCursor.

    Returns:
        A dict with "items" (list) and nextCursor; each item has id, name, email, phone, orderCount, lifetimeSpend, createdAt.

    Raises:
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        acme.list_customers.pages(..., max_items=500) returns the items of every page (one call per page);
        acme.list_customers.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        acme.list_customers(limit=5)"""

def create_customer(*, name: str, email: str, phone: str | None = None) -> dict[str, Any]:
    """Creates a customer account.

    Args:
        name (str, required): Full name.
        email (str, required, email): Contact email
        phone (str): Phone number in E.164 format.

    Returns:
        The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.

    Raises:
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.
        WritesDisabled: writes are off in this environment.

    Writes:
        run_script(mode="dry_run") plans it without calling the API.

    Example:
        acme.create_customer(name="Example", email="ada@example.com")"""

def get_customer(*, customer_id: str) -> Customer:
    """Returns one customer with their lifetime order count and spend.

    Args:
        customer_id (str, required): The customer id.

    Returns:
        A dict with id, name, email, phone, orderCount, lifetimeSpend, createdAt.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        acme.get_customer(customer_id="customer_1")"""

def list_shipments(*, order_id: str | None = None, limit: int = 20) -> ListShipmentsResult:
    """Lists shipments, optionally only those of one order.

    Args:
        order_id (str): Only shipments of this order.
        limit (int, 1..100, default 20): Page size (default 20).

    Returns:
        A dict with "items" (list); each item has id, orderId, carrier, trackingNumber, status, estimatedDelivery.

    Raises:
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        acme.list_shipments.pages(..., max_items=500) returns the items of every page (one call per page);
        acme.list_shipments.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        acme.list_shipments(limit=5)"""

def get_shipment(*, shipment_id: str) -> Shipment:
    """Returns the carrier, tracking number and delivery status of a shipment.

    Args:
        shipment_id (str, required): The shipment id.

    Returns:
        A dict with id, orderId, carrier, trackingNumber, status, estimatedDelivery.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        acme.get_shipment(shipment_id="shipment_1")"""

def list_products(*, q: str | None = None, limit: int = 20) -> ListProductsResult:
    """Lists products in the catalog with price and stock.

    Args:
        q (str): Text to match in the product name or SKU.
        limit (int, 1..100, default 20): Page size (default 20).

    Returns:
        A dict with "items" (list); each item has sku, name, price, currency, stock.

    Raises:
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Pages:
        acme.list_products.pages(..., max_items=500) returns the items of every page (one call per page);
        acme.list_products.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().

    Example:
        acme.list_products(limit=5)"""

def get_product(*, sku: str) -> Product:
    """Returns one product with its price and stock level.

    Args:
        sku (str, required): The product SKU.

    Returns:
        A dict with sku, name, price, currency, stock.

    Raises:
        NotFound: no such id; ops.error(e)["next"] is the list call.
        InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.

    Example:
        acme.get_product(sku="product_1")"""
