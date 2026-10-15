import { appsScriptBodies, postPaidBooking } from "./apps-script.ts";
import { timingSafeEqual } from "./crypto.ts";
import { markOrderPaid, newOrder, putOrder, saveStatus, getOrder } from "./orders.ts";
import { priceOrder } from "./pricing.ts";
import { assertStripeTestKey, createPaymentIntent, decideStripe, retrievePaymentIntent, verifyStripeSignature } from "./stripe.ts";
import type { CaptureMode, CheckoutInput, Deps, Env, PayMethod, SignupMeta, StoredOrder } from "./types.ts";
import {
  captureVippsPayment,
  clearVippsTokenCache,
  createVippsPayment,
  getVippsPayment,
  interpretVipps,
  type VippsCreds,
  type VippsPayment,
} from "./vipps.ts";

export { appsScriptBodies, clearVippsTokenCache };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHODS = new Set(["card", "apple", "google", "vipps"]);
const MAX_BODY = 65_536;

export function captureModeOf(env: Env): CaptureMode {
  return env.CAPTURE_MODE === "reserve" ? "reserve" : "immediate";
}

function allowedOrigins(env: Env): string[] {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin") || "";
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function json(status: number, body: unknown, cors: Headers): Response {
  const headers = new Headers(cors);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function clip(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, max);
}

function emailOk(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200;
}

function testModeError(env: Env): string | null {
  return assertStripeTestKey(env.STRIPE_SECRET_KEY || "", env.STRIPE_PUBLISHABLE_KEY || "");
}

function vippsCreds(env: Env): VippsCreds {
  return {
    clientId: env.VIPPS_CLIENT_ID,
    clientSecret: env.VIPPS_CLIENT_SECRET,
    subscriptionKey: env.VIPPS_SUBSCRIPTION_KEY,
    msn: env.VIPPS_MSN,
  };
}

function returnUrlFor(env: Env, requested: string, orderId: string): string {
  const allowed = new Set(allowedOrigins(env));
  let origin = "";
  let path = "/";
  try {
    const url = new URL(requested);
    if (allowed.has(url.origin)) {
      origin = url.origin;
      path = url.pathname || "/";
    }
  } catch {
    origin = "";
  }
  if (!origin) {
    const fallback = new URL(env.PUBLIC_SITE_URL);
    origin = fallback.origin;
    path = "/";
  }
  return `${origin}${path}?order=${orderId}`;
}

function publicOrder(order: StoredOrder) {
  return {
    ok: true,
    orderId: order.orderId,
    status: order.status,
    currency: order.currency,
    amountNok: order.amountNok,
    provider: order.provider,
    method: order.method,
    paymentId: order.status === "paid" ? order.paymentId : null,
    appsScriptPosted: order.appsScriptPosted,
    confirmationSent: order.confirmationSent,
    failureReason: order.status === "failed" ? order.failureReason : null,
    customer: { email: order.customer.email, fullName: order.customer.fullName },
    nights: order.nights.map((night) => ({
      eventId: night.eventId,
      eventDate: night.eventDate,
      ticketId: night.ticketId,
      ticketName: night.ticketName,
      priceTier: night.priceTier,
      amount: night.amount,
    })),
  };
}

function checkoutResponse(order: StoredOrder, env: Env, cors: Headers, replay: boolean): Response {
  return json(
    200,
    {
      ok: true,
      replay,
      orderId: order.orderId,
      provider: order.provider,
      amountNok: order.amountNok,
      currency: "NOK",
      publishableKey: order.provider === "stripe" ? env.STRIPE_PUBLISHABLE_KEY : null,
      clientSecret: order.status === "pending" && order.provider === "stripe" ? order.clientSecret : null,
      redirectUrl: order.status === "pending" && order.provider === "vipps" ? order.redirectUrl : null,
      status: order.status,
      paymentId: order.status === "paid" ? order.paymentId : null,
      appsScriptPosted: order.appsScriptPosted,
      confirmationSent: order.confirmationSent,
    },
    cors,
  );
}

function readMeta(body: Record<string, unknown>, nowIso: string): SignupMeta {
  return {
    experience: clip(body.experience, 40),
    experienceLabel: clip(body.experienceLabel, 120),
    referral: clip(body.referral, 40),
    referralLabel: clip(body.referralLabel, 120),
    referralOther: clip(body.referralOther, 200),
    howFound: clip(body.howFound, 40),
    howFoundLabel: clip(body.howFoundLabel, 120),
    howFoundOther: clip(body.howFoundOther, 200),
    isRepeat: body.isRepeat === true,
    termsAcceptedAt: clip(body.termsAcceptedAt, 40) || nowIso,
    termsVersion: clip(body.termsVersion, 20) || "v1.0",
  };
}

function paymentDescription(order: StoredOrder): string {
  const dates = order.nights.map((night) => night.eventDate).join(", ");
  return `Hustle Oslo ${dates}`.slice(0, 100);
}

async function beginCheckout(request: Request, env: Env, deps: Deps, cors: Headers): Promise<Response> {
  const modeError = testModeError(env);
  if (modeError) return json(403, { ok: false, error: "test-mode", message: modeError }, cors);
  if (!env.ORDERS) return json(500, { ok: false, error: "kv-missing" }, cors);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "too-large" }, cors);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, error: "invalid-json" }, cors);
  }
  const idempotencyKey = clip(body.idempotencyKey, 80);
  if (!UUID.test(idempotencyKey)) {
    return json(400, { ok: false, error: "bad-idempotency-key", message: "Check your booking and try again." }, cors);
  }
  const method = clip(body.method, 20) as PayMethod;
  if (!METHODS.has(method)) return json(400, { ok: false, error: "bad-method" }, cors);
  if (body.termsAccepted !== true) return json(400, { ok: false, error: "terms", message: "Accept the terms to pay." }, cors);
  const customerRaw = (body.customer && typeof body.customer === "object" ? body.customer : {}) as Record<string, unknown>;
  const customer = {
    fullName: clip(customerRaw.fullName, 120),
    email: clip(customerRaw.email, 200).toLowerCase(),
    phone: clip(customerRaw.phone, 40),
  };
  if (customer.fullName.length < 2 || !emailOk(customer.email)) {
    return json(400, { ok: false, error: "customer", message: "Check your name and email." }, cors);
  }
  const now = (deps.now || (() => new Date()))();
  const nightsRaw = Array.isArray(body.nights) ? (body.nights as { eventId?: string; ticketId?: string; priceTier?: string }[]) : [];
  const priced = priceOrder(
    nightsRaw.map((night) => ({
      eventId: String(night?.eventId || ""),
      ticketId: String(night?.ticketId || ""),
      priceTier: night?.priceTier,
    })),
    now,
    body.amount,
  );
  if (!priced.ok) return json(400, { ok: false, error: "price", message: priced.error }, cors);

  const input: CheckoutInput = {
    idempotencyKey,
    method,
    customer,
    nights: priced.nights,
    amountNok: priced.amountNok,
    amountMinor: priced.amountMinor,
    meta: readMeta(body, now.toISOString()),
    returnUrl: returnUrlFor(env, clip(body.returnUrl, 300), idempotencyKey),
  };
  const order = newOrder(input, captureModeOf(env), now.toISOString());
  const existing = await getOrder(env.ORDERS, order.orderId);
  if (existing) {
    if (existing.fingerprint !== order.fingerprint) {
      return json(409, { ok: false, error: "idempotency-conflict", message: "This checkout doesn’t match the original order. Start again." }, cors);
    }
    if (existing.clientSecret || existing.redirectUrl || existing.status === "paid" || existing.status === "reserved") {
      existing.customer = order.customer;
      existing.meta = order.meta;
      existing.updatedAt = now.toISOString();
      await putOrder(env.ORDERS, existing);
      return checkoutResponse(existing, env, cors, true);
    }
  } else {
    await putOrder(env.ORDERS, order);
  }
  const current = (await getOrder(env.ORDERS, order.orderId)) || order;
  current.customer = order.customer;
  current.meta = order.meta;
  current.returnUrl = order.returnUrl;
  current.status = "pending";
  current.failureReason = null;
  const fetcher = deps.fetch || fetch;
  try {
    if (current.provider === "stripe") {
      const intent = await createPaymentIntent(fetcher, env.STRIPE_SECRET_KEY, {
        amountMinor: current.amountMinor,
        orderId: current.orderId,
        receiptEmail: current.customer.email,
        description: paymentDescription(current),
        method: current.method,
      });
      current.paymentId = intent.id || null;
      current.clientSecret = intent.client_secret || null;
      current.providerStatus = intent.status || "requires_payment_method";
    } else {
      const created = await createVippsPayment(
        fetcher,
        vippsCreds(env),
        {
          reference: current.orderId,
          amountMinor: current.amountMinor,
          returnUrl: current.returnUrl,
          description: paymentDescription(current),
          phone: current.customer.phone,
        },
        now.getTime(),
      );
      current.paymentId = created.reference;
      current.redirectUrl = created.redirectUrl;
      current.providerStatus = "created";
    }
  } catch {
    current.status = "failed";
    current.failureReason = "provider";
    current.updatedAt = now.toISOString();
    await putOrder(env.ORDERS, current);
    console.info(JSON.stringify({ msg: "checkout-provider-failed", orderId: current.orderId, provider: current.provider }));
    return json(502, {
      ok: false,
      error: "provider",
      message: "Payment didn’t go through. You haven’t been charged. Try again or pick another method.",
    }, cors);
  }
  current.updatedAt = now.toISOString();
  await putOrder(env.ORDERS, current);
  return checkoutResponse(current, env, cors, false);
}

