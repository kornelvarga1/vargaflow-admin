import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID, getGoogleAccessToken, getSettings } from "../_shared/utils.ts";
import { computeAvailableSlots, getBookingCalendarConnection } from "../_shared/calendarAvailability.ts";

// Public endpoint the booking widget polls to render the day/time picker.
// Reads Kornél's connected Google Calendar freebusy + his working-hours
// settings, returns every open slot (UTC ISO) for the next ~14 days.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WINDOW_DAYS = 14;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const connection = await getBookingCalendarConnection(supabase);
    if (!connection) {
      return new Response(JSON.stringify({ error: "booking calendar not connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const settings = await getSettings(supabase, ADMIN_BUSINESS_ID);
    const calendarId = connection.calendarId;
    const accessToken = await getGoogleAccessToken(connection.refreshToken);

    const now = new Date();
    const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const fbRes = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin: now.toISOString(),
        timeMax: windowEnd.toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    const fbData = await fbRes.json();
    if (!fbRes.ok) {
      console.error("[get-availability] freebusy error", fbData);
      return new Response(JSON.stringify({ error: "could not read calendar" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const busy: { start: string; end: string }[] = fbData.calendars?.[calendarId]?.busy ?? [];

    const windows = [
      {
        daysOfWeek: settings.booking_days_of_week ?? [1, 2, 3, 4, 5],
        startMinutes: settings.booking_hours_start ?? 540,
        endMinutes: settings.booking_hours_end ?? 1020,
      },
    ];
    if (settings.booking_weekend_hours_start != null && settings.booking_weekend_hours_end != null) {
      windows.push({
        daysOfWeek: settings.booking_weekend_days_of_week ?? [0, 6],
        startMinutes: settings.booking_weekend_hours_start,
        endMinutes: settings.booking_weekend_hours_end,
      });
    }

    const slots = computeAvailableSlots(busy, {
      timezone: settings.booking_timezone || "Europe/Budapest",
      windows,
      slotMinutes: settings.booking_slot_minutes ?? 20,
      bufferMinutes: settings.booking_buffer_minutes ?? 10,
      minNoticeMinutes: settings.booking_min_notice_minutes ?? 120,
      windowDays: WINDOW_DAYS,
    });

    return new Response(JSON.stringify({ slots }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[get-availability] error", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
