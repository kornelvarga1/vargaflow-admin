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
    const myName = settings.my_name || "Kornel";
    const myPhone = settings.my_phone || "";

    const firstName = contact.full_name?.split(" ")[0] ?? "there";
    const phone = contact.phone;

    // Remove onboarding form tag
    const currentTags = (contact.tags ?? "")
      .split(",")
      .map((t: string) => t.trim())
      .filter((t: string) => t !== "Needs to Fill Out Onboarding Form")
      .join(", ");

    await supabase
      .from("contacts")
      .update({ tags: currentTags, stage: "Form Submitted" })
      .eq("id", contact.id);

    // Internal notification
    if (myPhone) {
      await supabase.from("message_queue").insert({
        contact_id: contact.id,
        message_type: "sms",
        message_content: `${contact.full_name} just submitted their onboarding form. Email: ${contact.email}. Phone: ${phone}`,
        scheduled_at: new Date(Date.now() + 30 * 1000).toISOString(),
        status: "pending",
        metadata: { to: myPhone },
      });
    }

    // SMS to client — GMB access request
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      message_type: "sms",
      message_content: `${firstName}, thank you for submitting your onboarding form! Next step — please provide us manager access to your Google My Business page. Here's a 2-minute video tutorial on how to do this: [GMB tutorial link] — ${myName}`,
      scheduled_at: new Date(Date.now() + 60 * 1000).toISOString(),
      status: "pending",
      metadata: { to: phone },
    });

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      flow: "flow-ob-form-submitted",
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