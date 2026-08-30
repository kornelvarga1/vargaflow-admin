import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleAccessToken, validateWebhookToken } from "../_shared/utils.ts";

// Retell "book_appointment" tool target — creates the actual Google Calendar
// event once the caller has picked one of the slots from voice-check-availability.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const args = (body.args as Record<string, unknown>) ?? body;
  const startIso = args.start_iso as string;
  const endIso = args.end_iso as string;
  const customerName = (args.customer_name as string) ?? "Unknown caller";
  const customerPhone = (args.customer_phone as string) ?? "unknown";
  const customerAddress = args.customer_address as string | undefined;
  const summary = (args.summary as string) ?? "";

  if (!startIso || !endIso) {
    return new Response(JSON.stringify({ error: "missing start_iso or end_iso" }), {
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

  const eventRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: `${customerName} — ${summary}`.slice(0, 200),
        description: `Phone: ${customerPhone}\n${customerAddress ? `Address: ${customerAddress}\n` : ""}\n${summary}`,
        location: customerAddress,
        start: { dateTime: startIso },
        end: { dateTime: endIso },
      }),
    },
  );

  const eventData = await eventRes.json();
  if (!eventRes.ok) {
    console.error("[voice-book-appointment] calendar insert error", eventData);
    return new Response(JSON.stringify({ error: "could not create calendar event" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true, event_id: eventData.id }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
