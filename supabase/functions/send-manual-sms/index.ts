import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authErrorResponse, requireAdminOrBusinessMember } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-auth",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { contact_id, business_id, message, to_phone } = await req.json();

    if (!business_id) throw new Error("business_id required");
    await requireAdminOrBusinessMember(req, business_id);

    if (!contact_id) throw new Error("contact_id required");
    if (!message) throw new Error("message required");
    if (!to_phone) throw new Error("to_phone required");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load business settings for the Twilio from-number
    const { data: settings, error: settingsError } = await supabase
      .from("settings")
      .select("twilio_phone_number")
      .eq("business_id", business_id)
      .single();

    if (settingsError || !settings?.twilio_phone_number) {
      throw new Error(`No twilio_phone_number in settings for business: ${business_id}`);
    }

    const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const TWILIO_AUTH = Deno.env.get("TWILIO_AUTH_TOKEN")!;

    // Send via Twilio
    console.log("[send-manual-sms] sending to:", to_phone, "from:", settings.twilio_phone_number);
    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${TWILIO_SID}:${TWILIO_AUTH}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: to_phone,
          From: settings.twilio_phone_number,
          Body: message,
        }),
      },
    );

    const twilioData = await twilioRes.json();
    if (!twilioRes.ok) {
      throw new Error(`Twilio error ${twilioRes.status}: ${twilioData.message}`);
    }
    console.log("[send-manual-sms] Twilio SID:", twilioData.sid);

    const now = new Date().toISOString();

    // Log to message_queue as already sent
    const { error: queueError } = await supabase.from("message_queue").insert({
      contact_id,
      business_id,
      message_type: "sms",
      message_content: message,
      scheduled_at: now,
      sent_at: now,
      status: "sent",
      direction: "outbound",
      metadata: { to: to_phone, twilio_sid: twilioData.sid },
    });

    if (queueError) {
      console.error("[send-manual-sms] message_queue insert error:", queueError.message);
    }

    // Log to activity_log
    const { error: activityError } = await supabase.from("activity_log").insert({
      activity_type: "message_sent",
      description: `Manual SMS sent: "${message.slice(0, 80)}${message.length > 80 ? "…" : ""}"`,
      contact_id,
      business_id,
      metadata: { to: to_phone, twilio_sid: twilioData.sid },
    });

    if (activityError) {
      console.error("[send-manual-sms] activity_log insert error:", activityError.message);
    }

    // Kornél typing a manual reply is the human-takeover signal for the AI
    // text agent — pause it on this contact until he re-enables it.
    const { error: pauseError } = await supabase
      .from("contacts")
      .update({ ai_texting_paused_at: now })
      .eq("id", contact_id);
    if (pauseError) {
      console.error("[send-manual-sms] ai_texting_paused_at update error:", pauseError.message);
    }

    return new Response(JSON.stringify({ sent: true, twilio_sid: twilioData.sid }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    const authResp = authErrorResponse(err, corsHeaders);
    if (authResp) return authResp;
    console.error("[send-manual-sms] error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