async function postBooking(env: Env, deps: Deps, order: StoredOrder) {
  const fetcher = deps.fetch || fetch;
  return postPaidBooking(fetcher, env.APPS_SCRIPT_URL, order, env.APPS_SCRIPT_SHARED_SECRET);
}

async function onStripeWebhook(request: Request, env: Env, deps: Deps, cors: Headers): Promise<Response> {
  const modeError = testModeError(env);
  if (modeError) return json(403, { ok: false, error: "test-mode", message: modeError }, cors);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "too-large" }, cors);
  const now = (deps.now || (() => new Date()))();
  const verified = await verifyStripeSignature(
    raw,
    request.headers.get("stripe-signature"),
    env.STRIPE_WEBHOOK_SECRET || "",
    300,
    Math.floor(now.getTime() / 1000),
  );
  if (!verified) return json(400, { ok: false, error: "invalid-signature" }, cors);
  let event: { type?: string; data?: { object?: { id?: string; metadata?: { orderId?: string } } } };
  try {
    event = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "invalid-json" }, cors);
  }
  const type = event.type || "";
  if (!type.startsWith("payment_intent.")) return json(200, { ok: true, ignored: true }, cors);
  const orderId = event.data?.object?.metadata?.orderId || "";
  const hintedId = event.data?.object?.id || "";
  if (!orderId) return json(200, { ok: true, ignored: true }, cors);
  const order = await getOrder(env.ORDERS, orderId);
  if (!order || order.provider !== "stripe") return json(200, { ok: true, ignored: true }, cors);
  const paymentIntentId = order.paymentId || hintedId;
  if (!paymentIntentId) return json(200, { ok: true, ignored: true }, cors);
  const fetcher = deps.fetch || fetch;
  let intent;
  try {
    intent = await retrievePaymentIntent(fetcher, env.STRIPE_SECRET_KEY, paymentIntentId);
  } catch (error) {
    console.info(JSON.stringify({ msg: "stripe-retrieve-failed", orderId }));
    return json(500, { ok: false, error: error instanceof Error ? error.message : "stripe-retrieve" }, cors);
  }
  const decision = decideStripe(intent, order);
  if (decision.action === "paid") {
    const updated = await markOrderPaid(
      env.ORDERS,
      order,
      decision.paymentId,
      "succeeded",
      { webhookVerified: true, serverConfirmed: true },
      now.toISOString(),
      (current) => postBooking(env, deps, current),
    );
    if (!updated.appsScriptPosted) return json(500, { ok: false, error: updated.failureReason || "apps-script" }, cors);
    return json(200, { ok: true, status: "paid" }, cors);
  }
  if (decision.action === "failed") {
    await saveStatus(env.ORDERS, order, "failed", decision.reason, now.toISOString(), decision.reason);
  }
  return json(200, { ok: true, status: decision.action, reason: decision.reason }, cors);
}

