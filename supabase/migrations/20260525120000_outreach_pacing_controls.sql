-- Outreach pacing controls: daily cap with even distribution, day-of-week filter, UI-configurable timezone.
-- Supersedes outbound_rate_per_hour (column kept for back-compat; cron now ignores it unless hourly_throttle is set).

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS daily_send_cap INTEGER NOT NULL DEFAULT 20,
  -- 0=Sun, 1=Mon, ... 6=Sat. Default: Mon-Fri.
  ADD COLUMN IF NOT EXISTS send_days_of_week INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  -- IANA timezone string. Default Central since first campaigns target KC plumbers.
  ADD COLUMN IF NOT EXISTS outreach_timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  -- Optional ceiling on top of distribution pacing. NULL = pacing-only.
  ADD COLUMN IF NOT EXISTS hourly_throttle INTEGER;
