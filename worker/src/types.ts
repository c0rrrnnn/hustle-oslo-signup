export interface OrderKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
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
}

export interface Deps {
  fetch?: typeof fetch;
  now?: () => Date;
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
  confirmationSent: boolean;
  failureReason: string | null;
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
