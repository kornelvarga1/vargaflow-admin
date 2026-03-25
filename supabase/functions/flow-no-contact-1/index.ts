import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSettings, getSequenceSteps, queueSteps, cancelPendingMessages, hasPendingMessages } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { contact_id, business_id } = await req.json();

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

    const bid = business_id ?? contact.business_id;

    // Skip if this contact already has pending messages (idempotency)
    if (await hasPendingMessages(supabase, contact.id)) {
      return new Response(
        JSON.stringify({ success: true, skipped: "pending messages already exist" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cancel any leftover pending messages from prior sequences
    await cancelPendingMessages(supabase, contact.id);

    const settings = await getSettings(supabase, bid);
    const steps = await getSequenceSteps(supabase, "Flow #2 — No Contact 1x");
    await queueSteps(supabase, contact.id, steps, contact, settings, bid);

    await supabase
      .from("contacts")
      .update({ stage: "No Contact x1 Text" })
      .eq("id", contact.id);

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: bid,
      flow: "flow-no-contact-1",
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