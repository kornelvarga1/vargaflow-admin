import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateWebhookToken } from "../_shared/utils.ts";

// Retell "send_confirmation_email" tool target — opt-in only, called when the
// caller explicitly says yes to a confirmation email after booking. This is
// NOT the same as voice-notify: that emails the CONTRACTOR about the booking,
// this emails the CUSTOMER their own confirmation. Being opt-in (the caller
// asked for it) is what keeps this out of A2P/unsolicited-messaging territory
// entirely — it's a one-off transactional email sent on direct request.

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
  const customerEmail = args.customer_email as string;
  const customerName = (args.customer_name as string) ?? "there";
  const confirmationDetails = (args.confirmation_details as string) ?? "";

  if (!customerEmail || !confirmationDetails) {
    return new Response(JSON.stringify({ error: "missing customer_email or confirmation_details" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: business } = await supabase
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .maybeSingle();
  const businessName = business?.name ?? "the business you called";

  // Replies should reach the contractor, not vanish into a no-reply void: a
  // customer answering their own confirmation is both the obvious thing to do
  // and one of the strongest positive signals a mailbox provider has, which
  // this domain needs while its sending reputation is still new.
  const { data: voiceAgent } = await supabase
    .from("voice_agents")
    .select("notification_email, retell_phone_number")
    .eq("business_id", businessId)
    .maybeSingle();

  // The number the customer reached the AI on. Their own call forwards here, so
  // either number works — this one is guaranteed to be correct and current.
  const callbackNumber = voiceAgent?.retell_phone_number ?? null;
  const callbackLine = callbackNumber
    ? `<p>Need to change anything? Call <a href="tel:${callbackNumber}">${callbackNumber}</a> or reply to this email.</p>`
    : `<p>If anything changes on your end, just call the number back or reply to this email.</p>`;

  const html = `
    <p>Hi ${customerName},</p>
    <p>This confirms your appointment with <strong>${businessName}</strong>.</p>
    <p>${confirmationDetails}</p>
    ${callbackLine}
  `.trim();

  const resendKey = Deno.env.get("RESEND_API_KEY")!;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${businessName} <voice@vargaflow.com>`,
      to: customerEmail,
      ...(voiceAgent?.notification_email ? { reply_to: voiceAgent.notification_email } : {}),
      subject: `Appointment Confirmed — ${businessName}`,
      html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("[voice-send-confirmation] Resend error:", errText);
    return new Response(JSON.stringify({ error: "email send failed" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
