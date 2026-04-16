import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/inbound-call`;
const FORWARD_TIMEOUT_SECONDS = 20;

const twiml = (xml: string) =>
  new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });

const emptyTwiml = () => twiml("<Response></Response>");

serve(async (req) => {
  if (req.method === "OPTIONS") return emptyTwiml();

  try {
    const text = await req.text();
    const params = new URLSearchParams(text);

    const from = params.get("From") ?? "";
    const to = params.get("To") ?? "";
    const dialCallStatus = params.get("DialCallStatus"); // only present on fallback

    console.log("[inbound-call] From:", from, "To:", to, "DialCallStatus:", dialCallStatus);

    if (!from || !to) return emptyTwiml();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Look up business settings by the Twilio number that received the call
    const { data: settings } = await supabase
      .from("settings")
      .select("business_id, my_phone, my_name, company_name")
      .eq("twilio_phone_number", to)
      .single();

    if (!settings?.business_id || !settings?.my_phone) {
      console.log("[inbound-call] no business found for number:", to);
      return emptyTwiml();
    }

    // --- FALLBACK: dial completed without contractor answering ---
    // Textback is handled by missed-call-text-back via Twilio's status callback.
    // This function only needs to return empty TwiML so Twilio ends the call.
    if (dialCallStatus !== null && dialCallStatus !== undefined) {
      if (dialCallStatus === "completed") {
        console.log("[inbound-call] call answered, no action needed");
      } else {
        console.log("[inbound-call] missed call (status:", dialCallStatus, ") — textback handled by missed-call-text-back");
      }
      return emptyTwiml();
    }

    // --- INITIAL CALL: forward to contractor's phone ---
    // Use `to` (the business's Twilio number) as callerId so all comms
    // come from the same number and land in one SMS thread.
    console.log("[inbound-call] forwarding to:", settings.my_phone);

    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${FORWARD_TIMEOUT_SECONDS}" action="${FUNCTION_URL}" callerId="${to}">
    <Number>${settings.my_phone}</Number>
  </Dial>
</Response>`);

  } catch (err) {
    console.error("[inbound-call] unexpected error:", err);
    return emptyTwiml();
  }
});
