import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID, handleCallBooked, validateWebhookToken } from "../_shared/utils.ts";

// Legacy Calendly webhook adapter. Parses a Calendly payload and hands off
// to the shared handleCallBooked helper — the actual confirmation/reminder
// logic now lives there, shared with the self-built booking flow
// (book-call, manage-booking). Kept alive only through the cutover window;
// delete once Calendly is cancelled.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!validateWebhookToken(req, "CALENDLY_WEBHOOK_TOKEN")) {
    console.warn("[flow-call-booked] rejected: invalid or missing ?k= token");
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const event = body.payload ?? body;

    const routingBid = body.business_id ?? event.business_id ?? Deno.env.get("VARGA_FLOW_ADMIN_BID") ?? ADMIN_BUSINESS_ID;
    const eventId = event.uri ?? event.uuid ?? crypto.randomUUID();
    const invitee = event.invitee ?? {};
    const eventTime = event.scheduled_event?.start_time ?? event.start_time;

    const contactName = invitee.name ?? event.name ?? event.first_name ?? "there";
    const contactEmail = invitee.email ?? event.email ?? "";
    const meetingLink = event.scheduled_event?.location?.join_url ?? "";
    // Calendly auto-detects the invitee's TZ from their browser. Fallback to
    // ET so the lead's reminder still reads sanely if Calendly omits it.
    const inviteeTz = invitee.timezone ?? event.timezone ?? "America/New_York";

    let contactPhone = invitee.text_reminder_number ?? "";
    if (!contactPhone && Array.isArray(event.questions_and_answers)) {
      const phoneEntry = event.questions_and_answers.find((qa: { question: string; answer: string }) =>
        /phone|mobile|cell|number/i.test(qa.question)
      );
      if (phoneEntry?.answer) contactPhone = phoneEntry.answer;
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const result = await handleCallBooked(supabase, {
      eventId,
      contactName,
      contactEmail,
      contactPhone,
      eventTime,
      meetingLink,
      inviteeTz,
      routingBid,
    });

    if (result.duplicate) {
      return new Response(JSON.stringify({ skipped: "duplicate" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (result.noPhone) {
      return new Response(
        JSON.stringify({ success: false, reason: "no phone number available for contact" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, contact_id: result.contact?.id, branch: result.branch }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[ERROR]", err.message, err.stack);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
