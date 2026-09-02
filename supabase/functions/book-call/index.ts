import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID, findOrCreateContact, getGoogleAccessToken, getSettings, handleCallBooked, normalizePhone } from "../_shared/utils.ts";
import { getBookingCalendarConnection, isSlotFree } from "../_shared/calendarAvailability.ts";

// Public endpoint the booking widget submits to once a lead picks a slot.
// Creates the Google Calendar event, records the booking, and runs the
// shared confirmation/reminder-cascade logic via handleCallBooked.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MANAGE_BASE_URL = "https://vargaflow.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const rawBody = await req.json();
    // Retell's custom-tool calls wrap arguments as { args: {...} } rather than
    // sending them flat — same quirk voice-book-appointment already guards
    // against. The website's own BookingWidget posts flat, so body.args is
    // undefined there and this falls through to rawBody unchanged.
    const body = (rawBody?.args as Record<string, unknown>) ?? rawBody;
    const full_name = (body.full_name ?? "").toString().trim();
    const email = (body.email ?? "").toString().trim();
    const phone = (body.phone ?? "").toString().trim();
    const start_iso = (body.start_iso ?? "").toString();
    const end_iso = (body.end_iso ?? "").toString();
    const timezone = (body.timezone ?? "America/New_York").toString();

    if (!full_name || !email || !phone || !start_iso || !end_iso) {
      return new Response(JSON.stringify({ error: "missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Catches garbage input up front (an unresolved template token, "N/A",
    // etc.) rather than silently proceeding with no real phone number — that
    // used to let handleCallBooked's own no-phone branch swallow the SMS/email
    // confirmation while book-call still reported success, so the caller got
    // told "you'll get a text" when nothing was ever sent.
    if (!normalizePhone(phone)) {
      return new Response(JSON.stringify({ error: "invalid phone number" }), {
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

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const connection = await getBookingCalendarConnection(supabase);
    if (!connection) {
      return new Response(JSON.stringify({ error: "booking calendar not connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const accessToken = await getGoogleAccessToken(connection.refreshToken);

    // Recheck immediately before writing — narrows the double-book race.
    const free = await isSlotFree(accessToken, connection.calendarId, start_iso, end_iso);
    if (!free) {
      return new Response(JSON.stringify({ error: "slot_taken" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const settings = await getSettings(supabase, ADMIN_BUSINESS_ID);
    const meetingLink = settings.zoom_personal_link || "[Zoom link will be sent before call]";

    const { contact } = await findOrCreateContact(supabase, {
      phone,
      email,
      contactBusinessId: null,
      onCreate: { full_name, pipeline: "Sales", stage: "New Lead", timezone },
    });

    const eventRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendarId)}/events`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: `Call with ${full_name}`,
          description: `Phone: ${phone}\nEmail: ${email}`,
          location: meetingLink,
          start: { dateTime: start_iso },
          end: { dateTime: end_iso },
        }),
      }
    );
    const eventData = await eventRes.json();
    if (!eventRes.ok) {
      console.error("[book-call] calendar insert error", eventData);
      return new Response(JSON.stringify({ error: "could not create calendar event" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        contact_id: contact.id,
        start_time: start_iso,
        end_time: end_iso,
        google_event_id: eventData.id,
        meeting_link: meetingLink,
      })
      .select()
      .single();
    if (bookingError) {
      // Unique-index collision on start_time — same race the isSlotFree
      // check narrows but can't fully close.
      console.error("[book-call] bookings insert error", bookingError);
      return new Response(JSON.stringify({ error: "slot_taken" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const manageUrl = `${MANAGE_BASE_URL}/manage-call/${booking.reschedule_token}`;

    const result = await handleCallBooked(supabase, {
      eventId: booking.id,
      contactName: full_name,
      contactEmail: email,
      contactPhone: phone,
      eventTime: start_iso,
      meetingLink,
      inviteeTz: timezone,
      routingBid: ADMIN_BUSINESS_ID,
      manageUrl,
    });

    return new Response(
      JSON.stringify({ success: true, booking_id: booking.id, manage_url: manageUrl, branch: result.branch }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[book-call] error", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
