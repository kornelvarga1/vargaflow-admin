import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID, cancelPendingMessages, getGoogleAccessToken, getSettings, handleCallBooked, normalizePhone } from "../_shared/utils.ts";
import { getBookingCalendarConnection, isSlotFree } from "../_shared/calendarAvailability.ts";

// Reschedule/cancel endpoint with two lookup modes:
//   - token: the web manage-link's trust boundary (unguessable uuid), same
//     as Calendly's own manage links, no additional auth.
//   - phone: for the voice agent's reschedule_appointment/cancel_appointment
//     tools, which don't have a token for a booking made in an earlier call
//     — trusts the caller's own stated/caller-ID phone number instead, same
//     trust level book-call already uses to create the booking in the first
//     place. Finds their soonest upcoming confirmed booking.
// token takes priority if both are somehow present.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MANAGE_BASE_URL = "https://vargaflow.com";
const BOOKING_SELECT = "id, contact_id, start_time, end_time, status, google_event_id, meeting_link, reschedule_token, contacts(full_name, email, phone, timezone)";

async function loadBookingByToken(supabase: any, token: string) {
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("reschedule_token", token)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function loadBookingByPhone(supabase: any, phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("phone", normalized)
    .is("business_id", null)
    .maybeSingle();
  if (!contact) return null;
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("contact_id", contact.id)
    .eq("status", "confirmed")
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function loadBooking(supabase: any, { token, phone }: { token?: string; phone?: string }) {
  if (token) return loadBookingByToken(supabase, token);
  if (phone) return loadBookingByPhone(supabase, phone);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (req.method === "GET") {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") ?? "";
    const phone = url.searchParams.get("phone") ?? "";
    const booking = await loadBooking(supabase, { token, phone });
    if (!booking) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        start_time: booking.start_time,
        end_time: booking.end_time,
        status: booking.status,
        contact_first_name: (booking as any).contacts?.full_name?.split(" ")[0] ?? "",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const rawBody = await req.json();
    // Retell's custom-tool calls wrap arguments as { args: {...} } rather
    // than flat — same fix as book-call.
    const body = (rawBody?.args as Record<string, unknown>) ?? rawBody;
    const token = (body.token ?? "").toString();
    const phone = (body.phone ?? "").toString();
    const action = (body.action ?? "").toString();

    const booking = await loadBooking(supabase, { token, phone });
    if (!booking) {
      return new Response(JSON.stringify({ error: token ? "not_found" : "no_upcoming_booking_for_phone" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const contact = (booking as any).contacts;

    const connection = await getBookingCalendarConnection(supabase);
    if (!connection) {
      return new Response(JSON.stringify({ error: "booking calendar not connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const accessToken = await getGoogleAccessToken(connection.refreshToken);

    if (action === "cancel") {
      if (booking.status === "cancelled") {
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (booking.google_event_id) {
        const delRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendarId)}/events/${booking.google_event_id}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!delRes.ok && delRes.status !== 404 && delRes.status !== 410) {
          console.error("[manage-booking] calendar delete failed", await delRes.text());
        }
      }

      await supabase.from("bookings").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", booking.id);

      // flow-cancelled's own hasPendingMessages guard exists to stop it
      // double-firing on a repeat call — but right after a booking, the
      // contact ALWAYS has pending reminder messages queued (from
      // handleCallBooked), which would trip that guard and make it skip
      // enrolling the "Cancelled/Rescheduled" sequence entirely. Clear the
      // booking reminders first so flow-cancelled sees a clean slate and
      // actually runs.
      await cancelPendingMessages(supabase, booking.contact_id);

      // Reuse flow-cancelled as-is from there (enroll in
      // "Flow #7 — Cancelled/Rescheduled" + stage update + automation_logs).
      // business_id must be passed explicitly — flow-cancelled's own
      // `bid = business_id ?? contact.business_id` fallback would otherwise
      // resolve to null for Kornél's leads and getSettings(null) would throw.
      const cancelRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/flow-cancelled`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ contact_id: booking.contact_id, business_id: ADMIN_BUSINESS_ID }),
      });
      if (!cancelRes.ok) {
        console.error("[manage-booking] flow-cancelled call failed", await cancelRes.text());
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "reschedule") {
      const start_iso = (body.start_iso ?? "").toString();
      const end_iso = (body.end_iso ?? "").toString();
      const timezone = (body.timezone ?? contact?.timezone ?? "America/New_York").toString();

      if (!start_iso || !end_iso) {
        return new Response(JSON.stringify({ error: "missing start_iso or end_iso" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (new Date(start_iso).getTime() <= Date.now()) {
        return new Response(JSON.stringify({ error: "slot_in_past" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const free = await isSlotFree(accessToken, connection.calendarId, start_iso, end_iso);
      if (!free) {
        return new Response(JSON.stringify({ error: "slot_taken" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (booking.google_event_id) {
        const patchRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendarId)}/events/${booking.google_event_id}`,
          {
            method: "PATCH",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ start: { dateTime: start_iso }, end: { dateTime: end_iso } }),
          }
        );
        if (!patchRes.ok) {
          console.error("[manage-booking] calendar patch failed", await patchRes.text());
          return new Response(JSON.stringify({ error: "could not update calendar event" }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      await supabase
        .from("bookings")
        .update({ start_time: start_iso, end_time: end_iso, updated_at: new Date().toISOString() })
        .eq("id", booking.id);

      const manageUrl = `${MANAGE_BASE_URL}/manage-call/${booking.reschedule_token}`;

      const result = await handleCallBooked(supabase, {
        eventId: `${booking.id}:resched:${Date.now()}`,
        contactName: contact?.full_name ?? "there",
        contactEmail: contact?.email ?? "",
        contactPhone: contact?.phone ?? "",
        eventTime: start_iso,
        meetingLink: booking.meeting_link ?? "",
        inviteeTz: timezone,
        routingBid: ADMIN_BUSINESS_ID,
        manageUrl,
      });

      return new Response(JSON.stringify({ success: true, branch: result.branch }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[manage-booking] error", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