async function settleVipps(
  env: Env,
  deps: Deps,
  order: StoredOrder,
  payment: VippsPayment,
  now: Date,
  forceCapture = false,
): Promise<{ response: Response; order: StoredOrder }> {
  const cors = new Headers();
  const view = interpretVipps(payment, order.amountMinor);
  if (view.kind === "mismatch" || view.kind === "failed") {
    const updated = await saveStatus(env.ORDERS, order, "failed", view.reason, now.toISOString(), view.reason);
    return { order: updated, response: json(200, { ok: true, status: "failed", reason: view.reason }, cors) };
  }
  if (view.kind === "captured") {
    const updated = await markOrderPaid(
      env.ORDERS,
      order,
      view.paymentId || order.orderId,
      "captured",
      { webhookVerified: true, serverConfirmed: true },
      now.toISOString(),
      (current) => postBooking(env, deps, current),
    );
    if (!updated.appsScriptPosted) {
      return { order: updated, response: json(500, { ok: false, error: updated.failureReason || "apps-script" }, cors) };
    }
    return { order: updated, response: json(200, { ok: true, status: "paid" }, cors) };
  }
  if (view.kind === "authorized") {
    if (captureModeOf(env) === "reserve" && !forceCapture) {
      const updated = await saveStatus(env.ORDERS, order, "reserved", "authorized", now.toISOString(), null);
      updated.paymentId = view.paymentId || updated.paymentId;
      await putOrder(env.ORDERS, updated);
      return { order: updated, response: json(200, { ok: true, status: "reserved" }, cors) };
    }
    const fetcher = deps.fetch || fetch;
    try {
      await captureVippsPayment(fetcher, vippsCreds(env), order.orderId, order.amountMinor, now.getTime());
    } catch (error) {
      const check = await getVippsPayment(fetcher, vippsCreds(env), order.orderId, now.getTime());
      if (interpretVipps(check, order.amountMinor).kind !== "captured") throw error;
    }
    const after = await getVippsPayment(fetcher, vippsCreds(env), order.orderId, now.getTime());
    const captured = interpretVipps(after, order.amountMinor);
    if (captured.kind !== "captured") {
      return { order, response: json(500, { ok: false, error: "capture-unconfirmed" }, cors) };
    }
    const updated = await markOrderPaid(
      env.ORDERS,
      order,
      captured.paymentId || order.orderId,
      "captured",
      { webhookVerified: true, serverConfirmed: true },
      now.toISOString(),
      (current) => postBooking(env, deps, current),
    );
    if (!updated.appsScriptPosted) {
      return { order: updated, response: json(500, { ok: false, error: updated.failureReason || "apps-script" }, cors) };
    }
    return { order: updated, response: json(200, { ok: true, status: "paid" }, cors) };
  }
  return { order, response: json(200, { ok: true, status: "pending", reason: view.reason }, cors) };
}

