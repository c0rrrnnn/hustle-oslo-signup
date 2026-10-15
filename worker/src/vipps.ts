/** Test environment only. There is no setting that points this at api.vipps.no. */
export const VIPPS_API = "https://apitest.vipps.no";

const SYSTEM_HEADERS = {
  "Vipps-System-Name": "hustle-oslo",
  "Vipps-System-Version": "1.0.0",
  "Vipps-System-Plugin-Name": "hustle-oslo-signup",
  "Vipps-System-Plugin-Version": "1.0.0",
};

export interface VippsAmount {
  currency?: string;
  value?: number;
}

export interface VippsPayment {
  reference?: string;
  pspReference?: string;
  state?: string;
  amount?: VippsAmount;
  aggregate?: {
    authorizedAmount?: VippsAmount;
    capturedAmount?: VippsAmount;
    cancelledAmount?: VippsAmount;
    refundedAmount?: VippsAmount;
  };
  redirectUrl?: string;
}

export type VippsView =
  | { kind: "captured"; paymentId: string }
  | { kind: "authorized"; paymentId: string }
  | { kind: "failed"; reason: string }
  | { kind: "pending"; reason: string }
  | { kind: "mismatch"; reason: string };

interface TokenCacheEntry {
  token: string;
  exp: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

export function clearVippsTokenCache(): void {
  tokenCache.clear();
}

export function vippsPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (/^47\d{8}$/.test(digits)) return digits;
  if (/^\d{8}$/.test(digits)) return `47${digits}`;
  return null;
}

function amountMatches(amount: VippsAmount | undefined, expectedMinor: number): boolean {
  return amount?.currency === "NOK" && amount.value === expectedMinor;
}

/**
 * Read a server-side GET /epayment/v1/payments/{reference} body.
 * Webhook `name` and `amount` are not inputs.
 */
export function interpretVipps(payment: VippsPayment | null, expectedMinor: number): VippsView {
  if (!payment) return { kind: "pending", reason: "missing-payment" };
  const paymentId = payment.pspReference || payment.reference || "";
  if (!amountMatches(payment.amount, expectedMinor)) {
    return { kind: "mismatch", reason: "amount-mismatch" };
  }
  const captured = payment.aggregate?.capturedAmount;
  if (captured && (captured.value || 0) > 0) {
    if (amountMatches(captured, expectedMinor)) return { kind: "captured", paymentId };
    return { kind: "mismatch", reason: "partial-capture" };
  }
  const state = String(payment.state || "").toUpperCase();
  if (state === "ABORTED" || state === "EXPIRED" || state === "TERMINATED" || state === "CANCELLED") {
    return { kind: "failed", reason: state.toLowerCase() };
  }
  const authorized = payment.aggregate?.authorizedAmount;
  const authorizedOk = state === "AUTHORIZED" || amountMatches(authorized, expectedMinor);
  if (authorizedOk && (state === "AUTHORIZED" || (authorized?.value || 0) > 0)) {
    if (authorized && authorized.value !== undefined && !amountMatches(authorized, expectedMinor)) {
      return { kind: "mismatch", reason: "authorized-amount" };
    }
    return { kind: "authorized", paymentId };
  }
  return { kind: "pending", reason: state.toLowerCase() || "created" };
}

export interface VippsCreds {
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
  msn: string;
}

async function accessToken(fetcher: typeof fetch, creds: VippsCreds, nowMs: number): Promise<string> {
  const cached = tokenCache.get(creds.clientId);
  if (cached && cached.exp > nowMs + 30_000) return cached.token;
  const response = await fetcher(`${VIPPS_API}/accesstoken/get`, {
    method: "POST",
    headers: {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      "Ocp-Apim-Subscription-Key": creds.subscriptionKey,
      "Merchant-Serial-Number": creds.msn,
      "Content-Length": "0",
    },
  });
  const payload = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: string | number };
  if (!response.ok || !payload.access_token) {
    throw new Error(`Vipps auth failed (${response.status})`);
  }
  const expiresIn = Number(payload.expires_in || 3600);
  tokenCache.set(creds.clientId, { token: payload.access_token, exp: nowMs + expiresIn * 1000 });
  return payload.access_token;
}

function authedHeaders(token: string, creds: VippsCreds, idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Ocp-Apim-Subscription-Key": creds.subscriptionKey,
    "Merchant-Serial-Number": creds.msn,
    ...SYSTEM_HEADERS,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return headers;
}

export async function createVippsPayment(
  fetcher: typeof fetch,
  creds: VippsCreds,
  input: { reference: string; amountMinor: number; returnUrl: string; description: string; phone: string },
  nowMs: number,
): Promise<{ redirectUrl: string; reference: string }> {
  const token = await accessToken(fetcher, creds, nowMs);
  const body: Record<string, unknown> = {
    amount: { currency: "NOK", value: input.amountMinor },
    paymentMethod: { type: "WALLET" },
    reference: input.reference,
    returnUrl: input.returnUrl,
    userFlow: "WEB_REDIRECT",
    paymentDescription: input.description.slice(0, 100),
  };
  const phone = vippsPhone(input.phone);
  if (phone) body.customer = { phoneNumber: phone };
  const response = await fetcher(`${VIPPS_API}/epayment/v1/payments`, {
    method: "POST",
    headers: {
      ...authedHeaders(token, creds, input.reference),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { redirectUrl?: string; reference?: string };
  if (!response.ok || !payload.redirectUrl) {
    throw new Error(`Vipps create failed (${response.status})`);
  }
  return { redirectUrl: payload.redirectUrl, reference: payload.reference || input.reference };
}

export async function getVippsPayment(
  fetcher: typeof fetch,
  creds: VippsCreds,
  reference: string,
  nowMs: number,
): Promise<VippsPayment> {
  const token = await accessToken(fetcher, creds, nowMs);
  const response = await fetcher(`${VIPPS_API}/epayment/v1/payments/${encodeURIComponent(reference)}`, {
    method: "GET",
    headers: authedHeaders(token, creds),
  });
  const payload = (await response.json().catch(() => ({}))) as VippsPayment;
  if (!response.ok) throw new Error(`Vipps get failed (${response.status})`);
  return payload;
}

export async function captureVippsPayment(
  fetcher: typeof fetch,
  creds: VippsCreds,
  reference: string,
  amountMinor: number,
  nowMs: number,
): Promise<void> {
  const token = await accessToken(fetcher, creds, nowMs);
  const response = await fetcher(`${VIPPS_API}/epayment/v1/payments/${encodeURIComponent(reference)}/capture`, {
    method: "POST",
    headers: {
      ...authedHeaders(token, creds, `cap-${reference}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ modificationAmount: { currency: "NOK", value: amountMinor } }),
  });
  if (!response.ok) throw new Error(`Vipps capture failed (${response.status})`);
}
