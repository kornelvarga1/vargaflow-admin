# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server on http://localhost:8080
npm run build        # Production build
npm run lint         # ESLint checks
npm run test         # Run tests once
npm run test:watch   # Run tests in watch mode
npm run preview      # Preview production build
```

## Architecture

**VargaFlow** is a CRM application built with React + TypeScript + Vite, using Supabase as the backend (PostgreSQL + Edge Functions).

### Frontend Structure

- `src/pages/` — Route-level page components (one per route)
- `src/components/` — Reusable components; `ui/` contains shadcn-ui primitives
- `src/hooks/` — Data-fetching and business logic hooks (React Query)
- `src/integrations/supabase/` — Supabase client + auto-generated TypeScript types from the DB schema

**Routes** (`src/App.tsx`):
- `/` — Dashboard with KPIs and activity feed
- `/contacts` / `/contacts/:id` — Contact list and profile
- `/pipeline/sales` — Sales kanban board (drag-and-drop)
- `/pipeline/onboarding` — Onboarding kanban board
- `/sequences` — Automation sequence monitor
- `/messages` — Message queue / inbox
- `/settings` — App configuration

**Key patterns:**
- All Supabase queries go through React Query hooks in `src/hooks/`
- TypeScript types are auto-generated at `src/integrations/supabase/types.ts` — do not hand-edit
- Path alias `@/` maps to `src/`
- Forms use React Hook Form + Zod validation
- `src/components/layout/AppLayout.tsx` wraps every page with sidebar (desktop) and bottom nav (mobile)

### Backend (Supabase Edge Functions)

`supabase/functions/` contains Deno-based Edge Functions for contact lifecycle automation:

- `flow-*` functions — Triggered by contact events (lead form, call booked, no-contact attempts, cancellations, closures, no-shows, onboarding stages)
- `cron-message-sender` — Scheduled dispatcher that sends queued SMS (Twilio) and Email (Resend) messages

Edge functions are written in TypeScript/Deno and deployed via Supabase CLI.

### Key Dependencies

| Purpose | Library |
|---|---|
| UI components | shadcn-ui (Radix UI primitives) |
| Styling | Tailwind CSS |
| Server state | TanStack React Query |
| Forms | React Hook Form + Zod |
| Drag & drop | @hello-pangea/dnd |
| Charts | Recharts |
| Notifications | Sonner |
| Email | Resend |
| SMS | Twilio |

## Project Details
- Supabase Project ID: zfmchywjmgykmlhjihls
- Deploy command: `supabase functions deploy <function-name> --project-ref zfmchywjmgykmlhjihls`
- Twilio number: +18889959616 (toll-free, verification pending)

## Database Tables
- `contacts` — core contact/lead record (full_name, phone, email, pipeline, stage, tags)
- `sequences` — automation flow definitions (name, pipeline, stage, is_active)
- `sequence_steps` — steps per sequence (sequence_id, step_order, delay_hours, delay_minutes, message_type, message_template)
- `message_queue` — queued outbound messages (contact_id, message_type, message_content, scheduled_at, status, metadata)
- `settings` — single row of custom values (my_name, my_phone, my_email, company_name, website_url, software_explanation_video, testimonials_link, case_study_link, demo_calendar_link, launch_call_calendar_link, onboarding_form_link, instagram_url)
- `automation_logs` — log of every flow run
- `processed_webhooks` — dedup table for Calendly webhooks

## Shared Utilities
- `supabase/functions/_shared/utils.ts` — shared helpers used by all Edge Functions:
  - `getSettings(supabase)` — fetches settings row
  - `getSequenceSteps(supabase, sequenceName)` — fetches steps for a sequence by name
  - `resolveTemplate(template, contact, settings)` — resolves {{variables}} in message templates
  - `queueSteps(supabase, contactId, steps, contact, settings)` — queues all steps into message_queue

## Edge Functions
- `flow-call-booked` — Calendly webhook → books zoom call, time-relative reminders, YES/NO branch
- `flow-lead-form-submitted` — lead form → queues Flow #1 steps
- `flow-no-contact-1/2/3` — no reply followup sequences
- `flow-long-term-nurture` — 12-week nurture sequence
- `flow-no-show` — no showed zoom followup
- `flow-cancelled` — cancelled/rescheduled followup
- `flow-client-closed` — moves contact to onboarding pipeline
- `flow-ob-client-signup` — sends onboarding email + SMS immediately
- `flow-ob-form-reminder` — 48hr loop until form submitted
- `flow-ob-form-submitted` — removes tag, moves stage, sends GMB SMS
- `flow-ob-project-ready` — 7-day project timeline SMS sequence
- `flow-ob-launch-call` — launch call booked, time-relative reminders
- `cron-message-sender` — runs every minute, sends pending messages from message_queue

## Important Notes
- Special-case functions (flow-call-booked, flow-ob-launch-call, flow-ob-client-signup, flow-ob-form-reminder) do NOT use queueSteps — they have time-relative scheduling or immediate sends
- All other functions use getSettings + getSequenceSteps + queueSteps from _shared/utils.ts
- Sequence names in DB use em dashes (—) e.g. "Flow #1 — Lead Form Submitted"
- message_queue columns: id, contact_id, contact_sequence_id, message_type, message_content, scheduled_at, status, sent_at, created_at, metadata