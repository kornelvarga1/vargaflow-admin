import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Receives submissions from the public /sms-optin form on vargaflow.com.
// Inserts a row into the sms_optins table — the TCPA paper trail.
// Service-role client bypasses RLS so anon visitors can record their own consent.
//
// CONSENT_TEXT_VERSION must stay in lockstep with the version rendered on the page
// (src/pages/SmsOptin.tsx). When the consent paragraphs change, bump this string
// in BOTH places so future rows reflect the new wording.
const CONSENT_TEXT_VERSION = "2026-04-27-v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      first_name,
      last_name,
      email,
      phone,
      customer_care_consent,
      marketing_consent,
    } = body ?? {};

    // Required fields — defense in depth on top of the client validation.
    if (
      typeof first_name !== "string" || !first_name.trim() ||
      typeof last_name !== "string" || !last_name.trim() ||
      typeof email !== "string" || !email.trim() ||
      typeof phone !== "string" || !phone.trim()
    ) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // At least one consent must be selected. The current UI requires both,
    // but the backend stays permissive in case the rule loosens later — a
    // row with neither consent is meaningless and treated as a bug/attack.
    if (!customer_care_consent && !marketing_consent) {
      return new Response(
        JSON.stringify({ success: false, error: "At least one consent must be selected" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Normalize phone to E.164 (US-only +1). Accept any input the client
    // sends — already-formatted "+15551234567", raw "5551234567", or
    // pretty "(555) 123-4567" — and produce a single canonical form.
    const digits = phone.replace(/\D/g, "");
    const tenDigits =
      digits.length === 10 ? digits :
      digits.length === 11 && digits.startsWith("1") ? digits.slice(1) :
      null;
    if (!tenDigits) {
      return new Response(
        JSON.stringify({ success: false, error: "Phone must be a 10-digit US number" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const phoneE164 = `+1${tenDigits}`;

    // Capture IP + user-agent server-side. x-forwarded-for can contain a
    // chain of proxies; the originating client is the first entry.
    const ipAddress =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      null;
    const userAgent = req.headers.get("user-agent") || null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabase
      .from("sms_optins")
      .insert({
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        email: email.trim(),
        phone: phoneE164,
        customer_care_consent: !!customer_care_consent,
        marketing_consent: !!marketing_consent,
        ip_address: ipAddress,
        user_agent: userAgent,
        consent_text_version: CONSENT_TEXT_VERSION,
      })
      .select("id")
      .single();

    if (error) throw new Error(`DB error: ${error.message}`);

    return new Response(
      JSON.stringify({ success: true, id: data.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
