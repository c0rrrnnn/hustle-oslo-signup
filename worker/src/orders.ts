import type { CheckoutInput, OrderKv, OrderStatus, StoredOrder } from "./types.ts";

export function orderKey(orderId: string): string {
  return `order:${orderId}`;
}

export function unpostedKey(orderId: string): string {
  return `unposted:${orderId}`;
}

export function pendingVippsKey(orderId: string): string {
  return `pending-vipps:${orderId}`;
}

/** Provider success written before the order row, so a racing failure can restore it. */
export function checkoutOkKey(orderId: string): string {
  return `checkout-ok:${orderId}`;
}

export async function listPrefixedIds(kv: OrderKv, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const key of page.keys) {
      if (key.name.startsWith(prefix)) ids.push(key.name.slice(prefix.length));
    }
    if (page.list_complete || !page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor);
  return ids;
}

export async function listUnpostedOrderIds(kv: OrderKv): Promise<string[]> {
  return listPrefixedIds(kv, "unposted:");
}

export async function getOrder(kv: OrderKv, orderId: string): Promise<StoredOrder | null> {
  const raw = await kv.get(orderKey(orderId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredOrder;
  } catch {
    return null;
  }
}

export async function putOrder(kv: OrderKv, order: StoredOrder): Promise<void> {
  await kv.put(orderKey(order.orderId), JSON.stringify(order));
}

export function checkoutFingerprint(input: { provider: string; nights: { eventId: string; ticketId: string; priceTier: string }[] }): string {
  const nights = input.nights
    .map((night) => `${night.eventId}|${night.ticketId}|${night.priceTier}`)
    .sort()
    .join(",");
  return `${input.provider}|${nights}`;
}

export function canMarkPaid(gates: { webhookVerified: boolean; serverConfirmed: boolean }): boolean {
  return gates.webhookVerified === true && gates.serverConfirmed === true;
}

export function newOrder(input: CheckoutInput, captureMode: StoredOrder["captureMode"], nowIso: string): StoredOrder {
  return {
    orderId: input.idempotencyKey,
    fingerprint: checkoutFingerprint({
      provider: input.method === "vipps" ? "vipps" : "stripe",
      nights: input.nights,
    }),
    status: "pending",
    currency: "NOK",
    amountNok: input.amountNok,
    amountMinor: input.amountMinor,
    provider: input.method === "vipps" ? "vipps" : "stripe",
    method: input.method,
    paymentId: null,
    clientSecret: null,
    redirectUrl: null,
    customer: input.customer,
    nights: input.nights,
    meta: input.meta,
    captureMode,
    returnUrl: input.returnUrl,
    createdAt: nowIso,
    updatedAt: nowIso,
    paidAt: null,
    providerStatus: null,
    appsScriptPosted: false,
    appsScriptPostedNights: 0,
    appsScriptAttempts: 0,
    appsScriptNextAttemptAt: null,
    appsScriptLeaseUntil: null,
    appsScriptLeaseToken: null,
    checkoutLeaseUntil: null,
    checkoutLeaseToken: null,
    vippsCheckedAt: null,
    confirmationSent: false,
    failureReason: null,
  };
}

export async function saveStatus(
  kv: OrderKv,
  order: StoredOrder,
  status: OrderStatus,
  providerStatus: string,
  nowIso: string,
  failureReason: string | null = null,
): Promise<StoredOrder> {
  const current = (await getOrder(kv, order.orderId)) || order;
  if (current.status === "paid") return current;
  current.status = status;
  current.providerStatus = providerStatus;
  current.failureReason = failureReason;
  current.updatedAt = nowIso;
  await putOrder(kv, current);
  return current;
}

/**
 * The only writer that sets status to paid. Both gates must already be true.
 * The Apps Script write is separate: a paid order with appsScriptPosted false
 * stays on the unposted index until that write is confirmed.
 */
export async function markOrderPaid(
  kv: OrderKv,
  order: StoredOrder,
  paymentId: string,
  providerStatus: string,
  gates: { webhookVerified: boolean; serverConfirmed: boolean },
  nowIso: string,
): Promise<StoredOrder> {
  const current = (await getOrder(kv, order.orderId)) || order;
  if (!canMarkPaid(gates)) return current;
  if (current.status !== "paid") {
    current.status = "paid";
    current.paymentId = paymentId || current.paymentId;
    current.providerStatus = providerStatus;
    current.paidAt = current.paidAt || nowIso;
    current.failureReason = null;
    current.updatedAt = nowIso;
    await putOrder(kv, current);
  }
  if (!current.appsScriptPosted) await kv.put(unpostedKey(current.orderId), current.orderId);
  return current;
}
