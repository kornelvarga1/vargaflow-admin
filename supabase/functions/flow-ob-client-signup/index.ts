import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSettings, getTwilioFromNumber, notifyAdmin, sendEmailWithUnsubscribe } from "../_shared/utils.ts";

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
    const myName = settings.my_name || "Kornel";
    const myEmail = settings.my_email || "hello@vargaflow.com";
    const companyName = settings.company_name || "Local Scaling";
    const onboardingFormLink = settings.onboarding_form_link || "https://vargaflow.com/onboarding-form";
    const gmbTutorialLink = settings.gmb_tutorial_link || "https://www.youtube.com/watch?v=vlwDSdFTvmI";

    const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const twilioFrom = await getTwilioFromNumber(supabase, bid);
    const resendKey = Deno.env.get("RESEND_API_KEY")!;

    const sendSMS = async (to: string, body: string) => {
      if (!to) return;
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: "Basic " + btoa(`${twilioSid}:${twilioAuth}`),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: twilioFrom, Body: body }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(`Twilio error: ${data.message ?? res.statusText}`);
      }
    };

    // Cancel any pending messages from prior sequences
    await supabase
      .from("message_queue")
      .update({ status: "cancelled" })
      .eq("contact_id", contact.id)
      .eq("status", "pending");

    const firstName = contact.full_name?.split(" ")[0] ?? "there";
    const phone = contact.phone;
    const email = contact.email;

    // Send onboarding email immediately
    const emailRes = await sendEmailWithUnsubscribe({
      resendKey,
      from: `${companyName} <hello@vargaflow.com>`,
      to: email,
      subject: "Let's get you onboarded",
      contactId: contact.id,
      replyTo: myEmail,
      html: `
        <p>Hey ${firstName},</p>
        <p>Please go through these two steps so I can get started on your website and marketing systems.</p>
        <p><strong>Step 1:</strong> Fill in the setup form (project photos go in there too): <a href="${onboardingFormLink}">${onboardingFormLink}</a></p>
        <p><strong>Step 2:</strong> Give me manager access to your Google Business Profile — quick tutorial: <a href="${gmbTutorialLink}">${gmbTutorialLink}</a></p>
        <p>Thanks!</p>
        <p>— ${myName}, ${companyName}</p>
      `,
    });
    if (!emailRes.ok) {
      const emailData = await emailRes.json();
      throw new Error(`Resend error: ${emailData.message ?? emailRes.statusText}`);
    }

    // SMS 1 — Congratulations immediately
    await sendSMS(phone, `Congratulations, you signed up with ${companyName}! 🎉`);

    // SMS 2 — Check email (10 sec later via queue)
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      business_id: bid,
      message_type: "sms",
      message_content: `I just sent your onboarding info to your email. Please let me know when you receive it. PS: check your junk/spam/promotions just in case! — ${companyName}`,
      scheduled_at: new Date(Date.now() + 10 * 1000).toISOString(),
      status: "pending",
      metadata: { to: phone },
    });

    // Internal notification
    await notifyAdmin(`🙌 New client signup! ${contact.full_name} just signed up. Email: ${email}. Phone: ${phone}`);

    const currentTags: string[] = Array.isArray(contact.tags) ? contact.tags : [];
    const updatedTags = currentTags.includes("Needs to Fill Out Onboarding Form") ? currentTags : [...currentTags, "Needs to Fill Out Onboarding Form"];

    await supabase
      .from("contacts")
      .update({
        pipeline: "Onboarding",
        stage: "New Client Waiting for Onboarding Form",
        tags: updatedTags,
      })
      .eq("id", contact.id);

    // Schedule the first form reminder in 48 hours
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      business_id: bid,
      message_type: "function_call",
      message_content: "FUNCTION_CALL:flow-ob-form-reminder",
      scheduled_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      status: "pending",
      metadata: { function_name: "flow-ob-form-reminder", payload: { contact_id: contact.id, business_id: bid, iteration: 1 } },
    });

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: bid,
      flow: "flow-ob-client-signup",
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