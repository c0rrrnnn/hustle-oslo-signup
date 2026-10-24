/**
 * Per-isolate throttle for Stripe and Vipps reads. A poll must not write KV
 * just to remember that it already asked. Another isolate may read again.
 */
const checkedAt = new Map<string, number>();

export function providerCheckedRecently(orderId: string, nowMs: number, throttleMs: number): boolean {
  const previous = checkedAt.get(orderId);
  if (previous !== undefined && nowMs - previous < throttleMs) return true;
  checkedAt.set(orderId, nowMs);
  return false;
}

export function markProviderChecked(orderId: string, nowMs: number): void {
  checkedAt.set(orderId, nowMs);
}

/** Tests share one process. A new in-memory store starts a new throttle. */
export function clearProviderChecks(): void {
  checkedAt.clear();
}
