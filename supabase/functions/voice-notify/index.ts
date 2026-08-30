import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateWebhookToken } from "../_shared/utils.ts";

// Webhook target for the Retell "notify_contractor" custom function tool.
// Called by the voice AI receptionist when it confirms a booking or needs to
// hand a caller off to the contractor (unknown question, safety hazard,
// complaint, anything outside its script). Auth matches the Calendly webhook
// pattern: a ?k=<secret> query param checked against VOICE_NOTIFY_WEBHOOK_SECRET,
// since Retell's custom-function config can set static headers/query params
// but there's no OAuth-style flow to configure on their end.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  console.log(
    "[voice-notify] incoming request",
    req.method,
    req.url,
    JSON.stringify(Object.fromEntries(req.headers.entries()))
  );

  // Accept the secret via header OR query param — Retell's custom-function
  // tool config supports both, and query-param-only auth on a POST endpoint
  // has been unreliable in practice (some requests never reach this code at
  // all, rejected by something upstream before the handler runs).
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

  // Retell wraps tool arguments under `args` unless payload_args_only is set
  // on the tool config; accept either shape defensively.
  const args = (body.args as Record<string, unknown>) ?? body;
  const type = args.type as string;
  const customerName = (args.customer_name as string) ?? "Unknown caller";
  const customerPhone = (args.customer_phone as string) ?? "unknown";
  const customerAddress = args.customer_address as string | undefined;
  const summary = (args.summary as string) ?? "";
  const urgent = Boolean(args.urgent);

  if (type !== "booking" && type !== "handoff") {
    return new Response(JSON.stringify({ error: "type must be 'booking' or 'handoff'" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: voiceAgent, error: vaError } = await supabase
    .from("voice_agents")
    .select("notification_email")
    .eq("business_id", businessId)
    .maybeSingle();

  if (vaError || !voiceAgent?.notification_email) {
    console.error("[voice-notify] no notification_email for business", businessId, vaError);
    return new Response(JSON.stringify({ error: "no notification email configured" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: business } = await supabase
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .maybeSingle();
  const businessName = business?.name ?? "Your business";

  const subject = type === "booking"
    ? `${urgent ? "🚨 Urgent booking" : "New booking"} — ${customerName}`
    : `📞 Caller needs a callback — ${customerName}`;

  const html = `
    <p><strong>${type === "booking" ? "New appointment booked by your AI assistant" : "A caller needs your follow-up"}</strong></p>
    <p><strong>Name:</strong> ${customerName}</p>
    <p><strong>Phone:</strong> ${customerPhone}</p>
    ${customerAddress ? `<p><strong>Address:</strong> ${customerAddress}</p>` : ""}
    <p><strong>Details:</strong> ${summary}</p>
    ${urgent ? `<p style="color:#c00"><strong>Marked urgent — handle this one first.</strong></p>` : ""}
  `.trim();

  const resendKey = Deno.env.get("RESEND_API_KEY")!;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${businessName} AI Assistant <voice@vargaflow.com>`,
      to: voiceAgent.notification_email,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("[voice-notify] Resend error:", errText);
    return new Response(JSON.stringify({ error: "email send failed" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
