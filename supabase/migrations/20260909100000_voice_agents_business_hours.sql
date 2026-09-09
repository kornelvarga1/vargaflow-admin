-- Per-business timezone and business hours for the voice receptionist.
--
-- voice-check-availability had BUSINESS_TIMEZONE = 'America/New_York' and
-- 8am-6pm hardcoded, which was fine while every business was a fictional
-- "greater metro area" demo. The first real-timezone client makes it wrong:
-- the agent offers Eastern times to a caller in Denver.
--
-- Defaults match the old hardcoded values exactly, so existing rows keep
-- behaving as they did until someone sets them.

alter table public.voice_agents
  add column if not exists timezone text not null default 'America/New_York',
  add column if not exists hours_start smallint not null default 8,
  add column if not exists hours_end smallint not null default 18;

-- Hours are whole local hours on a 24h clock, and a slot needs somewhere to
-- start, so end must be strictly after start.
alter table public.voice_agents
  drop constraint if exists voice_agents_hours_valid;

alter table public.voice_agents
  add constraint voice_agents_hours_valid
  check (
    hours_start >= 0 and hours_start <= 23
    and hours_end >= 1 and hours_end <= 24
    and hours_end > hours_start
  );

comment on column public.voice_agents.timezone is
  'IANA timezone the business operates in (e.g. America/Denver). Slot labels the agent speaks are rendered in this zone.';
comment on column public.voice_agents.hours_start is
  'First bookable hour, local to timezone. 8 = slots may start at 8:00am.';
comment on column public.voice_agents.hours_end is
  'Last bookable hour boundary, local to timezone. 18 = the final slot starts at 5:00pm and ends at 6:00pm.';
