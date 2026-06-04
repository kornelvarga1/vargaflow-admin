import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateTwilioSignature } from "../_shared/utils.ts";

const twiml = (xml: string) =>
  new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return twiml("<Response></Response>");

  const text = await req.text();
  const params = new URLSearchParams(text);
  const paramObj: Record<string, string> = {};
  params.forEach((v, k) => { paramObj[k] = v; });

  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const signature = req.headers.get("X-Twilio-Signature");
  const validationUrl = `https://${new URL(req.url).host}/functions/v1/voice-webhook`;
  const valid = await validateTwilioSignature(authToken, signature, validationUrl, paramObj);
  if (!valid) {
    console.warn("[voice-webhook] invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  const to = params.get("To") ?? "";
  const from = params.get("From") ?? "";

  console.log("[voice-webhook] outbound call To:", to, "From:", from);

  if (!to) return twiml("<Response><Hangup/></Response>");

  // Look up Twilio number from settings to use as callerId
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: settings } = await supabase
    .from("settings")
    .select("twilio_phone_number")
    .limit(1)
    .maybeSingle();

  const callerId = settings?.twilio_phone_number ?? from;

  return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}">
    <Number>${to}</Number>
  </Dial>
</Response>`);
});
