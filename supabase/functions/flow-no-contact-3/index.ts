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
    const { contact_id } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: contact, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contact_id)
      .single();

    if (error || !contact) throw new Error("Contact not found");

    const settings = await getSettings(supabase);
    const steps = await getSequenceSteps(supabase, "Flow #4 — No Contact 3x");
    await queueSteps(supabase, contact.id, steps, contact, settings);

    await supabase
      .from("contacts")
      .update({ stage: "No Contact 3x Text" })
      .eq("id", contact.id);

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      flow: "flow-no-contact-3",
      status: "queued",
      ran_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({ success: true }),
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