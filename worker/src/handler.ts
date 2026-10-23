import { appsScriptBodies } from "./apps-script.ts";
import { buildCalendar, nightsForCalendar } from "./calendar.ts";
import { sha256Base64, timingSafeEqual } from "./crypto.ts";
import {
  CHECKOUT_OK_TTL_SEC,
  checkoutOkKey,
  getOrder,
  listPrefixedIds,
  markOrderPaid,
  newOrder,
  PENDING_VIPPS_TTL_SEC,
  pendingVippsKey,
  putOrder,
  saveStatus,
} from "./orders.ts";
import { markProviderChecked, providerCheckedRecently } from "./provider-check.ts";
import { deliverPaidBooking, retryUnpostedBookings } from "./sheet-sync.ts";
import { priceOrder } from "./pricing.ts";
import { createPaymentIntent, decideStripe, paymentsModeError, retrievePaymentIntent, stripePayMethod, stripeSecretIsLive, verifyStripeSignature } from "./stripe.ts";
import type { CaptureMode, CheckoutInput, Deps, Env, PayMethod, SignupMeta, StoredOrder } from "./types.ts";
import {
  captureVippsPayment,
  clearVippsTokenCache,
  createVippsPayment,
  getVippsPayment,
  interpretVipps,
  verifyVippsWebhook,
  vippsApiBase,
  VIPPS_LIVE_API,
  type VippsCreds,
  type VippsPayment,
} from "./vipps.ts";

export { appsScriptBodies, clearVippsTokenCache };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 30 new checkouts per 10 minutes per hashed IP. Replaying an order does not count. */
const CHECKOUT_LIMIT = 30;
const CHECKOUT_WINDOW_MS = 10 * 60 * 1000;
const CHECKOUT_WAIT_MS = 8000;
const CHECKOUT_POLL_MS = 50;
const VIPPS_POLL_MIN_MS = 2 * 60 * 1000;
const VIPPS_POLL_MAX_MS = 24 * 60 * 60 * 1000;
const VIPPS_SYNC_THROTTLE_MS = 5 * 1000;
const METHODS = new Set(["card", "apple", "google", "vipps"]);
const MAX_BODY = 65_536;
const SERVER_FAIL = "Something went wrong on our side. You haven’t been charged. Try again in a moment.";

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

