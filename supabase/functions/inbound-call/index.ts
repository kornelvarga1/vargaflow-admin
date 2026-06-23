import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateTwilioSignature } from "../_shared/utils.ts";

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

    const paramObj: Record<string, string> = {};
    params.forEach((v, k) => { paramObj[k] = v; });
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const signature = req.headers.get("X-Twilio-Signature");
    const validationUrl = `https://${new URL(req.url).host}/functions/v1/inbound-call`;
    const valid = await validateTwilioSignature(authToken, signature, validationUrl, paramObj);
    if (!valid) {
      console.warn("[inbound-call] invalid Twilio signature — rejecting");
      return new Response("Forbidden", { status: 403 });
    }

    const from = params.get("From") ?? "";
    const to = params.get("To") ?? "";
    const dialCallStatus = params.get("DialCallStatus");

    console.log("[inbound-call] From:", from, "To:", to, "DialCallStatus:", dialCallStatus);

    if (!from || !to) return emptyTwiml();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: settings } = await supabase
      .from("settings")
      .select("business_id, my_phone, my_name, company_name")
      .eq("twilio_phone_number", to)
      .single();

    if (!settings?.business_id || !settings?.my_phone) {
      console.log("[inbound-call] no business found for number:", to);
      return emptyTwiml();
    }

    // --- FALLBACK: after forward attempt completes ---
    if (dialCallStatus !== null && dialCallStatus !== undefined) {
      const answered = dialCallStatus === "completed";
      console.log("[inbound-call] dial status:", dialCallStatus);

      // Log the call event in message_queue so it shows in the inbox thread
      console.log("[inbound-call] callback from:", from, "status:", dialCallStatus, "business:", settings.business_id);

      const { data: contact, error: contactErr } = await supabase
        .from("contacts")
        .select("id")
        .eq("phone", from)
        .eq("business_id", settings.business_id)
        .maybeSingle();

      console.log("[inbound-call] contact lookup:", contact?.id ?? "not found", contactErr?.message ?? "");

      if (contact?.id) {
        await supabase.from("message_queue").insert({
          contact_id: contact.id,
          business_id: settings.business_id,
          message_type: "call",
          message_content: answered ? "Call answered" : "Missed call",
          direction: "inbound",
          status: "received",
          scheduled_at: new Date().toISOString(),
          sent_at: new Date().toISOString(),
        });
      }

      return emptyTwiml();
    }

    // --- INITIAL CALL: forward to real phone, log result via action callback ---
    console.log("[inbound-call] forwarding to:", settings.my_phone, "caller:", from);

    return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${FORWARD_TIMEOUT_SECONDS}" action="${FUNCTION_URL}" callerId="${from}">
    <Number>${settings.my_phone}</Number>
    <Client>${settings.business_id}</Client>
  </Dial>
</Response>`);

  } catch (err) {
    console.error("[inbound-call] unexpected error:", err);
    return emptyTwiml();
  }
});
