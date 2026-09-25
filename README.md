# Hustle Oslo — class & social signup

Vanilla static signup page for Hustle Oslo classes and social nights at Sentralen.
Payment is **existing Vipps** to **Hustle Oslo #48782** (not Vipps Checkout). Payment proof is the **Vipps transaction number**.

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
| `app.js` | Wizard flow (4 steps), validation, Vipps + transaction # |
| `apps-script/Code.gs` | Google Apps Script: Sheet tabs, organizer notify, one attendee confirmation per booking |
| `README.md` | This file |

## Product rules (do not invent extras)

- **Class nights:** Beginners 18:00–19:00 · Intermediate 19:00–20:00 · Social 20:00–21:00  
- **Social-only nights:** Social 18:00–21:00  
- Once a date is chosen, that schedule appears **above** ticket/details fields.
- Class tickets: Beginners class 150/100 · Intermediate class 150/100 · 2 class bundle 220/150 · Social only 50. Class booking includes social after. Student = honour system. No caps.
- Social-only nights: 50 kr only.
- Book anytime before **18:00** on the day (Europe/Oslo). Past nights are hidden.
- First-timers: experience + how found are **optional** (shown unless they check “I’ve attended Hustle Oslo before”, which hides them). “Other” how-found requires a short reason only when selected.
- Optional phone (WhatsApp group help via accessible ? disclosure). Required Vipps **transaction #** as payment proof on the Details step.
- Cancel: DM [@hustleoslo](https://www.instagram.com/hustleoslo/) — payment transferable to next class.
- Flow: **Intro → Date → Ticket → Details → submit → confirmation** (no separate Pay step).
- On Details: amount + Vipps **#48782**; user sends the amount via existing Vipps, then pastes the **transaction #** and submits. Do **not** ask them to put anything special in the Vipps message.
- Confirmation echoes amount, Vipps #, transaction #, name, night, ticket, etc.

## Config

In `app.js`:

```js
const CONFIG = {
  APPS_SCRIPT_URL: "", // paste Web App URL after deploy
  VIPPS_NUMBER: "48782",
  ...
};
```

Leave `APPS_SCRIPT_URL` empty until Apps Script is deployed. The site still:

1. Shows Vipps instructions (#48782 + amount; pay first, then paste transaction #)  
2. Requires a Vipps transaction #, then queues the payload in `sessionStorage` under `hustleOsloSignups`  
3. Shows confirmation with amount, Vipps #, and transaction # (plus a warning that Claire still needs to wire the backend)  

When the URL is set, the same confirmation UI is used and the payload is `POST`ed as `text/plain` JSON (avoids CORS preflight issues with Apps Script). Payload includes `transactionNumber` and optional `phone`. Multi-night bookings POST one object per night. The last successful night sets `sendAttendeeConfirmation` and includes `confirmationNights` so the attendee gets one email listing the nights that saved.

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
```

Manual: pick a future date → confirm schedule block appears above tickets → choose ticket → on Details see amount + Vipps **#48782** → pay in Vipps → enter transaction # → submit → confirmation echoes amount, Vipps #, transaction #, name, night, ticket.

## Brand

- Colours: `#2e195e` `#fcf8e6` `#df8026` `#4e83b1` `#2b3e95`
- IG: https://www.instagram.com/hustleoslo/
