import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = "https://app.vargaflow.com"; // update to actual CRM URL

// Always return TwiML so Twilio doesn't retry on non-200 or missing body
const twiml = () =>
  new Response("<Response></Response>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return twiml();

  try {
    // Twilio sends application/x-www-form-urlencoded
    const text = await req.text();
    const params = new URLSearchParams(text);

    const from       = params.get("From") ?? "";
    const to         = params.get("To") ?? "";
    const body       = params.get("Body") ?? "";
    const messageSid = params.get("MessageSid") ?? "";

    console.log("[inbound-sms] From:", from, "To:", to, "Sid:", messageSid);

    if (!from || !to) {
      console.log("[inbound-sms] missing From/To — returning empty TwiML");
      return twiml();
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Look up business by the Twilio number that received the SMS
    const { data: settings, error: settingsErr } = await supabase
      .from("settings")
      .select("business_id, my_phone")
      .eq("twilio_phone_number", to)
      .single();

    if (settingsErr || !settings?.business_id) {
      console.log("[inbound-sms] no business found for number:", to, settingsErr?.message);
      return twiml();
    }

    const businessId = settings.business_id;

    // 2. Find or create contact by phone + business_id
    let contactId: string;

    const { data: existing } = await supabase
      .from("contacts")
      .select("id, full_name")
      .eq("phone", from)
      .eq("business_id", businessId)
      .single();

    if (existing) {
      contactId = existing.id;
      console.log("[inbound-sms] existing contact:", contactId);
    } else {
      const { data: created, error: createErr } = await supabase
        .from("contacts")
        .insert({
          phone: from,
          business_id: businessId,
          full_name: from,      // placeholder — can be updated later
          pipeline: "Sales",
          stage: "Lead",
        })
        .select("id")
        .single();

      if (createErr || !created) {
        console.error("[inbound-sms] failed to create contact:", createErr?.message);
        return twiml();
      }

      contactId = created.id;
      console.log("[inbound-sms] new contact created:", contactId);
    }

    const now = new Date().toISOString();

    // 3. Insert inbound message into message_queue
    const { error: mqErr } = await supabase.from("message_queue").insert({
      contact_id:      contactId,
      business_id:     businessId,
      direction:       "inbound",
      status:          "received",
      message_type:    "sms",
      message_content: body,
      to_phone:        from,
      scheduled_at:    now,
      metadata:        { from, to, message_sid: messageSid },
    });

    if (mqErr) {
      console.error("[inbound-sms] message_queue insert failed:", mqErr.message);
    } else {
      console.log("[inbound-sms] message queued for contact:", contactId);
    }

    // 4. Log to activity_log
    try {
      await supabase.from("activity_log").insert({
        contact_id:    contactId,
        business_id:   businessId,
        activity_type: "inbound_sms",
        description:   `Inbound SMS: "${body.slice(0, 100)}${body.length > 100 ? "…" : ""}"`,
      });
    } catch (logErr) {
      console.error("[inbound-sms] activity_log insert failed:", logErr);
    }

    // 5. Notify contractor via SMS
    try {
      if (settings.my_phone) {
        const contactName = existing?.full_name ?? from;
        const preview = body.slice(0, 100) + (body.length > 100 ? "…" : "");
        await supabase.from("message_queue").insert({
          contact_id:      contactId,
          business_id:     businessId,
          direction:       "outbound",
          status:          "pending",
          message_type:    "internal_sms",
          message_content: `Reply from ${contactName}: "${preview}"\n${APP_URL}/messages`,
          scheduled_at:    now,
          metadata:        { to: settings.my_phone },
        });
      }
    } catch (notifyErr) {
      console.error("[inbound-sms] contractor notification failed:", notifyErr);
    }

    return twiml();

  } catch (err) {
    console.error("[inbound-sms] unexpected error:", err);
    // Always return valid TwiML so Twilio doesn't retry
    return twiml();
  }
});
