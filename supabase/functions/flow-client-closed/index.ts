import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSettings } from "../_shared/utils.ts";

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
    const settings = await getSettings(supabase, bid);

    const currentTags: string[] = Array.isArray(contact.tags) ? contact.tags : [];
    const updatedTags = currentTags.includes("New Client") ? currentTags : [...currentTags, "New Client"];

    await supabase
      .from("contacts")
      .update({
        pipeline: "Onboarding",
        stage: "New Client Waiting for Onboarding Form",
        tags: updatedTags,
      })
      .eq("id", contact.id);

    if (settings.my_phone) {
      await supabase.from("message_queue").insert({
        contact_id: contact.id,
        business_id: bid,
        message_type: "sms",
        message_content: `🎉 ${contact.full_name} just closed! Moved to onboarding pipeline. Number: ${contact.phone}`,
        scheduled_at: new Date().toISOString(),
        status: "pending",
        metadata: { to: settings.my_phone },
      });
    }

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: bid,
      flow: "flow-client-closed",
      status: "completed",
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