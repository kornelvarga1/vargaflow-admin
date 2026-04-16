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

    const twilioSid  = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const twilioFrom = Deno.env.get("TWILIO_PHONE_NUMBER")!;

    // --- FALLBACK: dial completed without contractor answering ---
    if (dialCallStatus !== null && dialCallStatus !== undefined) {
      if (dialCallStatus === "completed") {
        // Contractor picked up — no text needed
        console.log("[inbound-call] call answered, no text back needed");
        return emptyTwiml();
      }

      // no-answer / busy / failed / canceled → send missed call text back
      console.log("[inbound-call] missed call, sending text back to:", from);

      const name        = settings.my_name ?? "us";
      const company     = settings.company_name ? ` from ${settings.company_name}` : "";
      const missedText  = `Hey, this is ${name}${company}. Sorry I missed your call! I'll get back to you shortly — feel free to reply here if you have any questions.`;

      try {
        await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: "Basic " + btoa(`${twilioSid}:${twilioAuth}`),
            },
            body: new URLSearchParams({ To: from, From: twilioFrom, Body: missedText }),
          }
        );
        console.log("[inbound-call] missed call text sent");
      } catch (err) {
        console.error("[inbound-call] failed to send missed call text:", err);
      }

      return emptyTwiml();
    }

    // --- INITIAL CALL: forward to contractor's phone ---
    console.log("[inbound-call] forwarding to:", settings.my_phone);

    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${FORWARD_TIMEOUT_SECONDS}" action="${FUNCTION_URL}" callerId="${twilioFrom}">
    <Number>${settings.my_phone}</Number>
  </Dial>
</Response>`);

  } catch (err) {
    console.error("[inbound-call] unexpected error:", err);
    return emptyTwiml();
  }
});