/** Optional. Digits and spaces, with an optional leading +. */
function phoneOk(value: string): boolean {
  if (!value) return true;
  if (!/^\+?[0-9 ]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

function allowLive(env: Env): boolean {
  return env.ALLOW_LIVE_PAYMENTS === "true";
}

function testModeError(env: Env): string | null {
  return paymentsModeError(allowLive(env), env.STRIPE_SECRET_KEY || "", env.STRIPE_PUBLISHABLE_KEY || "");
}

function vippsCreds(env: Env): VippsCreds {
  return {
    clientId: env.VIPPS_CLIENT_ID,
    clientSecret: env.VIPPS_CLIENT_SECRET,
    subscriptionKey: env.VIPPS_SUBSCRIPTION_KEY,
    msn: env.VIPPS_MSN,
    apiBase: vippsApiBase(allowLive(env), env.VIPPS_API_BASE),
  };
}

function clientIp(request: Request): string {
  return (request.headers.get("cf-connecting-ip") || "unknown").slice(0, 80);
}

function requestOrigin(request: Request): string {
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function checkoutReady(order: StoredOrder): boolean {
  return Boolean(order.clientSecret || order.redirectUrl || order.status === "paid" || order.status === "reserved");
}

function providerFailure(cors: Headers): Response {
  return json(502, {
    ok: false,
    error: "provider",
    message: "Payment didn’t go through. You haven’t been charged. Try again or pick another method.",
  }, cors);
}

/**
 * 30 checkouts per 10 minutes. The Workers Rate Limiting binding only accepts
 * a 10 or 60 second period, so it cannot express this window. The Cache API
 * keeps the count without a KV write. KV is the fallback where caches.default
 * is missing, which is the Node test runner.
 */
function rateLimitCache(): Cache | null {
  const cachesGlobal = (globalThis as { caches?: { default?: Cache } }).caches;
  const cache = cachesGlobal?.default;
  if (!cache || typeof cache.match !== "function" || typeof cache.put !== "function") return null;
  return cache;
}

function rateLimitRequest(digest: string): Request {
  return new Request(`https://rate-limit.hustleoslo.internal/checkout/${digest}`);
}

async function readRateBucket(raw: string | null, nowMs: number): Promise<{ start: number; count: number }> {
  let start = nowMs;
  let count = 0;
  if (!raw) return { start, count };
  try {
    const parsed = JSON.parse(raw) as { start?: number; count?: number };
    if (typeof parsed.start === "number" && nowMs - parsed.start < CHECKOUT_WINDOW_MS) {
      start = parsed.start;
      count = parsed.count || 0;
    }
  } catch {
    start = nowMs;
  }
  return { start, count };
}

async function checkoutAllowedViaCache(cache: Cache, digest: string, nowMs: number): Promise<boolean> {
  const request = rateLimitRequest(digest);
  const hit = await cache.match(request);
  const bucket = await readRateBucket(hit ? await hit.text() : null, nowMs);
  if (bucket.count >= CHECKOUT_LIMIT) return false;
  const remainingMs = Math.max(1000, bucket.start + CHECKOUT_WINDOW_MS - nowMs);
  await cache.put(
    request,
    new Response(JSON.stringify({ start: bucket.start, count: bucket.count + 1 }), {
      headers: { "cache-control": `public, max-age=${Math.ceil(remainingMs / 1000)}` },
    }),
  );
  return true;
}

async function checkoutAllowedViaKv(kv: Env["ORDERS"], digest: string, nowMs: number): Promise<boolean> {
  const key = `rl:${digest}`;
  const bucket = await readRateBucket(await kv.get(key), nowMs);
  if (bucket.count >= CHECKOUT_LIMIT) return false;
  const ttlSec = Math.ceil(CHECKOUT_WINDOW_MS / 1000);
  await kv.put(key, JSON.stringify({ start: bucket.start, count: bucket.count + 1 }), { expirationTtl: ttlSec });
  return true;
}

async function checkoutAllowed(kv: Env["ORDERS"], ip: string, nowMs: number): Promise<boolean> {
  const digest = (await sha256Base64(ip || "unknown")).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  const cache = rateLimitCache();
  if (cache) {
    try {
      return await checkoutAllowedViaCache(cache, digest, nowMs);
    } catch (error) {
      console.info(JSON.stringify({ msg: "rate-limit-cache-failed", error: error instanceof Error ? error.message : "error" }));
    }
  }
  return checkoutAllowedViaKv(kv, digest, nowMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Fields the return page reads. Name, email, and the night list stay in KV. */
function publicOrder(order: StoredOrder) {
  return {
    ok: true,
    orderId: order.orderId,
    status: order.status,
    provider: order.provider,
    method: order.method,
    paymentId: order.status === "paid" ? order.paymentId : null,
    appsScriptPosted: order.appsScriptPosted,
    confirmationSent: order.confirmationSent,
    failureReason: order.status === "failed" ? order.failureReason : null,
    redirectUrl: order.status === "pending" && order.provider === "vipps" ? order.redirectUrl : null,
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
    termsVersion: clip(body.termsVersion, 20) || "v1.1",
  };
}

function paymentDescription(order: StoredOrder): string {
  const dates = order.nights.map((night) => night.eventDate).join(", ");
  return `Hustle Oslo ${dates}`.slice(0, 100);
}

async function readyCheckout(kv: Env["ORDERS"], orderId: string): Promise<StoredOrder | null> {
  const side = await kv.get(checkoutOkKey(orderId));
  if (side) {
    try {
      const saved = JSON.parse(side) as StoredOrder;
      if (saved && saved.orderId === orderId && checkoutReady(saved)) {
        const current = await getOrder(kv, orderId);
        if (!current || !checkoutReady(current)) await putOrder(kv, saved);
        return (await getOrder(kv, orderId)) || saved;
      }
    } catch {
      /* a bad side key falls through to the order row */
    }
  }
  const current = await getOrder(kv, orderId);
  return current && checkoutReady(current) ? current : null;
}

async function waitForCheckout(kv: Env["ORDERS"], orderId: string): Promise<StoredOrder | null> {
  const deadline = Date.now() + CHECKOUT_WAIT_MS;
  for (;;) {
    const ready = await readyCheckout(kv, orderId);
    if (ready) return ready;
    if (Date.now() >= deadline) return null;
    await sleep(CHECKOUT_POLL_MS);
  }
}

async function rememberReady(kv: Env["ORDERS"], order: StoredOrder): Promise<void> {
  await kv.put(checkoutOkKey(order.orderId), JSON.stringify(order), { expirationTtl: CHECKOUT_OK_TTL_SEC });
  await putOrder(kv, order);
}

async function beginCheckout(request: Request, env: Env, deps: Deps, cors: Headers): Promise<Response> {
  const modeError = testModeError(env);
  if (modeError) return json(403, { ok: false, error: "test-mode", message: modeError }, cors);
  if (!env.ORDERS) return json(500, { ok: false, error: "kv-missing", message: SERVER_FAIL }, cors);
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
  if (!phoneOk(customer.phone)) {
    return json(400, { ok: false, error: "phone", message: "Enter a phone number, or leave it blank." }, cors);
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
  order.workerOrigin = requestOrigin(request);
  const leaseToken = crypto.randomUUID();
  const inProgress = () =>
    json(409, {
      ok: false,
      error: "checkout-in-progress",
      message: "This checkout is already starting. Wait a moment and try again.",
    }, cors);
  const replay = async (ready: StoredOrder): Promise<Response> => {
    const sameCustomer = JSON.stringify(ready.customer) === JSON.stringify(order.customer);
    const sameMeta = JSON.stringify(ready.meta) === JSON.stringify(order.meta);
    if (!sameCustomer || !sameMeta || !ready.workerOrigin) {
      ready.customer = order.customer;
      ready.meta = order.meta;
      if (!ready.workerOrigin) ready.workerOrigin = order.workerOrigin;
      ready.updatedAt = now.toISOString();
      await putOrder(env.ORDERS, ready);
    }
    return checkoutResponse(ready, env, cors, true);
  };
  const existing = (await readyCheckout(env.ORDERS, order.orderId)) || (await getOrder(env.ORDERS, order.orderId));
  if (existing) {
    if (existing.fingerprint !== order.fingerprint) {
      return json(409, { ok: false, error: "idempotency-conflict", message: "This checkout doesn’t match the original order. Start again." }, cors);
    }
    if (checkoutReady(existing)) return replay(existing);
    const heldUntil = existing.checkoutLeaseUntil ? Date.parse(existing.checkoutLeaseUntil) : 0;
    if (existing.checkoutLeaseToken && Number.isFinite(heldUntil) && heldUntil > now.getTime()) {
      const waited = await waitForCheckout(env.ORDERS, order.orderId);
      if (waited && waited.fingerprint === order.fingerprint) return replay(waited);
      const after = await getOrder(env.ORDERS, order.orderId);
      if (after && after.status === "failed" && after.failureReason === "provider" && after.fingerprint === order.fingerprint) {
        return providerFailure(cors);
      }
      return inProgress();
    }
  }
  if (!(await checkoutAllowed(env.ORDERS, clientIp(request), now.getTime()))) {
    return json(429, {
      ok: false,
      error: "rate-limit",
      message: "Too many checkout attempts. Wait a few minutes and try again.",
    }, cors);
  }
  order.checkoutLeaseToken = leaseToken;
  order.checkoutLeaseUntil = new Date(now.getTime() + 30_000).toISOString();
  await putOrder(env.ORDERS, order);
  const claimed = await getOrder(env.ORDERS, order.orderId);
  if (!claimed || claimed.checkoutLeaseToken !== leaseToken) {
    const waited = await waitForCheckout(env.ORDERS, order.orderId);
    if (waited && waited.fingerprint === order.fingerprint) return replay(waited);
    const after = await getOrder(env.ORDERS, order.orderId);
    if (after && after.status === "failed" && after.failureReason === "provider" && after.fingerprint === order.fingerprint) {
      return providerFailure(cors);
    }
    return inProgress();
  }
  const current = claimed;
  const checkoutStarted = Date.now();
  current.customer = order.customer;
  current.meta = order.meta;
  current.returnUrl = order.returnUrl;
  current.status = "pending";
  current.failureReason = null;
  const fetcher = deps.fetch || fetch;
  try {
    if (current.provider === "stripe") {
      const intentStarted = Date.now();
      const intent = await createPaymentIntent(fetcher, env.STRIPE_SECRET_KEY, {
        amountMinor: current.amountMinor,
        orderId: current.orderId,
        description: paymentDescription(current),
        method: current.method,
      });
      console.info(JSON.stringify({ msg: "timing", step: "create-intent", orderId: current.orderId, ms: Date.now() - intentStarted }));
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
      await env.ORDERS.put(pendingVippsKey(current.orderId), current.orderId, { expirationTtl: PENDING_VIPPS_TTL_SEC });
    }
  } catch {
    const waited = await waitForCheckout(env.ORDERS, current.orderId);
    if (waited && waited.fingerprint === order.fingerprint) return replay(waited);
    const fresh = await getOrder(env.ORDERS, current.orderId);
    if (fresh && fresh.checkoutLeaseToken && fresh.checkoutLeaseToken !== leaseToken) return inProgress();
    current.status = "failed";
    current.failureReason = "provider";
    current.checkoutLeaseToken = null;
    current.checkoutLeaseUntil = null;
    current.clientSecret = null;
    current.redirectUrl = null;
    current.updatedAt = now.toISOString();
    const saved = await readyCheckout(env.ORDERS, current.orderId);
    if (saved && saved.fingerprint === order.fingerprint) return replay(saved);
    await putOrder(env.ORDERS, current);
    const late = await readyCheckout(env.ORDERS, current.orderId);
    if (late && late.fingerprint === order.fingerprint && late.failureReason !== "provider") return replay(late);
    console.info(JSON.stringify({ msg: "checkout-provider-failed", orderId: current.orderId, provider: current.provider }));
    return providerFailure(cors);
  }
  current.checkoutLeaseToken = null;
  current.checkoutLeaseUntil = null;
  current.updatedAt = now.toISOString();
  await rememberReady(env.ORDERS, current);
  console.info(
    JSON.stringify({
      msg: "timing",
      step: "checkout",
      orderId: current.orderId,
      provider: current.provider,
      ms: Date.now() - checkoutStarted,
    }),
  );
  return checkoutResponse(current, env, cors, false);
}

function scheduleSheetPost(env: Env, deps: Deps, orderId: string): void {
  const task = deliverPaidBooking(env, deps, orderId).catch((error: unknown) => {
    console.info(
      JSON.stringify({
        msg: "sheet-post-failed",
        orderId,
        error: error instanceof Error ? error.message : "error",
      }),
    );
  });
  if (deps.waitUntil) deps.waitUntil(task);
  else void task;
}

async function acceptPaid(
  env: Env,
  deps: Deps,
  order: StoredOrder,
  paymentId: string,
  providerStatus: string,
  now: Date,
): Promise<StoredOrder> {
  const updated = await markOrderPaid(
    env.ORDERS,
    order,
    paymentId,
    providerStatus,
    { webhookVerified: true, serverConfirmed: true },
    now.toISOString(),
  );
  if (!updated.appsScriptPosted) scheduleSheetPost(env, deps, updated.orderId);
  return updated;
}

async function onStripeWebhook(request: Request, env: Env, deps: Deps, cors: Headers): Promise<Response> {
  const webhookStarted = Date.now();
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
  console.info(JSON.stringify({ msg: "timing", step: "webhook-arrival", provider: "stripe", orderId, ms: Date.now() - webhookStarted }));
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
  const noted = withStripeMethod(order, intent);
  if (type === "payment_intent.payment_failed" && decision.action !== "paid") {
    const reason = decision.action === "failed" ? decision.reason : "declined";
    await saveStatus(env.ORDERS, noted, "failed", reason, now.toISOString(), reason);
    return json(200, { ok: true, status: "failed", reason }, cors);
  }
  if (decision.action === "paid") {
    await acceptPaid(env, deps, noted, decision.paymentId, "succeeded", now);
    console.info(JSON.stringify({ msg: "timing", step: "webhook-paid", provider: "stripe", orderId, ms: Date.now() - webhookStarted }));
    return json(200, { ok: true, status: "paid" }, cors);
  }
  if (decision.action === "failed") {
    await saveStatus(env.ORDERS, noted, "failed", decision.reason, now.toISOString(), decision.reason);
  }
  return json(200, { ok: true, status: decision.action, reason: decision.reason }, cors);
}

/** Wallet method stays in memory until the status write, so a pending poll does not put the order. */
function withStripeMethod(order: StoredOrder, intent: Awaited<ReturnType<typeof retrievePaymentIntent>>): StoredOrder {
  const method = stripePayMethod(intent);
  if (!method || order.method === method) return order;
  return { ...order, method };
}

/** Webhook fallback: a pending card order is marked from the retrieved PaymentIntent. */
async function syncStripeOrder(env: Env, deps: Deps, order: StoredOrder): Promise<StoredOrder> {
  const now = (deps.now || (() => new Date()))();
  const fresh = (await getOrder(env.ORDERS, order.orderId)) || order;
  if (fresh.provider !== "stripe" || fresh.status !== "pending" || !fresh.paymentId) return fresh;
  if (providerCheckedRecently(fresh.orderId, now.getTime(), VIPPS_SYNC_THROTTLE_MS)) return fresh;
  const fetcher = deps.fetch || fetch;
  let intent;
  try {
    intent = await retrievePaymentIntent(fetcher, env.STRIPE_SECRET_KEY, fresh.paymentId);
  } catch {
    console.info(JSON.stringify({ msg: "stripe-retrieve-failed", orderId: fresh.orderId }));
    return fresh;
  }
  const noted = withStripeMethod(fresh, intent);
  const decision = decideStripe(intent, noted);
  if (decision.action === "paid") return acceptPaid(env, deps, noted, decision.paymentId, "succeeded", now);
  if (decision.action === "failed") {
    return saveStatus(env.ORDERS, noted, "failed", decision.reason, now.toISOString(), decision.reason);
  }
  return (await getOrder(env.ORDERS, fresh.orderId)) || fresh;
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
    const updated = await acceptPaid(env, deps, order, view.paymentId || order.orderId, "captured", now);
    return { order: updated, response: json(200, { ok: true, status: "paid" }, cors) };
  }
  if (view.kind === "authorized") {
    if (captureModeOf(env) === "reserve" && !forceCapture) {
      if (view.paymentId) order.paymentId = view.paymentId;
      const updated = await saveStatus(env.ORDERS, order, "reserved", "authorized", now.toISOString(), null);
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
    const updated = await acceptPaid(env, deps, order, captured.paymentId || order.orderId, "captured", now);
    return { order: updated, response: json(200, { ok: true, status: "paid" }, cors) };
  }
  return { order, response: json(200, { ok: true, status: "pending", reason: view.reason }, cors) };
}

async function syncVippsOrder(env: Env, deps: Deps, order: StoredOrder, ignoreThrottle: boolean): Promise<StoredOrder> {
  const now = (deps.now || (() => new Date()))();
  const fresh = (await getOrder(env.ORDERS, order.orderId)) || order;
  if (fresh.provider !== "vipps" || (fresh.status !== "pending" && fresh.status !== "reserved")) return fresh;
  if (!ignoreThrottle && providerCheckedRecently(fresh.orderId, now.getTime(), VIPPS_SYNC_THROTTLE_MS)) return fresh;
  if (ignoreThrottle) markProviderChecked(fresh.orderId, now.getTime());
  const fetcher = deps.fetch || fetch;
  let payment: VippsPayment;
  try {
    payment = await getVippsPayment(fetcher, vippsCreds(env), fresh.orderId, now.getTime());
  } catch {
    console.info(JSON.stringify({ msg: "vipps-sync-failed", orderId: fresh.orderId }));
    return fresh;
  }
  try {
    const settled = await settleVipps(env, deps, fresh, payment, now);
    return (await getOrder(env.ORDERS, fresh.orderId)) || settled.order;
  } catch {
    console.info(JSON.stringify({ msg: "vipps-sync-failed", orderId: fresh.orderId }));
    return (await getOrder(env.ORDERS, fresh.orderId)) || fresh;
  }
}

async function reconcilePendingVipps(env: Env, deps: Deps): Promise<void> {
  const now = (deps.now || (() => new Date()))();
  const ids = await listPrefixedIds(env.ORDERS, "pending-vipps:");
  for (const orderId of ids) {
    const order = await getOrder(env.ORDERS, orderId);
    if (!order || order.provider !== "vipps" || order.status !== "pending") continue;
    const age = now.getTime() - Date.parse(order.createdAt);
    if (!Number.isFinite(age) || age < VIPPS_POLL_MIN_MS) continue;
    if (age > VIPPS_POLL_MAX_MS) {
      await expireOrSettleVipps(env, deps, order, now);
      continue;
    }
    await syncVippsOrder(env, deps, order, true);
  }
}

/**
 * One last read before giving up. A network error leaves the order on the cron.
 * AUTHORIZED is captured. A payment still sitting in CREATED is marked expired.
 */
async function expireOrSettleVipps(env: Env, deps: Deps, order: StoredOrder, now: Date): Promise<void> {
  const fetcher = deps.fetch || fetch;
  let payment: VippsPayment;
  try {
    payment = await getVippsPayment(fetcher, vippsCreds(env), order.orderId, now.getTime());
  } catch {
    console.info(JSON.stringify({ msg: "vipps-expire-skipped", orderId: order.orderId }));
    return;
  }
  try {
    const settled = await settleVipps(env, deps, order, payment, now);
    if (settled.order.status === "pending") {
      await saveStatus(env.ORDERS, settled.order, "failed", "expired", now.toISOString(), "expired");
    }
  } catch {
    console.info(JSON.stringify({ msg: "vipps-expire-skipped", orderId: order.orderId }));
  }
}

/** Sheet retries plus a Vipps status check for pending orders whose webhook never arrived. */
export async function reconcilePayments(env: Env, deps: Deps = {}): Promise<void> {
  await retryUnpostedBookings(env, deps);
  await reconcilePendingVipps(env, deps);
}

async function onVippsWebhook(request: Request, env: Env, deps: Deps, cors: Headers): Promise<Response> {
  const modeError = testModeError(env);
  if (modeError) return json(403, { ok: false, error: "test-mode", message: modeError }, cors);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "too-large" }, cors);
  const now = (deps.now || (() => new Date()))();
  const url = new URL(request.url);
  const signed = await verifyVippsWebhook({
    secret: env.VIPPS_WEBHOOK_SECRET || "",
    method: "POST",
    pathAndQuery: `${url.pathname}${url.search}`,
    host: request.headers.get("host") || url.host,
    dateHeader: request.headers.get("x-ms-date") || "",
    contentHashHeader: request.headers.get("x-ms-content-sha256") || "",
    authorization: request.headers.get("authorization") || "",
    rawBody: raw,
  });
  if (!signed) return json(401, { ok: false, error: "invalid-signature" }, cors);
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
  if (order.status === "paid") {
    if (!order.appsScriptPosted) scheduleSheetPost(env, deps, order.orderId);
    return json(200, publicOrder(order), cors);
  }
  const now = (deps.now || (() => new Date()))();
  const fetcher = deps.fetch || fetch;
  const before = await getVippsPayment(fetcher, vippsCreds(env), order.orderId, now.getTime());
  const settled = await settleVipps(env, deps, order, before, now, true);
  if (settled.response.status >= 400) return json(settled.response.status, await settled.response.json(), cors);
  const fresh = (await getOrder(env.ORDERS, order.orderId)) || settled.order;
  return json(200, publicOrder(fresh), cors);
}

async function onIcs(request: Request, env: Env, deps: Deps, cors: Headers): Promise<Response> {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order") || "";
  const missing = () => new Response(null, { status: 404, headers: cors });
  if (!UUID.test(orderId)) return missing();
  const order = await getOrder(env.ORDERS, orderId);
  if (!order || (order.status !== "paid" && order.status !== "reserved")) return missing();
  const nights = nightsForCalendar(order, url.searchParams);
  if (!nights) return missing();
  const headers = new Headers(cors);
  headers.set("content-type", "text/calendar; charset=utf-8");
  headers.set("content-disposition", "inline; filename=hustle-oslo.ics");
  headers.set("cache-control", "private, max-age=300");
  const stamp = (deps.now || (() => new Date()))();
  return new Response(buildCalendar(order.orderId, nights, stamp), { status: 200, headers });
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  try {
    if (request.method === "GET" && path === "/health") {
      const live = allowLive(env);
      const vippsApi = vippsApiBase(live, env.VIPPS_API_BASE);
      const stripeLive = stripeSecretIsLive(env.STRIPE_SECRET_KEY || "");
      return json(200, {
        ok: true,
        mode: live && (stripeLive || vippsApi === VIPPS_LIVE_API) ? "live" : "test",
        allowLivePayments: live,
        captureMode: captureModeOf(env),
        vippsApi,
      }, cors);
    }
    if (request.method === "GET" && path === "/ics") return await onIcs(request, env, deps, cors);
    if (request.method === "POST" && path === "/checkout") return await beginCheckout(request, env, deps, cors);
    if (request.method === "POST" && path === "/webhooks/stripe") return await onStripeWebhook(request, env, deps, cors);
    if (request.method === "POST" && path === "/webhooks/vipps") return await onVippsWebhook(request, env, deps, cors);
    const orderMatch = path.match(/^\/order\/([0-9a-f-]{36})$/i);
    if (orderMatch && request.method === "GET") {
      let order = await getOrder(env.ORDERS, orderMatch[1]);
      if (!order) return json(404, { ok: false, error: "not-found" }, cors);
      if (order.provider === "vipps" && (order.status === "pending" || order.status === "reserved")) {
        order = await syncVippsOrder(env, deps, order, false);
      } else if (order.provider === "stripe" && order.status === "pending") {
        order = await syncStripeOrder(env, deps, order);
      }
      return json(200, publicOrder(order), cors);
    }
    const captureMatch = path.match(/^\/order\/([0-9a-f-]{36})\/capture$/i);
    if (captureMatch && request.method === "POST") return await onCapture(request, env, captureMatch[1], deps, cors);
    return json(404, { ok: false, error: "not-found" }, cors);
  } catch (error) {
    console.info(JSON.stringify({ msg: "unhandled", error: error instanceof Error ? error.message : "error" }));
    return json(500, { ok: false, error: "internal", message: SERVER_FAIL }, cors);
  }
}
