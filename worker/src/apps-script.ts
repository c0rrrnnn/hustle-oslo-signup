import type { StoredOrder } from "./types.ts";

export function appsScriptBodies(order: StoredOrder, secret: string): Record<string, unknown>[] {
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

export async function postPaidBooking(
  fetcher: typeof fetch,
  url: string,
  order: StoredOrder,
  secret: string,
): Promise<{ ok: boolean; confirmationSent: boolean; error?: string }> {
  if (order.status !== "paid") return { ok: false, confirmationSent: false, error: "not-paid" };
  if (!secret) return { ok: false, confirmationSent: false, error: "missing-secret" };
  const bodies = appsScriptBodies(order, secret);
  let confirmationSent = order.confirmationSent;
  try {
    for (let index = order.appsScriptPostedNights; index < bodies.length; index++) {
      const response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(bodies[index]),
      });
      const parsed = await readAppsScriptReply(response);
      if (!parsed.success) {
        return { ok: false, confirmationSent: false, error: parsed.error };
      }
      order.appsScriptPostedNights = index + 1;
      if (parsed.data.confirmationSent === true || parsed.data.duplicate === true) confirmationSent = true;
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
      };
      const response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(followUp),
      });
      const parsed = await readAppsScriptReply(response);
      if (!parsed.success) {
        return { ok: false, confirmationSent: false, error: parsed.error };
      }
      confirmationSent = parsed.data.confirmationSent === true;
    }
    return { ok: true, confirmationSent };
  } catch (error) {
    return { ok: false, confirmationSent: false, error: error instanceof Error ? error.message : "apps-script" };
  }
}
