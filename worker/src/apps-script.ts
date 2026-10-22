import { calendarFields } from "./calendar.ts";
import type { StoredOrder } from "./types.ts";

export function appsScriptBodies(order: StoredOrder, secret: string, calendarBase = ""): Record<string, unknown>[] {
  const person: Record<string, unknown> = {
    SHARED_SECRET: secret,
    timestamp: order.createdAt,
    fullName: order.customer.fullName,
    email: order.customer.email,
    phone: order.customer.phone,
    transactionNumber: order.paymentId || order.orderId,
    paymentProvider: order.provider,
    paymentId: order.paymentId || order.orderId,
    paymentStatus: "paid",
    experience: order.meta.experience,
    experienceLabel: order.meta.experienceLabel,
    howFound: order.meta.howFound,
    howFoundLabel: order.meta.howFoundLabel,
    howFoundOther: order.meta.howFoundOther,
    referral: order.meta.referral,
    referralLabel: order.meta.referralLabel,
    referralOther: order.meta.referralOther,
    isRepeat: order.meta.isRepeat,
    vippsNumber: "48782",
    currency: "NOK",
    paymentMethod: order.method,
    termsAccepted: true,
    termsAcceptedAt: order.meta.termsAcceptedAt,
    termsVersion: order.meta.termsVersion || "v1.0",
  };
  return order.nights.map((night, index) => {
    const body: Record<string, unknown> = {
      ...person,
      eventId: night.eventId,
      eventDate: night.eventDate,
      eventType: night.eventType,
      eventLocation: night.eventLocation,
      eventLabel: night.eventLabel,
      eventVenue: night.eventVenue,
      eventStart: night.eventStart,
      eventEnd: night.eventEnd,
      sheetTabHint: night.sheetTabHint,
      ticketId: night.ticketId,
      ticketName: night.ticketName,
      priceTier: night.priceTier,
      amount: night.amount,
    };
    if (index === order.nights.length - 1) {
      body.sendAttendeeConfirmation = true;
      Object.assign(body, calendarFields(order, calendarBase));
      body.confirmationNights = order.nights.map((item) => ({
        eventId: item.eventId,
        eventDate: item.eventDate,
        eventType: item.eventType,
        eventLocation: item.eventLocation,
        eventLabel: item.eventLabel,
        eventVenue: item.eventVenue,
        eventStart: item.eventStart,
        eventEnd: item.eventEnd,
        ticketId: item.ticketId,
        ticketName: item.ticketName,
        priceTier: item.priceTier,
        amount: item.amount,
      }));
    }
    return body;
  });
}

type ScriptReply = {
  ok?: unknown;
  error?: unknown;
  confirmationSent?: unknown;
  duplicate?: unknown;
};

/** A sheet write counts only when Apps Script answers 2xx JSON with ok: true. */
async function readAppsScriptReply(
  response: Response,
): Promise<{ success: true; data: ScriptReply } | { success: false; error: string }> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { success: false, error: response.ok ? "invalid-json" : `HTTP ${response.status}` };
  }
  const reply = data && typeof data === "object" ? (data as ScriptReply) : null;
  if (response.ok && reply?.ok === true) return { success: true, data: reply };
  if (reply && typeof reply.error === "string" && reply.error) return { success: false, error: reply.error };
  return { success: false, error: response.ok ? "invalid-response" : `HTTP ${response.status}` };
}

/** First try plus three quick retries for a transient 404 or 5xx. */
const STATUS_ATTEMPTS = 4;
/** A hung connection is tried once more, so two attempts still fit in the sheet lease. */
const NETWORK_ATTEMPTS = 2;
const RETRY_MS = [200, 500, 1000];
/**
 * A paid Apps Script write has taken about 50s. Stay above that, and abort a
 * fetch that never returns so the result can be saved instead of leaving the lease.
 */
const POST_TIMEOUT_MS = 70_000;
const REDIRECT_HOPS = 2;

export type SheetWrite = {
  postedNights: number;
  confirmationSent: boolean;
  /** True once this 2xx finishes the booking, including confirmation when it was due. */
  posted: boolean;
};

export type PostOptions = {
  timeoutMs?: number;
  onWritten?: (write: SheetWrite) => Promise<void>;
};

function retryableStatus(status: number): boolean {
  return status === 404 || (status >= 500 && status < 600);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
    return error.message || "apps-script";
  }
  return "apps-script";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 301/302/303 are the Apps Script echo page: GET it. 307/308 keep the POST. */
function redirectMethod(status: number): "GET" | "POST" | null {
  if (status === 301 || status === 302 || status === 303) return "GET";
  if (status === 307 || status === 308) return "POST";
  return null;
}

