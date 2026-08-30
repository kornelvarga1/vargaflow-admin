import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleAccessToken, validateWebhookToken } from "../_shared/utils.ts";

// Retell "check_availability" tool target. Looks at the business's connected
// Google Calendar via freebusy.query and returns the next two open 1-hour
// slots in business hours, so the agent can offer real times instead of
// fixed copy.
//
// TODO: BUSINESS_TIMEZONE/BUSINESS_HOURS are hardcoded for now (all current
// demo businesses are fictional "greater metro area" ones) — make these
// per-business columns on voice_agents once a real client in a real timezone
// gets connected.
const BUSINESS_TIMEZONE = "America/New_York";
const BUSINESS_HOURS = { start: 8, end: 18 }; // 8am-6pm local, 1hr slots
const MIN_NOTICE_MINUTES = 30; // don't offer a slot starting sooner than this

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const headerSecret = req.headers.get("x-webhook-secret");
  const expectedSecret = Deno.env.get("VOICE_NOTIFY_WEBHOOK_SECRET");
  const headerOk = Boolean(expectedSecret) && headerSecret === expectedSecret;
  if (!headerOk && !validateWebhookToken(req, "VOICE_NOTIFY_WEBHOOK_SECRET")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const businessId = url.searchParams.get("business_id");
  if (!businessId) {
    return new Response(JSON.stringify({ error: "missing business_id" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: voiceAgent, error: vaError } = await supabase
    .from("voice_agents")
    .select("google_refresh_token, google_calendar_id")
    .eq("business_id", businessId)
    .maybeSingle();

  if (vaError || !voiceAgent?.google_refresh_token) {
    return new Response(JSON.stringify({ error: "calendar not connected for this business" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const calendarId = voiceAgent.google_calendar_id || "primary";
  const accessToken = await getGoogleAccessToken(voiceAgent.google_refresh_token);

  const now = new Date();
  const nowLocal = getLocalDateParts(now, BUSINESS_TIMEZONE);
  const windowStart = now;
  const windowEnd = zonedTimeToUtc(nowLocal.year, nowLocal.month, nowLocal.day + 4, 0, 0, BUSINESS_TIMEZONE);

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
    return new Response(JSON.stringify({ error: "could not read calendar" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const busy: { start: string; end: string }[] = fbData.calendars?.[calendarId]?.busy ?? [];

  const earliestAllowed = new Date(now.getTime() + MIN_NOTICE_MINUTES * 60 * 1000);
  const slots: { label: string; start_iso: string; end_iso: string }[] = [];

  for (let dayOffset = 0; dayOffset < 4 && slots.length < 2; dayOffset++) {
    for (let hour = BUSINESS_HOURS.start; hour < BUSINESS_HOURS.end && slots.length < 2; hour++) {
      const slotStart = zonedTimeToUtc(nowLocal.year, nowLocal.month, nowLocal.day + dayOffset, hour, 0, BUSINESS_TIMEZONE);
      const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
      if (slotStart < earliestAllowed) continue;

      const overlaps = busy.some((b) => slotStart < new Date(b.end) && slotEnd > new Date(b.start));
      if (overlaps) continue;

      slots.push({
        label: formatSlotLabel(slotStart, BUSINESS_TIMEZONE, dayOffset),
        start_iso: slotStart.toISOString(),
        end_iso: slotEnd.toISOString(),
      });
    }
  }

  return new Response(JSON.stringify({ slots }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
