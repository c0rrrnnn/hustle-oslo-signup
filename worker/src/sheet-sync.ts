import { postPaidBooking } from "./apps-script.ts";
import { getOrder, listUnpostedOrderIds, putOrder, unpostedKey } from "./orders.ts";
import type { Deps, Env } from "./types.ts";

/** After a failed sheet write: 5m, 15m, 30m, 1h, 3h, then 6h. */
const BACKOFF_MS = [5, 15, 30, 60, 180, 360].map((minutes) => minutes * 60_000);
const LEASE_MS = 3 * 60_000;

export function sheetBackoffMs(failedAttempts: number): number {
  if (failedAttempts < 1) return 0;
  const index = Math.min(failedAttempts, BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index];
}

export type SheetSyncResult = "posted" | "failed" | "skipped";

/**
 * Post one paid order to Apps Script. Success is only HTTP 2xx and ok: true.
 * A lease stops a webhook and the cron from writing the same order at once.
 * Cron passes respectSchedule so a recent failure waits out its backoff.
 */
export async function deliverPaidBooking(
  env: Env,
  deps: Deps,
  orderId: string,
  options: { respectSchedule?: boolean } = {},
): Promise<SheetSyncResult> {
  const now = (deps.now || (() => new Date()))();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const existing = await getOrder(env.ORDERS, orderId);
  if (!existing || existing.status !== "paid") {
    await env.ORDERS.delete(unpostedKey(orderId));
    return "skipped";
  }
  if (existing.appsScriptPosted) {
    await env.ORDERS.delete(unpostedKey(orderId));
    return "skipped";
  }
  if (options.respectSchedule && existing.appsScriptNextAttemptAt) {
    const due = Date.parse(existing.appsScriptNextAttemptAt);
    if (Number.isFinite(due) && due > nowMs) return "skipped";
  }
  const leaseUntil = existing.appsScriptLeaseUntil ? Date.parse(existing.appsScriptLeaseUntil) : 0;
  if (Number.isFinite(leaseUntil) && leaseUntil > nowMs) return "skipped";

  const token = crypto.randomUUID();
  existing.appsScriptLeaseToken = token;
  existing.appsScriptLeaseUntil = new Date(nowMs + LEASE_MS).toISOString();
  existing.updatedAt = nowIso;
  await putOrder(env.ORDERS, existing);
  const claimed = await getOrder(env.ORDERS, orderId);
  if (!claimed || claimed.appsScriptLeaseToken !== token) return "skipped";

  const postStarted = Date.now();
  const result = await postPaidBooking(
    deps.fetch || fetch,
    env.APPS_SCRIPT_URL,
    claimed,
    env.APPS_SCRIPT_SHARED_SECRET,
  );
  console.info(
    JSON.stringify({
      msg: "timing",
      step: "apps-script-post",
      orderId,
      ms: Date.now() - postStarted,
      ok: result.ok,
    }),
  );
  const latest = (await getOrder(env.ORDERS, orderId)) || claimed;
  if (latest.appsScriptLeaseToken !== token) return "skipped";
  latest.appsScriptPostedNights = claimed.appsScriptPostedNights;
  latest.appsScriptLeaseToken = null;
  latest.appsScriptLeaseUntil = null;
  latest.updatedAt = nowIso;
  if (result.ok) {
    latest.appsScriptPosted = true;
    latest.confirmationSent = result.confirmationSent;
    latest.failureReason = null;
    latest.appsScriptNextAttemptAt = null;
    await putOrder(env.ORDERS, latest);
    await env.ORDERS.delete(unpostedKey(orderId));
    return "posted";
  }
  const attempts = (latest.appsScriptAttempts || 0) + 1;
  latest.appsScriptAttempts = attempts;
  latest.appsScriptPosted = false;
  latest.failureReason = result.error || "apps-script";
  latest.appsScriptNextAttemptAt = new Date(nowMs + sheetBackoffMs(attempts)).toISOString();
  await putOrder(env.ORDERS, latest);
  await env.ORDERS.put(unpostedKey(orderId), orderId);
  console.info(JSON.stringify({ msg: "sheet-post-failed", orderId, attempts, error: latest.failureReason }));
  return "failed";
}

export async function retryUnpostedBookings(
  env: Env,
  deps: Deps = {},
): Promise<{ checked: number; posted: number; failed: number; skipped: number }> {
  const ids = await listUnpostedOrderIds(env.ORDERS);
  const summary = { checked: ids.length, posted: 0, failed: 0, skipped: 0 };
  for (const orderId of ids) {
    const result = await deliverPaidBooking(env, deps, orderId, { respectSchedule: true });
    if (result === "posted") summary.posted += 1;
    else if (result === "failed") summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}