function canFollow(next: URL, current: URL): boolean {
  if (next.protocol !== "https:") return false;
  if (next.host === current.host) return true;
  return next.host === "script.google.com" || next.host === "script.googleusercontent.com";
}

async function postJson(fetcher: typeof fetch, url: string, body: string, timeoutMs: number): Promise<Response> {
  let current = url;
  let method: "GET" | "POST" = "POST";
  let response: Response | null = null;
  for (let hop = 0; hop <= REDIRECT_HOPS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetcher(current, {
        method,
        headers: method === "POST" ? { "Content-Type": "text/plain;charset=utf-8" } : undefined,
        body: method === "POST" ? body : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const nextMethod = redirectMethod(response.status);
    if (!nextMethod) return response;
    await response.body?.cancel();
    const location = response.headers.get("Location");
    if (!location || hop === REDIRECT_HOPS) return response;
    const next = new URL(location, current);
    if (!canFollow(next, new URL(current))) return response;
    current = next.href;
    method = nextMethod;
  }
  return response as Response;
}

async function postJsonWithRetries(
  fetcher: typeof fetch,
  url: string,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_MS[Math.min(attempt - 1, RETRY_MS.length - 1)]);
    try {
      const response = await postJson(fetcher, url, body, timeoutMs);
      if (retryableStatus(response.status) && attempt < STATUS_ATTEMPTS - 1) {
        await response.body?.cancel();
        console.info(JSON.stringify({ msg: "sheet-post-retry", status: response.status, attempt: attempt + 1 }));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= NETWORK_ATTEMPTS - 1) throw error;
      console.info(
        JSON.stringify({
          msg: "sheet-post-retry",
          error: errorMessage(error),
          attempt: attempt + 1,
        }),
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error("apps-script");
}

async function send(
  fetcher: typeof fetch,
  url: string,
  body: string,
  timeoutMs: number,
): Promise<{ success: true; data: ScriptReply } | { success: false; error: string }> {
  try {
    return await readAppsScriptReply(await postJsonWithRetries(fetcher, url, body, timeoutMs));
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

export async function postPaidBooking(
  fetcher: typeof fetch,
  url: string,
  order: StoredOrder,
  secret: string,
  calendarBase = "",
  options: PostOptions = {},
): Promise<{ ok: boolean; confirmationSent: boolean; error?: string }> {
  if (order.status !== "paid") return { ok: false, confirmationSent: false, error: "not-paid" };
  if (!secret) return { ok: false, confirmationSent: false, error: "missing-secret" };
  const bodies = appsScriptBodies(order, secret, calendarBase);
  const timeoutMs = options.timeoutMs ?? POST_TIMEOUT_MS;
  let confirmationSent = order.confirmationSent;
  const note = async (posted: boolean) => {
    if (!options.onWritten) return;
    await options.onWritten({
      postedNights: order.appsScriptPostedNights,
      confirmationSent,
      posted,
    });
  };
  try {
    for (let index = order.appsScriptPostedNights; index < bodies.length; index++) {
      const parsed = await send(fetcher, url, JSON.stringify(bodies[index]), timeoutMs);
      if (!parsed.success) return { ok: false, confirmationSent: false, error: parsed.error };
      order.appsScriptPostedNights = index + 1;
      if (parsed.data.confirmationSent === true) confirmationSent = true;
      const nightsDone = order.appsScriptPostedNights >= bodies.length;
      await note(nightsDone && confirmationSent);
    }
    const lastIndex = bodies.length - 1;
    const lastWasPosted = order.appsScriptPostedNights > lastIndex;
    if (lastWasPosted && !confirmationSent) {
      const followUp = {
        SHARED_SECRET: secret,
        timestamp: order.createdAt,
        fullName: order.customer.fullName,
        email: order.customer.email,
        phone: order.customer.phone,
        sendAttendeeConfirmation: true,
        confirmationOnly: true,
        confirmationNights: (bodies[lastIndex].confirmationNights as unknown[]) || [],
        confirmationTransactionNumber: order.paymentId || order.orderId,
        paymentProvider: order.provider,
        paymentId: order.paymentId || order.orderId,
        paymentStatus: "paid",
        vippsNumber: "48782",
        ...calendarFields(order, calendarBase),
      };
      const parsed = await send(fetcher, url, JSON.stringify(followUp), timeoutMs);
      if (!parsed.success) return { ok: false, confirmationSent: false, error: parsed.error };
      confirmationSent = parsed.data.confirmationSent === true;
      await note(true);
    }
    return { ok: true, confirmationSent };
  } catch (error) {
    return { ok: false, confirmationSent: false, error: errorMessage(error) };
  }
}