async function onVippsWebhook(request: Request, env: Env, deps: Deps, cors: Headers): Promise<Response> {
  const modeError = testModeError(env);
  if (modeError) return json(403, { ok: false, error: "test-mode", message: modeError }, cors);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "too-large" }, cors);
  let body: { reference?: string; msn?: string; name?: string; amount?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "invalid-json" }, cors);
  }
  const reference = clip(body.reference, 64);
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(reference)) return json(400, { ok: false, error: "bad-reference" }, cors);
  if (body.msn && String(body.msn) !== env.VIPPS_MSN) return json(400, { ok: false, error: "msn" }, cors);
  const order = await getOrder(env.ORDERS, reference);
  if (!order || order.provider !== "vipps") return json(200, { ok: true, ignored: true }, cors);
  const now = (deps.now || (() => new Date()))();
  const fetcher = deps.fetch || fetch;
  let payment: VippsPayment;
  try {
    payment = await getVippsPayment(fetcher, vippsCreds(env), reference, now.getTime());
  } catch (error) {
    console.info(JSON.stringify({ msg: "vipps-get-failed", orderId: reference }));
    return json(500, { ok: false, error: error instanceof Error ? error.message : "vipps-get" }, cors);
  }
  const settled = await settleVipps(env, deps, order, payment, now);
  const headers = new Headers(settled.response.headers);
  cors.forEach((value, key) => headers.set(key, value));
  return new Response(settled.response.body, { status: settled.response.status, headers });
}

