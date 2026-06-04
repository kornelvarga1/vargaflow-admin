import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-auth",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { contact_id, to_phone, business_id } = await req.json();
    if (!contact_id || !to_phone) return json({ error: "contact_id and to_phone required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Look up business settings for Twilio number + Kornél's phone
    const { data: settings } = await supabase
      .from("settings")
      .select("my_phone, twilio_phone_number")
      .eq("business_id", business_id)
      .single();

    if (!settings?.my_phone || !settings?.twilio_phone_number) {
      return json({ error: "settings not found" }, 404);
    }

    const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const auth = Deno.env.get("TWILIO_AUTH_TOKEN")!;

    // TwiML: when Kornél picks up, dial the contact from the Twilio number
    const twiml = `<Response><Dial callerId="${settings.twilio_phone_number}">${to_phone}</Dial></Response>`;

    const body = new URLSearchParams({
      To: settings.my_phone,
      From: settings.twilio_phone_number,
      Twiml: twiml,
    });

    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${sid}:${auth}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.error("[initiate-call] Twilio error:", err);
      return json({ error: "Twilio call failed" }, 500);
    }

    // Log outbound call in the inbox thread
    await supabase.from("message_queue").insert({
      contact_id,
      business_id,
      message_type: "call",
      message_content: "📞 Outgoing call",
      direction: "outbound",
      status: "sent",
      scheduled_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
    });

    return json({ ok: true });
  } catch (err) {
    console.error("[initiate-call] error:", err);
    return json({ error: "unexpected error" }, 500);
  }
});
