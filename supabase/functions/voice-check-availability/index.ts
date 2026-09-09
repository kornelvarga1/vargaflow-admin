import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleAccessToken, validateWebhookToken } from "../_shared/utils.ts";

// Retell "check_availability" tool target. Reads the business's connected
// Google Calendar via freebusy.query and returns real open slots.
//
// Takes an optional caller preference (`time_of_day`, `day_preference`) so the
// agent can answer "anything in the afternoon?" or "do you have tomorrow?" by
// calling again with the preference, instead of dead-ending. The previous
// version took no arguments and stopped at the first two open hours it found,
// which in practice meant it always offered the same two consecutive morning
// slots and told the caller nothing else existed.
//
// Timezone and business hours come from the voice_agents row per business.

const SLOT_MINUTES = 60;
const MIN_NOTICE_MINUTES = 30; // don't offer a slot starting sooner than this
const SEARCH_DAYS = 7; // how far ahead to look
const MAX_SLOTS = 3; // how many to hand back to the agent

// Local-hour ranges for a spoken time-of-day, clamped to business hours later.
const TIME_OF_DAY_RANGES: Record<string, { start: number; end: number }> = {
  morning: { start: 0, end: 12 },
  afternoon: { start: 12, end: 17 },
  evening: { start: 17, end: 24 },
  any: { start: 0, end: 24 },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
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

function getLocalDateParts(date: Date, timeZone: string) {
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

function formatSlotLabel(utcDate: Date, timeZone: string, dayOffset: number): string {
  const timeStr = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(utcDate);
  let dayLabel: string;
  if (dayOffset === 0) dayLabel = "today";
  else if (dayOffset === 1) dayLabel = "tomorrow";
  else dayLabel = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(utcDate);
  return `${dayLabel} at ${timeStr}`;
}

// Retell sends tool arguments as a JSON body; a bare call has no body at all.
async function readPreferences(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    // A malformed body is not worth failing the call over — the caller just
    // gets the default spread, which is always a valid answer.
    body = {};
  }

  const rawTod = String(body.time_of_day ?? "any").toLowerCase().trim();
  const timeOfDay = rawTod in TIME_OF_DAY_RANGES ? rawTod : "any";

  const rawDay = String(body.day_preference ?? "any").toLowerCase().trim();
  const dayPreference = ["today", "tomorrow", "this_week", "any"].includes(rawDay) ? rawDay : "any";

  return { timeOfDay, dayPreference };
}

/**
 * Pick a spread rather than the first N consecutive hours.
 *
 * Offering "8am or 9am" is a worse answer than "8am or 2pm" even when both are
 * free: two adjacent slots read to the caller as "that's all there is." So take
 * at most two per day, and require a gap between same-day picks.
 */
function pickSpread(candidates: { label: string; start_iso: string; end_iso: string; dayOffset: number; hour: number }[]) {
  const chosen: typeof candidates = [];
  const perDay = new Map<number, number>();

  for (const slot of candidates) {
    if (chosen.length >= MAX_SLOTS) break;
    const takenToday = perDay.get(slot.dayOffset) ?? 0;
    if (takenToday >= 2) continue;

    const sameDayPick = chosen.find((c) => c.dayOffset === slot.dayOffset);
    if (sameDayPick && Math.abs(slot.hour - sameDayPick.hour) < 3) continue;

    chosen.push(slot);
    perDay.set(slot.dayOffset, takenToday + 1);
  }

  // A day so full that the spread rules rejected everything still beats
  // telling the caller there is nothing.
  if (chosen.length === 0) chosen.push(...candidates.slice(0, MAX_SLOTS));

  return chosen.map(({ label, start_iso, end_iso }) => ({ label, start_iso, end_iso }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const headerSecret = req.headers.get("x-webhook-secret");
  const expectedSecret = Deno.env.get("VOICE_NOTIFY_WEBHOOK_SECRET");
  const headerOk = Boolean(expectedSecret) && headerSecret === expectedSecret;
  if (!headerOk && !validateWebhookToken(req, "VOICE_NOTIFY_WEBHOOK_SECRET")) {
    return json(401, { error: "unauthorized" });
  }

  const url = new URL(req.url);
  const businessId = url.searchParams.get("business_id");
  if (!businessId) return json(400, { error: "missing business_id" });

  const { timeOfDay, dayPreference } = await readPreferences(req);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: voiceAgent, error: vaError } = await supabase
    .from("voice_agents")
    .select("google_refresh_token, google_calendar_id, timezone, hours_start, hours_end")
    .eq("business_id", businessId)
    .maybeSingle();

  if (vaError || !voiceAgent?.google_refresh_token) {
    return json(400, { error: "calendar not connected for this business" });
  }

  const timeZone = voiceAgent.timezone || "America/New_York";
  const hoursStart = voiceAgent.hours_start ?? 8;
  const hoursEnd = voiceAgent.hours_end ?? 18;
  const calendarId = voiceAgent.google_calendar_id || "primary";
  const accessToken = await getGoogleAccessToken(voiceAgent.google_refresh_token);

  const now = new Date();
  const nowLocal = getLocalDateParts(now, timeZone);

  // Only fetch the days we could actually offer, so a "tomorrow" ask doesn't
  // pull a week of busy blocks.
  const firstDay = dayPreference === "tomorrow" ? 1 : 0;
  const lastDay =
    dayPreference === "today" ? 0 :
    dayPreference === "tomorrow" ? 1 :
    SEARCH_DAYS - 1;

  const windowStart = firstDay === 0 ? now : zonedTimeToUtc(nowLocal.year, nowLocal.month, nowLocal.day + firstDay, 0, 0, timeZone);
  const windowEnd = zonedTimeToUtc(nowLocal.year, nowLocal.month, nowLocal.day + lastDay + 1, 0, 0, timeZone);

  const fbRes = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      items: [{ id: calendarId }],
    }),
  });
  const fbData = await fbRes.json();
  if (!fbRes.ok) {
    console.error("[voice-check-availability] freebusy error", fbData);
    return json(502, { error: "could not read calendar" });
  }
  const busy: { start: string; end: string }[] = fbData.calendars?.[calendarId]?.busy ?? [];

  const earliestAllowed = new Date(now.getTime() + MIN_NOTICE_MINUTES * 60 * 1000);
  const preferred = TIME_OF_DAY_RANGES[timeOfDay];
  const hourFrom = Math.max(hoursStart, preferred.start);
  const hourTo = Math.min(hoursEnd, preferred.end);

  const candidates: { label: string; start_iso: string; end_iso: string; dayOffset: number; hour: number }[] = [];

  for (let dayOffset = firstDay; dayOffset <= lastDay; dayOffset++) {
    for (let hour = hourFrom; hour < hourTo; hour++) {
      const slotStart = zonedTimeToUtc(nowLocal.year, nowLocal.month, nowLocal.day + dayOffset, hour, 0, timeZone);
      const slotEnd = new Date(slotStart.getTime() + SLOT_MINUTES * 60 * 1000);
      if (slotStart < earliestAllowed) continue;
      if (busy.some((b) => slotStart < new Date(b.end) && slotEnd > new Date(b.start))) continue;

      candidates.push({
        label: formatSlotLabel(slotStart, timeZone, dayOffset),
        start_iso: slotStart.toISOString(),
        end_iso: slotEnd.toISOString(),
        dayOffset,
        hour,
      });
    }
  }

  const slots = pickSpread(candidates);

  // The agent needs to know whether "anything else?" is worth asking about, and
  // whether a narrowed search came back empty because of the narrowing.
  return json(200, {
    slots,
    total_open: candidates.length,
    more_available: candidates.length > slots.length,
    searched: {
      time_of_day: timeOfDay,
      day_preference: dayPreference,
      days_ahead: lastDay - firstDay + 1,
      business_hours: `${hoursStart}:00-${hoursEnd}:00 ${timeZone}`,
    },
  });
});
