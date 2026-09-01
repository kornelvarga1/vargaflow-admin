// Availability-math helpers for the self-built booking system. Adapted from
// voice-check-availability/index.ts (which only needs the first 2 slots for
// a spoken offer) into a general "give me every open slot in the window"
// function for a day-picker UI. All slot math happens in UTC; the caller's
// `timezone` param only controls which local hours count as "working hours."

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID } from "./utils.ts";

export async function getBookingCalendarConnection(
  supabase: SupabaseClient
): Promise<{ refreshToken: string; calendarId: string } | null> {
  const { data, error } = await supabase
    .from("booking_calendar_connection")
    .select("google_refresh_token, google_calendar_id")
    .eq("business_id", ADMIN_BUSINESS_ID)
    .maybeSingle();
  if (error || !data?.google_refresh_token) return null;
  return { refreshToken: data.google_refresh_token, calendarId: data.google_calendar_id || "primary" };
}

// Recheck a single exact slot immediately before writing a booking, to
// narrow (not eliminate) the double-booking race window between a viewer
// loading the picker and submitting the form.
export async function isSlotFree(
  accessToken: string,
  calendarId: string,
  startIso: string,
  endIso: string
): Promise<boolean> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: startIso, timeMax: endIso, items: [{ id: calendarId }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`freebusy check failed: ${JSON.stringify(data)}`);
  const busy: { start: string; end: string }[] = data.calendars?.[calendarId]?.busy ?? [];
  return busy.length === 0;
}

export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(utcGuess).map((p) => [p.type, p.value]));
  const hourNum = parts.hour === "24" ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hourNum, Number(parts.minute), Number(parts.second));
  const diff = asIfUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - diff);
}

export function getLocalDateParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function getLocalDayOfWeek(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  const label = fmt.format(date);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[label] ?? new Date(date).getUTCDay();
}

// A bookable window applying to a subset of weekdays (0=Sun..6=Sat), with
// start/end expressed as minutes-from-midnight so half-hour boundaries
// (e.g. 20:30 = 1230) are representable. Two windows (weekday/weekend) can
// cover different days with different hours.
export interface DayWindow {
  daysOfWeek: number[];
  startMinutes: number;
  endMinutes: number;
}

export interface AvailabilityConfig {
  timezone: string;
  windows: DayWindow[];
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  windowDays: number;
}

export interface Slot {
  start_iso: string;
  end_iso: string;
}

// Returns every open slot (not overlapping any busy block, respecting the
// applicable window's hours/days plus buffer/min-notice) across
// `windowDays` days starting today, in Kornél's own working-hours timezone.
export function computeAvailableSlots(
  busy: { start: string; end: string }[],
  config: AvailabilityConfig
): Slot[] {
  const { timezone, windows, slotMinutes, bufferMinutes, minNoticeMinutes, windowDays } = config;
  const now = new Date();
  const nowLocal = getLocalDateParts(now, timezone);
  const earliestAllowed = new Date(now.getTime() + minNoticeMinutes * 60 * 1000);
  const slots: Slot[] = [];

  for (let dayOffset = 0; dayOffset < windowDays; dayOffset++) {
    const dayStartUtc = zonedTimeToUtc(nowLocal.year, nowLocal.month, nowLocal.day + dayOffset, 0, 0, timezone);
    const dow = getLocalDayOfWeek(dayStartUtc, timezone);
    const window = windows.find((w) => w.daysOfWeek.includes(dow));
    if (!window) continue;

    for (let minutesFromMidnight = window.startMinutes; minutesFromMidnight < window.endMinutes; minutesFromMidnight += slotMinutes) {
      if (minutesFromMidnight + slotMinutes > window.endMinutes) continue; // don't spill past close
      const hour = Math.floor(minutesFromMidnight / 60);
      const minute = minutesFromMidnight % 60;
      const slotStart = zonedTimeToUtc(nowLocal.year, nowLocal.month, nowLocal.day + dayOffset, hour, minute, timezone);
      const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60 * 1000);
      if (slotStart < earliestAllowed) continue;

      const bufferedStart = new Date(slotStart.getTime() - bufferMinutes * 60 * 1000);
      const bufferedEnd = new Date(slotEnd.getTime() + bufferMinutes * 60 * 1000);
      const overlaps = busy.some((b) => bufferedStart < new Date(b.end) && bufferedEnd > new Date(b.start));
      if (overlaps) continue;

      slots.push({ start_iso: slotStart.toISOString(), end_iso: slotEnd.toISOString() });
    }
  }

  return slots;
}
