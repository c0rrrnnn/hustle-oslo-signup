import { hmacSha256Hex, timingSafeEqual } from "./crypto.ts";

export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2024-06-20";

export interface StripeIntent {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  client_secret?: string;
  metadata?: { orderId?: string };
  last_payment_error?: { code?: string; message?: string; decline_code?: string } | null;
  payment_method?: string | StripePaymentMethod | null;
}

export interface StripePaymentMethod {
  type?: string;
  card?: { wallet?: { type?: string } | null } | null;
}

export type StripeDecision =
  | { action: "paid"; paymentId: string }
  | { action: "failed"; reason: string }
  | { action: "pending"; reason: string };

/**
 * Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]
 * Signed payload is `${t}.${rawBody}`. Reject timestamps outside the tolerance.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret || !payload) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

/** Trust the retrieved PaymentIntent, not the webhook body. */
export function decideStripe(
  intent: StripeIntent | null,
  order: { orderId: string; amountMinor: number; paymentId: string | null },
): StripeDecision {
  if (!intent?.id) return { action: "pending", reason: "missing-intent" };
  if (intent.metadata?.orderId && intent.metadata.orderId !== order.orderId) {
    return { action: "failed", reason: "order-mismatch" };
  }
  if (order.paymentId && intent.id !== order.paymentId) {
    return { action: "failed", reason: "intent-mismatch" };
  }
  if (String(intent.currency || "").toLowerCase() !== "nok") {
    return { action: "failed", reason: "currency" };
  }
  if (intent.amount !== order.amountMinor) return { action: "failed", reason: "amount-mismatch" };
  if (intent.status === "succeeded") return { action: "paid", paymentId: intent.id };
  if (intent.status === "canceled") return { action: "failed", reason: "canceled" };
  if (intent.status === "requires_payment_method" && intent.last_payment_error) {
    const code = intent.last_payment_error.decline_code || intent.last_payment_error.code || "declined";
    return { action: "failed", reason: String(code).slice(0, 40) };
  }
  return { action: "pending", reason: intent.status || "pending" };
}

/** Card, or the wallet Stripe recorded on that card. A bare payment-method id is not enough. */
export function stripePayMethod(intent: StripeIntent | null): "card" | "apple" | "google" | null {
  const method = intent?.payment_method;
  if (!method || typeof method === "string") return null;
  const wallet = method.card?.wallet?.type;
  if (wallet === "apple_pay") return "apple";
  if (wallet === "google_pay") return "google";
  if (method.type === "card") return "card";
  return null;
}

export function assertStripeTestKey(secretKey: string, publishableKey: string): string | null {
  if (!secretKey.startsWith("sk_test_")) return "Stripe secret key must be a test key (sk_test_).";
  if (!publishableKey.startsWith("pk_test_")) return "Stripe publishable key must be a test key (pk_test_).";
  return null;
}

/**
 * Live Stripe keys work only when allowLive is true, and the secret and
 * publishable key must be the same mode. The deployed config leaves allowLive false.
 */
export function paymentsModeError(allowLive: boolean, secretKey: string, publishableKey: string): string | null {
  if (!allowLive) return assertStripeTestKey(secretKey, publishableKey);
  const secretLive = secretKey.startsWith("sk_live_");
  const secretTest = secretKey.startsWith("sk_test_");
  const pubLive = publishableKey.startsWith("pk_live_");
  const pubTest = publishableKey.startsWith("pk_test_");
  if ((!secretLive && !secretTest) || (!pubLive && !pubTest)) {
    return "Stripe keys must be a test pair or a live pair.";
  }
  if (secretLive !== pubLive) return "Stripe secret and publishable keys must both be live or both be test.";
  return null;
}

function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export async function createPaymentIntent(
  fetcher: typeof fetch,
  secretKey: string,
  input: { amountMinor: number; orderId: string; receiptEmail: string; description: string; method: string },
): Promise<StripeIntent> {
  const response = await fetcher(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_VERSION,
      "Idempotency-Key": input.orderId,
    },
    body: formEncode({
      amount: String(input.amountMinor),
      currency: "nok",
      // Card plus Apple Pay and Google Pay. Stripe rejects this together with payment_method_types.
      "automatic_payment_methods[enabled]": "true",
      capture_method: "automatic",
      description: input.description.slice(0, 200),
      receipt_email: input.receiptEmail,
      "metadata[orderId]": input.orderId,
      "metadata[method]": input.method,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as StripeIntent & { error?: { message?: string } };
  if (!response.ok || !payload.id || !payload.client_secret) {
    throw new Error(payload.error?.message || `Stripe create failed (${response.status})`);
  }
  return payload;
}

export async function retrievePaymentIntent(
  fetcher: typeof fetch,
  secretKey: string,
  paymentIntentId: string,
): Promise<StripeIntent> {
  const response = await fetcher(
    `${STRIPE_API}/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=payment_method`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": STRIPE_VERSION,
      },
    },
  );
  const payload = (await response.json().catch(() => ({}))) as StripeIntent & { error?: { message?: string } };
  if (!response.ok || !payload.id) {
    throw new Error(payload.error?.message || `Stripe retrieve failed (${response.status})`);
  }
  return payload;
}
