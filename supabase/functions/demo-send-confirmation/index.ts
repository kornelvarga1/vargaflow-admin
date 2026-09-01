import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ADMIN_BUSINESS_ID,
  findOrCreateContact,
  getSettings,
  getTwilioFromNumber,
  notifyAdmin,
  sendEmailWithUnsubscribe,
} from "../_shared/utils.ts";

// Sends a real SMS (and optional email) confirmation for the illustrative
// contractor-demo "booking" inside the VargaFlow self-line voice agent —
// deliberately NOT the same path as book-call: no Google Calendar event, no
// real appointment on Kornél's own calendar, since the roofing persona's
// booking is fictional. What IS real: the person testing the demo is a live
// VargaFlow prospect, so their info is worth capturing in the CRM, and a
// real confirmation message makes the demo feel complete (the product's own
// selling point is being provably real, including the follow-through).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
    // Retell wraps custom-tool arguments as { args: {...} } rather than
    // flat — same fix as book-call.
    const body = (rawBody?.args as Record<string, unknown>) ?? rawBody;
    const full_name = (body.full_name ?? "").toString().trim();
    const phone = (body.phone ?? "").toString().trim();
    const email = (body.email ?? "").toString().trim();
    const appointment_label = (body.appointment_label ?? "").toString().trim();

    if (!full_name || !phone || !appointment_label) {
      return new Response(JSON.stringify({ error: "missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { contact } = await findOrCreateContact(supabase, {
      phone,
      email: email || null,
      contactBusinessId: null,
      onCreate: {
        full_name,
        pipeline: "Sales",
        stage: "New Lead",
        tags: ["AI Demo Tested"],
      },
    });

    const settings = await getSettings(supabase, ADMIN_BUSINESS_ID);
    const myName = settings.my_name || "Kornel";
    const companyName = settings.company_name || "VargaFlow";

    const smsBody = `Hey ${full_name.split(" ")[0]}, this is confirming your ${appointment_label} — that's the demo talking, this text is real though. If you want to see this exact thing running on your own business line, reply here or I'll follow up. — ${myName}`;

    const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const twilioFrom = await getTwilioFromNumber(supabase, ADMIN_BUSINESS_ID);
    const smsRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${twilioSid}:${twilioAuth}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: twilioFrom, Body: smsBody }),
    });
    if (!smsRes.ok) {
      const data = await smsRes.json();
      throw new Error(`Twilio error: ${data.message ?? smsRes.statusText}`);
    }

    if (email) {
      const resendKey = Deno.env.get("RESEND_API_KEY")!;
      const emailRes = await sendEmailWithUnsubscribe({
        resendKey,
        from: `${companyName} <hello@vargaflow.com>`,
        to: email,
        subject: `Your ${appointment_label} — demo confirmation`,
        html: `<p>Hey ${full_name.split(" ")[0]},</p>
<p>This confirms your <strong>${appointment_label}</strong> — that's the AI receptionist demo talking, but this email is 100% real, sent the same way a real customer confirmation would be.</p>
<p>Want to see this exact thing answering calls for your own business? Just reply and ${myName} will follow up.</p>
<p>— ${myName}, ${companyName}</p>`,
        contactId: contact.id,
        replyTo: settings.my_email || undefined,
      });
      if (!emailRes.ok) {
        const data = await emailRes.json();
        console.error("[demo-send-confirmation] email send failed:", data);
      }
    }

    await notifyAdmin(
      `${full_name} just tried the roofing demo on your line and got a confirmation sent for "${appointment_label}". Phone: ${phone}.${email ? ` Email: ${email}.` : ""}`
    );

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: null,
      flow: "demo-send-confirmation",
      status: "completed",
      ran_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[demo-send-confirmation] error", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
