import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSettings, sendEmailWithUnsubscribe } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const MAX_REMINDER_ITERATIONS = 10;

    const { contact_id, business_id, iteration = 1 } = await req.json();

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

    // Check if they still need to fill out the form
    const tagsArr: string[] = Array.isArray(contact.tags) ? contact.tags : [];
    const stillNeeds = tagsArr.includes("Needs to Fill Out Onboarding Form");
    if (!stillNeeds) {
      return new Response(
        JSON.stringify({ success: true, skipped: "form already submitted" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (iteration > MAX_REMINDER_ITERATIONS) {
      console.log(`Max reminder iterations (${MAX_REMINDER_ITERATIONS}) reached for contact ${contact_id}`);
      return new Response(
        JSON.stringify({ success: true, skipped: "max iterations reached" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const settings = await getSettings(supabase, bid);
    const myName = settings.my_name || "Kornel";
    const myEmail = settings.my_email || "hello@vargaflow.com";
    const companyName = settings.company_name || "Local Scaling";
    const onboardingFormLink = settings.onboarding_form_link || "[onboarding form link]";
    const gmbTutorialLink = settings.gmb_tutorial_link || "https://www.youtube.com/watch?v=vlwDSdFTvmI";
    const resendKey = Deno.env.get("RESEND_API_KEY")!;

    const firstName = contact.full_name?.split(" ")[0] ?? "there";
    const phone = contact.phone;
    const email = contact.email;

    // Send reminder email
    const emailRes = await sendEmailWithUnsubscribe({
      resendKey,
      from: `${companyName} <hello@vargaflow.com>`,
      to: email,
      subject: `Quick reminder — your onboarding form`,
      contactId: contact.id,
      replyTo: myEmail,
      html: `
        <p>Hey ${firstName}, glad to have you on board!</p>
        <p>Before I can get started I just need a couple things from you:</p>
        <p><strong>Step 1:</strong> Fill in the setup form (project photos go in there too): <a href="${onboardingFormLink}">${onboardingFormLink}</a></p>
        <p><strong>Step 2:</strong> Give me manager access to your Google Business Profile — quick tutorial: <a href="${gmbTutorialLink}">${gmbTutorialLink}</a></p>
        <p>Please take care of this when you get a sec. Thanks!</p>
        <p>— ${myName}, ${companyName}</p>
      `,
    });
    if (!emailRes.ok) {
      const emailData = await emailRes.json();
      throw new Error(`Resend error: ${emailData.message ?? emailRes.statusText}`);
    }

    // Send reminder SMS
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      business_id: bid,
      message_type: "sms",
      message_content: `Hey ${firstName}, friendly reminder to fill out your onboarding info when you have a sec. Here's the form: ${onboardingFormLink} — ${myName}. PS: I just re-emailed the onboarding info to your inbox — check junk/spam/promotions just in case.`,
      scheduled_at: new Date(Date.now() + 60 * 1000).toISOString(),
      status: "pending",
      metadata: { to: phone },
    });

    // Schedule next reminder in 48 hours if still not done
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      business_id: bid,
      message_type: "function_call",
      message_content: `FUNCTION_CALL:flow-ob-form-reminder`,
      scheduled_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      status: "pending",
      metadata: { function_name: "flow-ob-form-reminder", payload: { contact_id: contact.id, business_id: bid, iteration: iteration + 1 } },
    });

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: bid,
      flow: "flow-ob-form-reminder",
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