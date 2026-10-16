# Hustle Oslo — class & social signup

Vanilla static signup page for Hustle Oslo classes and social nights at Sentralen.
The booking sheet follows Claire’s approved screens. Online card, Apple Pay, Google Pay, and Vipps checkout call `startPayment()` only when `CONFIG.PAYMENTS_ENABLED` is true. That flag stays `false` on main: Pay still saves the booking to Apps Script and the confirmation is marked **payment pending** (pay with Vipps to **Hustle Oslo #48782**). The test-mode Cloudflare Worker lives in `worker/`. Setup, keys, and the Monday pilot are in `worker/SETUP.md`. Do not put API keys in this repo.

English only · mobile-first · WCAG 2.2 AA aimed.

## Local preview

From this folder:

```bash
python3 -m http.server 8765
```

Open http://localhost:8765/

A preview server may already be running on port **8765** on the shared box.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | Markup (semantic form, skip link, live regions) |
| `styles.css` | Brand + WCAG-oriented styles |
| `assets/hero.mp4` | Intro hero loop (muted, no audio). 676 KB, 768×576, H.264, faststart. Compressed from the 1.9 MB 1024×768 source. |
| `assets/hero-poster.jpg` | First-frame still (41 KB) for reduced motion and before playback. |
| `events.js` | Upcoming nights + ticket catalogue (edit here for new dates) |
| `app.js` | Booking sheet, validation, Apps Script submit, `startPayment()` |
| `apps-script/Code.gs` | Google Apps Script: Sheet tabs, organizer notify, one attendee confirmation per booking |
| `worker/` | Test-mode Cloudflare Worker for Stripe and Vipps. Not deployed from this repo by itself. |
| `README.md` | This file |

## Product rules (do not invent extras)

- **Class nights:** Beginners 18:00–19:00 · Intermediate 19:00–20:00 · Social 20:00–21:00  
- **Social-only nights:** Social 18:00–20:00  
- Class tickets: Beginner class 150/100 · Intermediate class 150/100 · 2 class bundle 220/150 (Save 15%) · Social only 50. Class booking includes social after. Student = honour system, chosen on the first sheet step. No caps.
- Social-only nights: 50 kr only.
- Book anytime before **18:00** on the day (Europe/Oslo). Past nights are hidden.
- Flow: **Intro (landing) → Are you a student? → Select a date → Confirm selection → Your details → Checkout → confirmation**. On screens wider than 600px, details and checkout are one screen (details on the left, order on the right). Payment failure stays on a Checkout screen with the error banner and another attempt.
- First-timers: experience and “how did you find us?” are optional, and hidden when “I’ve danced with Hustle Oslo before” is checked. “Other” reveals a short text field.
- Optional phone, with a ? disclosure about the WhatsApp group.
- Checkout has no terms checkbox. Paying accepts the Terms of Sale and refund policy (`/termsofsale`, version `v1.0`).
- While `PAYMENTS_ENABLED` is false, Pay does not charge a card. It posts the booking with `transactionNumber: "payment-pending"` and does not call the worker. Card fields are placeholders and are never submitted.
- `startPayment(method, order)` is the only function that talks to the payment worker, and only when `PAYMENTS_ENABLED` is true and `PAYMENTS_WORKER_URL` is set. The worker prices the order. The browser never sends a price it expects to be charged. Do not put API keys in the repo.

## Config

In `app.js`:

```js
const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/…/exec",
  PAYMENTS_ENABLED: false,
  PAYMENTS_WORKER_URL: "",
  VIPPS_NUMBER: "48782",
  TERMS_VERSION: "v1.0",
};
```

`PAYMENTS_ENABLED` stays `false` on main. Pay posts the same per-night JSON as before (`text/plain`, so Apps Script does not CORS-preflight), including the original fields plus `experience`, `referral`, `referralOther`, `paymentMethod`, `termsAccepted`, `termsAcceptedAt`, and `termsVersion`. `transactionNumber` is `payment-pending` so the script accepts the row without `SHARED_SECRET`. `howFound` / `howFoundOther` stay filled from the referral answers.

When the flag is later turned on, the worker — not the browser — writes the paid rows. Those requests include `SHARED_SECRET`, `paymentProvider`, `paymentId`, and `paymentStatus: "paid"`. The script rejects a paid claim that does not have the matching script property. See `worker/SETUP.md`.

Multi-night bookings POST one object per night. The last successful night sets `sendAttendeeConfirmation` and includes `confirmationNights`. Re-deploy Apps Script (**Deploy → Manage deployments → New version**) before the new columns and the “payment pending” email wording are stored. Until then, extra JSON fields are ignored and the email may show the literal transaction value `payment-pending`.

---

## Deploy: GitHub Pages (static site)

Primary public URL: **https://hustleoslo.com/**

The GitHub Pages project URL (`https://c0rrrnnn.github.io/hustle-oslo-signup/`) still works as a fallback. Assets are relative (`styles.css`, `app.js`, `events.js`), so the same files load on both the apex custom domain and the project Pages URL.

`CNAME` (repo root) is `hustleoslo.com`.

1. Create a public GitHub repo (e.g. `hustle-oslo-signup`).
2. Push the contents of this folder (you can omit nothing — `apps-script/` is documentation for Claire, harmless on Pages).
3. Repo **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: `main` (or `gh-pages`), folder `/` (root)
   - Custom domain: `hustleoslo.com` (set by the root `CNAME` file)
4. Wait a minute; open https://hustleoslo.com/ (fallback: `https://c0rrrnnn.github.io/hustle-oslo-signup/`).

No build step. No npm. Edit `events.js` when dates change and push.

**Do not put passwords, sheet IDs, or private keys in the repo or in chat.** The spreadsheet ID lives only in Apps Script Script Properties.

---

## Deploy: Google Sheet + Apps Script

### A. Create the Sheet

1. Google Drive → New → Google Sheets → name it e.g. **Hustle Oslo Signups**.
2. Copy the spreadsheet ID from the URL:  
   `https://docs.google.com/spreadsheets/d/`**`THIS_IS_THE_ID`**`/edit`

### B. Install the script

1. In the Sheet: **Extensions → Apps Script**.
2. Delete any stub code. Paste the contents of `apps-script/Code.gs`.
3. Save the project (name e.g. `Hustle Oslo Signup`).

### C. Script properties (no secrets in front-end)

1. Apps Script gear icon → **Project settings → Script properties**.
2. Add:
   - `SHEET_ID` = the spreadsheet ID from step A  
   - `NOTIFY_EMAIL` = `hustleinoslo@gmail.com` (optional; Code.gs defaults to this)
   - `APPS_SCRIPT_SHARED_SECRET` = the same random value set on the worker (see `worker/SETUP.md`). Public payment-pending signups do not send it. Paid posts from the worker are rejected without it.

### D. Deploy as Web App

1. **Deploy → New deployment**
2. Type: **Web app**
3. Description: e.g. `signup v1`
4. **Execute as:** Me  
5. **Who has access:** Anyone  
6. Deploy → authorize Google account when prompted  
7. Copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`)

### E. Wire the front-end

1. Open `app.js`.
2. Set `CONFIG.APPS_SCRIPT_URL` to that Web app URL.
3. Commit & push (or re-upload to Pages). Re-test one signup.

### What the script does

- Creates/uses tab **All signups** (master).
- Creates/uses one tab per event (e.g. `2026-09-28 Class Kronesalen`).
- Appends a row to both.
- Emails `hustleinoslo@gmail.com` on each night (organizer notify) with name, ticket, amount, transaction #, and phone (if given).
- Emails the attendee **once per booking** at the address they registered, from `hustleinoslo@gmail.com` (MailApp display name **Hustle Oslo**, reply-to `hustleinoslo@gmail.com`). Several nights in one signup are listed in that single email. Nights whose POST failed are left off.

Re-deploy the Web App after editing `Code.gs` (**Deploy → Manage deployments → Edit → New version**). Pasting the file is not enough: attendee confirmation is sent by the script, so a **new deployment version** is required before those emails go out. The existing Web App URL in `app.js` stays the same.

---

## Editing events

Update `events.js` only. Keep `weekday` correct (2026 class/social dates in the brief are Mondays). Hide-past logic uses Europe/Oslo and treats a night as closed at 18:00 on that date.

## Smoke checks

```bash
node --check app.js
node --check events.js
cd worker && npm test
```

Manual: Register → student Yes/No → pick a dotted date and a class → confirm → details → checkout → Pay. With `PAYMENTS_ENABLED` false, Pay does not call the worker. The booking is stored as `payment-pending`, and the confirmation subtitle is “Confirmation sent to {email}” when Apps Script sends the mail. Card numbers are not in the Apps Script payload. Do not point a test at the live Apps Script URL unless you mean to add a row.

## Brand

- Colours: `#2e195e` `#fcf8e6` `#df8026` `#4e83b1` `#2b3e95`
- IG: https://www.instagram.com/hustleoslo/
