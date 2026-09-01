import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID, cancelPendingMessages, getGoogleAccessToken, getSettings, handleCallBooked } from "../_shared/utils.ts";
import { getBookingCalendarConnection, isSlotFree } from "../_shared/calendarAvailability.ts";

// Public, token-gated reschedule/cancel endpoint. The reschedule_token
// (uuid, unguessable) is the trust boundary — same model as Calendly's own
// manage links, no additional auth.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MANAGE_BASE_URL = "https://vargaflow.com";

async function loadBooking(supabase: any, token: string) {
  const { data, error } = await supabase
    .from("bookings")
    .select("id, contact_id, start_time, end_time, status, google_event_id, meeting_link, reschedule_token, contacts(full_name, email, phone, timezone)")
    .eq("reschedule_token", token)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (req.method === "GET") {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    const booking = await loadBooking(supabase, token);
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
    const body = await req.json();
    const token = (body.token ?? "").toString();
    const action = (body.action ?? "").toString();

    const booking = await loadBooking(supabase, token);
    if (!booking) {
      return new Response(JSON.stringify({ error: "not_found" }), {
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
