import { postPaidBooking, type SheetWrite } from "./apps-script.ts";
import { calendarBaseFor } from "./calendar.ts";
import { getOrder, listUnpostedOrderIds, putOrder, UNPOSTED_TTL_SEC, unpostedKey } from "./orders.ts";
import type { Deps, Env, StoredOrder } from "./types.ts";

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
 * The posted flag is written as soon as that 2xx is read. A stale read of the
 * lease must not drop the result and leave the order in progress.
 */
export async function deliverPaidBooking(
  env: Env,
  deps: Deps,
  orderId: string,
  options: { respectSchedule?: boolean; timeoutMs?: number } = {},
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

  const saveWrite = async (write: SheetWrite) => {
    const latest = await getOrder(env.ORDERS, orderId);
    if (latest?.appsScriptLeaseToken && latest.appsScriptLeaseToken !== token) return;
    const next: StoredOrder = { ...claimed };
    next.appsScriptPostedNights = write.postedNights;
    if (write.confirmationSent) next.confirmationSent = true;
    next.updatedAt = nowIso;
    if (write.posted) {
      next.appsScriptPosted = true;
      next.failureReason = null;
      next.appsScriptNextAttemptAt = null;
      next.appsScriptLeaseToken = null;
      next.appsScriptLeaseUntil = null;
    }
    await putOrder(env.ORDERS, next);
    if (write.posted) await env.ORDERS.delete(unpostedKey(orderId));
    claimed.appsScriptPostedNights = next.appsScriptPostedNights;
    claimed.confirmationSent = next.confirmationSent;
    claimed.appsScriptPosted = next.appsScriptPosted;
    claimed.failureReason = next.failureReason;
    claimed.appsScriptNextAttemptAt = next.appsScriptNextAttemptAt;
    claimed.appsScriptLeaseToken = next.appsScriptLeaseToken;
    claimed.appsScriptLeaseUntil = next.appsScriptLeaseUntil;
    claimed.updatedAt = next.updatedAt;
  };

  const postStarted = Date.now();
  const result = await postPaidBooking(
    deps.fetch || fetch,
    env.APPS_SCRIPT_URL,
    claimed,
    env.APPS_SCRIPT_SHARED_SECRET,
    calendarBaseFor(claimed, env),
    { timeoutMs: options.timeoutMs, onWritten: saveWrite },
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
  if (claimed.appsScriptPosted) return "posted";
  const latest = await getOrder(env.ORDERS, orderId);
  if (latest?.appsScriptPosted) return "posted";
  if (latest?.appsScriptLeaseToken && latest.appsScriptLeaseToken !== token) return "skipped";

  claimed.appsScriptLeaseToken = null;
  claimed.appsScriptLeaseUntil = null;
  claimed.updatedAt = nowIso;
  if (result.ok) {
    claimed.appsScriptPosted = true;
    claimed.confirmationSent = result.confirmationSent;
    claimed.failureReason = null;
    claimed.appsScriptNextAttemptAt = null;
    await putOrder(env.ORDERS, claimed);
    await env.ORDERS.delete(unpostedKey(orderId));
    return "posted";
  }
  const attempts = (claimed.appsScriptAttempts || 0) + 1;
  claimed.appsScriptAttempts = attempts;
  claimed.appsScriptPosted = false;
  claimed.failureReason = result.error || "apps-script";
  claimed.appsScriptNextAttemptAt = new Date(nowMs + sheetBackoffMs(attempts)).toISOString();
  await putOrder(env.ORDERS, claimed);
  await env.ORDERS.put(unpostedKey(orderId), orderId, { expirationTtl: UNPOSTED_TTL_SEC });
  console.info(JSON.stringify({ msg: "sheet-post-failed", orderId, attempts, error: claimed.failureReason }));
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
