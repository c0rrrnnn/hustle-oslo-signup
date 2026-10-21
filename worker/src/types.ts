export interface OrderKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface Env {
  ORDERS: OrderKv;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PUBLISHABLE_KEY: string;
  VIPPS_CLIENT_ID: string;
  VIPPS_CLIENT_SECRET: string;
  VIPPS_SUBSCRIPTION_KEY: string;
  VIPPS_MSN: string;
  APPS_SCRIPT_SHARED_SECRET: string;
  ADMIN_SECRET: string;
  CAPTURE_MODE?: string;
  APPS_SCRIPT_URL: string;
  PUBLIC_SITE_URL: string;
  ALLOWED_ORIGINS: string;
  /** "true" allows live Stripe keys and https://api.vipps.no. Leave unset or "false". */
  ALLOW_LIVE_PAYMENTS?: string;
  /** Only https://api.vipps.no is honored, and only when ALLOW_LIVE_PAYMENTS is "true". */
  VIPPS_API_BASE?: string;
  /** Secret returned once when the Vipps webhook is registered. */
  VIPPS_WEBHOOK_SECRET?: string;
  /** Public https origin of this worker. Used when an order has no stored origin. */
  WORKER_PUBLIC_URL?: string;
}

export interface Deps {
  fetch?: typeof fetch;
  now?: () => Date;
  /** Keeps work running after the webhook response. Tests collect these promises. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type PayMethod = "card" | "apple" | "google" | "vipps";
export type Provider = "stripe" | "vipps";
export type CaptureMode = "immediate" | "reserve";
export type OrderStatus = "pending" | "reserved" | "paid" | "failed";

export interface SignupMeta {
  experience: string;
  experienceLabel: string;
  referral: string;
  referralLabel: string;
  referralOther: string;
  howFound: string;
  howFoundLabel: string;
  howFoundOther: string;
  isRepeat: boolean;
  termsAcceptedAt: string;
  termsVersion: string;
}

export interface PricedNight {
  eventId: string;
  eventDate: string;
  eventType: string;
  eventLocation: string;
  eventLabel: string;
  eventVenue: string;
  eventStart: string;
  eventEnd: string;
  sheetTabHint: string;
  ticketId: string;
  ticketName: string;
  priceTier: "standard" | "student";
  amount: number;
}

export interface StoredOrder {
  orderId: string;
  fingerprint: string;
  status: OrderStatus;
  currency: "NOK";
  amountNok: number;
  amountMinor: number;
  provider: Provider;
  method: PayMethod;
  paymentId: string | null;
  clientSecret: string | null;
  redirectUrl: string | null;
  customer: { fullName: string; email: string; phone: string };
  nights: PricedNight[];
  meta: SignupMeta;
  captureMode: CaptureMode;
  returnUrl: string;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  providerStatus: string | null;
  appsScriptPosted: boolean;
  appsScriptPostedNights: number;
  appsScriptAttempts: number;
  appsScriptNextAttemptAt: string | null;
  appsScriptLeaseUntil: string | null;
  appsScriptLeaseToken: string | null;
  checkoutLeaseUntil: string | null;
  checkoutLeaseToken: string | null;
  /** Legacy field. Polls keep this throttle in memory and no longer write it. */
  vippsCheckedAt: string | null;
  /** Legacy field. Polls keep this throttle in memory and no longer write it. */
  stripeCheckedAt?: string | null;
  confirmationSent: boolean;
  failureReason: string | null;
  /** Origin of the checkout request, so confirmation mail can link to GET /ics. */
  workerOrigin?: string;
}

export interface CheckoutInput {
  idempotencyKey: string;
  method: PayMethod;
  customer: { fullName: string; email: string; phone: string };
  nights: PricedNight[];
  amountNok: number;
  amountMinor: number;
  meta: SignupMeta;
  returnUrl: string;
}
