import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSettings, getSequenceSteps, queueSteps } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { name, phone, email, source, business_id } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Insert contact
    const { data: contact, error: dbError } = await supabase
      .from("contacts")
      .insert({
        full_name: name,
        phone,
        email,
        business_id,
        lead_source: source ?? "lead_form",
        pipeline: "Sales",
        stage: "Lead In",
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbError) throw new Error(`DB error: ${dbError.message}`);

    // 2. Fetch settings + steps
    const settings = await getSettings(supabase, business_id);
    const steps = await getSequenceSteps(supabase, "Flow #1 — Lead Form Submitted");

    // 3. Queue all steps
    await queueSteps(supabase, contact.id, steps, contact, settings, business_id);

    // 4. Log
    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id,
      flow: "flow-lead-form-submitted",
      status: "queued",
      ran_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({ success: true, contact_id: contact.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});