async function onCapture(request: Request, env: Env, orderId: string, deps: Deps, cors: Headers): Promise<Response> {
  const modeError = testModeError(env);
  if (modeError) return json(403, { ok: false, error: "test-mode", message: modeError }, cors);
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.ADMIN_SECRET || !timingSafeEqual(token, env.ADMIN_SECRET)) {
    return json(401, { ok: false, error: "unauthorized" }, cors);
  }
  const order = await getOrder(env.ORDERS, orderId);
  if (!order) return json(404, { ok: false, error: "not-found" }, cors);
  if (order.provider !== "vipps") return json(400, { ok: false, error: "not-vipps" }, cors);
  if (order.status === "paid" && order.appsScriptPosted) return json(200, publicOrder(order), cors);
  const now = (deps.now || (() => new Date()))();
  const fetcher = deps.fetch || fetch;
  const before = await getVippsPayment(fetcher, vippsCreds(env), order.orderId, now.getTime());
  const settled = await settleVipps(env, deps, order, before, now, true);
  if (settled.response.status >= 400) return json(settled.response.status, await settled.response.json(), cors);
  const fresh = (await getOrder(env.ORDERS, order.orderId)) || settled.order;
  return json(200, publicOrder(fresh), cors);
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  try {
    if (request.method === "GET" && path === "/health") {
      return json(200, { ok: true, mode: "test", captureMode: captureModeOf(env) }, cors);
    }
    if (request.method === "POST" && path === "/checkout") return beginCheckout(request, env, deps, cors);
    if (request.method === "POST" && path === "/webhooks/stripe") return onStripeWebhook(request, env, deps, cors);
    if (request.method === "POST" && path === "/webhooks/vipps") return onVippsWebhook(request, env, deps, cors);
    const orderMatch = path.match(/^\/order\/([0-9a-f-]{36})$/i);
    if (orderMatch && request.method === "GET") {
      const order = await getOrder(env.ORDERS, orderMatch[1]);
      if (!order) return json(404, { ok: false, error: "not-found" }, cors);
      return json(200, publicOrder(order), cors);
    }
    const captureMatch = path.match(/^\/order\/([0-9a-f-]{36})\/capture$/i);
    if (captureMatch && request.method === "POST") return onCapture(request, env, captureMatch[1], deps, cors);
    return json(404, { ok: false, error: "not-found" }, cors);
  } catch (error) {
    console.info(JSON.stringify({ msg: "unhandled", error: error instanceof Error ? error.message : "error" }));
    return json(500, { ok: false, error: "internal" }, cors);
  }
}
