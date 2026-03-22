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
    const myEmail = settings.my_email || "hello@vargaflow.com";
    const companyName = settings.company_name || "Local Scaling";
    const onboardingFormLink = settings.onboarding_form_link || "[onboarding form link]";

    const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const twilioFrom = Deno.env.get("TWILIO_PHONE_NUMBER")!;
    const resendKey = Deno.env.get("RESEND_API_KEY")!;

    const sendSMS = async (to: string, body: string) => {
      if (!to) return;
      await fetch(
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
    };

    const firstName = contact.full_name?.split(" ")[0] ?? "there";
    const phone = contact.phone;
    const email = contact.email;

    // Send onboarding email immediately
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${companyName} <hello@vargaflow.com>`,
        to: email,
        subject: "Let's Get You Onboarded!",
        html: `
          <p>Hey ${firstName},</p>
          <p>Please go through these steps so we can get started on your website and marketing systems.</p>
          <p><strong>Step 1:</strong> Fill in the setup form: <a href="${onboardingFormLink}">${onboardingFormLink}</a></p>
          <p><strong>Step 2:</strong> Send us at least 25 photos of your finished projects — email them to ${myEmail}</p>
          <p><strong>Step 3:</strong> Give us access to your Google My Business.</p>
          <p>Thanks! — ${myName}, ${companyName}</p>
        `,
      }),
    });

    // SMS 1 — Congratulations immediately
    await sendSMS(phone, `Congratulations, you signed up with ${companyName}! 🎉`);

    // SMS 2 — Check email (10 sec later via queue)
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      message_type: "sms",
      message_content: `We just sent your onboarding information to your email. Please let us know when you receive it. PS: check your junk/spam just in case! — ${companyName}`,
      scheduled_at: new Date(Date.now() + 10 * 1000).toISOString(),
      status: "pending",
      metadata: { to: phone },
    });

    // Internal notification
    if (myPhone) {
      await sendSMS(
        myPhone,
        `🙌 New client signup! ${contact.full_name} just signed up. Email: ${email}. Phone: ${phone}`
      );
    }

    await supabase
      .from("contacts")
      .update({
        pipeline: "Onboarding",
        stage: "New Client Waiting for Onboarding Form",
        tags: "Needs to Fill Out Onboarding Form",
      })
      .eq("id", contact.id);

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
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