# VargaFlow Admin

The CRM and automation engine behind VargaFlow, a done-for-you marketing system for home service contractors (roofers, plumbers, HVAC, electricians). Sales pipeline, contact management, message sequencing, browser-based calling, booking, and an automation monitor, running a real business rather than demonstrating one.

Built and operated solo.

## What it does

- **Sales pipeline and CRM** — contacts, stages, drag-to-advance board, outreach tracking
- **Automated sequences** — multi-step SMS and email flows with templated copy, dispatched from a queue
- **Two-way messaging** — inbound SMS handling with an AI text agent that qualifies and hands off
- **Browser calling** — outbound and inbound voice from the browser, with recordings and call logs
- **Booking** — self-built scheduling backed by Google Calendar, with self-serve reschedule and cancel
- **AI voice receptionist** — inbound call handling on Retell with ElevenLabs voices

## Architecture

```
lead form / webhook
        │
        ▼
  edge function  ──►  contacts  ──►  sequence steps queued
   (flow-*)                              │
                                         ▼
                                   message_queue
                                         │
                            cron-message-sender (every minute)
                                         │
                              ┌──────────┴──────────┐
                              ▼                     ▼
                       Twilio (SMS/voice)      Resend (email)
```

The admin UI reads and writes the same Postgres tables directly through Supabase with row-level security.

**Frontend** — React 18, TypeScript, Vite, Tailwind, shadcn/ui, Vitest, deployed on Vercel.

**Backend** — Supabase: Postgres with RLS, and a set of Deno edge functions split by responsibility:

| Kind | Role |
|---|---|
| `flow-*` | Triggered automations. Resolve settings, load sequence steps, queue messages. |
| `cron-message-sender` | Runs every minute, drains `message_queue` through Twilio and Resend. |
| `book-call` / `manage-booking` | Self-built booking against Google Calendar, replacing Calendly. |
| `twilio-token` / `voice-webhook` / `inbound-call` | Browser calling and voice routing. |
| `inbound-sms` | Inbound message handling and AI text agent. |

Most flow functions follow one pattern: `getSettings` + `getSequenceSteps` + `queueSteps`, shared from `supabase/functions/_shared/utils.ts`. A few schedule relative to a known time and deliberately do not.

## Problems worth reading the code for

- **`cron-message-sender`** — queue draining with per-channel dispatch, retry and quiet-hours handling, where most of the operational edge cases live.
- **`supabase/functions/_shared/`** — the shared sequence resolution and templating layer that keeps ~30 flow functions from duplicating each other.
- **Booking** — replacing a third-party scheduler meant handling timezones, availability windows, calendar conflicts and self-serve cancellation with tokenised links, and doing it without `window.confirm()`, which mobile webviews silently suppress.
- **Voice** — Twilio Voice SDK access tokens need a `cty` header and a matched key pair; get either wrong and you get an opaque `AccessTokenInvalid`.

## Running it

```bash
npm install
cp .env.example .env    # fill in your own Supabase project values
npm run dev             # port 8080
npm run test
npm run build
```

Deploy an edge function:

```bash
supabase functions deploy <name> --project-ref <ref>
# webhook receivers need --no-verify-jwt; config.toml is ignored on deploy
```

## Note on scope

This is production code for a live business, not a tutorial project. It carries the compromises that implies: some copy is hardcoded in TypeScript where it should be in the database, and a few flow functions bypass the shared sequence layer for timing reasons. Those are documented in `CLAUDE.md` rather than hidden.
