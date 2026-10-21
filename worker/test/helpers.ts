import { clearProviderChecks } from "../src/provider-check.ts";
import { priceOrder } from "../src/pricing.ts";
import type { Deps, Env, OrderKv } from "../src/types.ts";

export const NOW = new Date("2026-10-15T10:00:00.000Z");
export const ORDER_ID = "11111111-1111-4111-8111-111111111111";

export function memoryKv(): OrderKv {
  clearProviderChecks();
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.has(key) ? map.get(key) || null : null;
    },
    async put(key: string, value: string, _options?: { expirationTtl?: number }) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    async list(options: { prefix?: string; cursor?: string }) {
      const prefix = options.prefix || "";
      const keys = [...map.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return { keys, list_complete: true as const };
    },
  };
}

export function backgroundDeps(base: Deps = {}): Deps & { flush: () => Promise<void> } {
  const tasks: Promise<unknown>[] = [];
  return {
    ...base,
    waitUntil(promise: Promise<unknown>) {
      tasks.push(Promise.resolve(promise));
    },
    async flush() {
      while (tasks.length) {
        const batch = tasks.splice(0, tasks.length);
        await Promise.all(batch);
      }
    },
  };
}

export function testEnv(kv: OrderKv, overrides: Partial<Env> = {}): Env {
  return {
    ORDERS: kv,
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
    STRIPE_PUBLISHABLE_KEY: "pk_test_123",
    VIPPS_CLIENT_ID: "vipps-client",
    VIPPS_CLIENT_SECRET: "vipps-secret",
    VIPPS_SUBSCRIPTION_KEY: "vipps-subscription",
    VIPPS_MSN: "123456",
    APPS_SCRIPT_SHARED_SECRET: "shared-secret-value",
    ADMIN_SECRET: "admin-secret-value",
    VIPPS_WEBHOOK_SECRET: "vipps-webhook-secret",
    ALLOW_LIVE_PAYMENTS: "false",
    CAPTURE_MODE: "immediate",
    APPS_SCRIPT_URL: "https://apps-script.test/exec",
    PUBLIC_SITE_URL: "https://hustleoslo.com",
    ALLOWED_ORIGINS: "https://hustleoslo.com,https://www.hustleoslo.com,http://localhost:8765",
    ...overrides,
  };
}

export function bundlePrice() {
  const priced = priceOrder(
    [{ eventId: "2026-11-02-class-gymsalen", ticketId: "bundle", priceTier: "standard" }],
    NOW,
    1,
  );
  if (!priced.ok) throw new Error(priced.error);
  return priced;
}

export function checkoutBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: ORDER_ID,
    method: "card",
    customer: { fullName: "Claire Wu", email: "claire@example.com", phone: "46862806" },
    nights: [{ eventId: "2026-11-02-class-gymsalen", ticketId: "bundle", priceTier: "standard" }],
    termsAccepted: true,
    termsAcceptedAt: "2026-10-15T10:00:00.000Z",
    termsVersion: "v1.0",
    isRepeat: true,
    amount: 1,
    currency: "EUR",
    returnUrl: "https://hustleoslo.com/",
    ...overrides,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  return out;
}

export function recordFetch(
  handle: (call: RecordedCall) => Response | Promise<Response>,
  options: { allowLiveVipps?: boolean } = {},
) {
  const calls: RecordedCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("script.google.com")) throw new Error("Refusing to call the live Apps Script");
    if (!options.allowLiveVipps && url.startsWith("https://api.vipps.no/")) throw new Error("Refusing live Vipps");
    const call: RecordedCall = {
      url,
      method: (init?.method || "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : "",
      headers: headerRecord(init?.headers),
    };
    calls.push(call);
    return handle(call);
  };
  return { calls, fetcher };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
