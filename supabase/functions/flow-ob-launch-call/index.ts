import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSettings, sendEmailWithUnsubscribe, validateWebhookToken } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!validateWebhookToken(req, "CALENDLY_WEBHOOK_TOKEN")) {
    console.warn("[flow-ob-launch-call] rejected: invalid or missing ?k= token");
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { contact_id, appointment_time, meeting_link, business_id } = body;

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
    const myPhone = settings.my_phone || "";
    const myEmail = settings.my_email || "hello@vargaflow.com";
    const companyName = settings.company_name || "Local Scaling";
    const videoLink = settings.software_explanation_video || "[video link]";
    const resendKey = Deno.env.get("RESEND_API_KEY")!;

    const firstName = contact.full_name?.split(" ")[0] ?? "there";
    const phone = contact.phone;
    const email = contact.email;
    const zoomLink = meeting_link || "[zoom link]";
    // Pull the contact's local TZ (saved by flow-call-booked from
    // invitee.timezone). Fallback to ET so older contacts without the column
    // still render a sane time.
    const contactTz = contact.timezone || "America/New_York";
    const formatTime = (tz: string) =>
      appointment_time
        ? new Date(appointment_time).toLocaleString("en-US", { timeZone: tz })
        : "your scheduled time";
    const apptTimeForContact = formatTime(contactTz);
    // Internal SMS goes to Kornél in Hungary (DST-aware via Europe/Budapest).
    const apptTimeForMe = formatTime("Europe/Budapest");
    const meetingDate = appointment_time ? new Date(appointment_time) : new Date();

    const now = Date.now();

    const queueSMS = async (to: string, body: string, scheduledAt: Date) => {
      if (scheduledAt.getTime() <= now) return; // skip past-time reminders
      await supabase.from("message_queue").insert({
        contact_id: contact.id,
        business_id: bid,
        message_type: "sms",
        message_content: body,
        scheduled_at: scheduledAt.toISOString(),
        status: "pending",
        metadata: { to },
      });
    };

    const queueEmail = async (to: string, subject: string, html: string, scheduledAt: Date) => {
      if (scheduledAt.getTime() <= now) return; // skip past-time reminders
      await supabase.from("message_queue").insert({
        contact_id: contact.id,
        business_id: bid,
        message_type: "email",
        message_content: html,
        scheduled_at: scheduledAt.toISOString(),
        status: "pending",
        metadata: { to, subject, ...(myEmail ? { reply_to: myEmail } : {}) },
      });
    };

    // Cancel any pending messages from prior sequences before queuing new ones
    await supabase
      .from("message_queue")
      .update({ status: "cancelled" })
      .eq("contact_id", contact.id)
      .eq("status", "pending");

    // Immediately: update pipeline + internal notification
    await supabase
      .from("contacts")
      .update({ stage: "Launch Call Booked" })
      .eq("id", contact.id);

    if (myPhone) {
      await supabase.from("message_queue").insert({
        contact_id: contact.id,
        business_id: bid,
        message_type: "sms",
        message_content: `🚀 Launch call booked by ${contact.full_name}. They just booked for ${apptTimeForMe}. Remember to quality check their account before the call!`,
        scheduled_at: new Date().toISOString(),
        status: "pending",
        metadata: { to: myPhone },
      });
    }

    // Immediately: confirmation SMS to client
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      business_id: bid,
      message_type: "sms",
      message_content: `Hey ${firstName}, your launch call with ${myName} has been booked for ${apptTimeForContact}. This will be a 20-30 minute walkthrough of your new website + marketing systems. Please join on a computer — it will make everything much easier. Talk soon! — ${myName}`,
      scheduled_at: new Date().toISOString(),
      status: "pending",
      metadata: { to: phone },
    });

    // Immediately: confirmation email
    const emailRes = await sendEmailWithUnsubscribe({
      resendKey,
      from: `${companyName} <hello@vargaflow.com>`,
      to: email,
      subject: `Your launch call is booked for ${apptTimeForContact}`,
      contactId: contact.id,
      replyTo: myEmail,
      html: `
        <p>Congrats ${firstName}!</p>
        <p>Your launch call has been scheduled for ${apptTimeForContact}.</p>
        <p>It will be a 20-30 minute Zoom call. You'll get the Zoom link in your inbox 10 minutes before your appointment.</p>
        <p>If you want to watch a walkthrough video: <a href="${videoLink}">click here</a></p>
        <p>Looking forward to walking you through it!</p>
        <p>— ${myName}, ${companyName}</p>
      `,
    });
    if (!emailRes.ok) {
      const emailData = await emailRes.json();
      throw new Error(`Resend error: ${emailData.message ?? emailRes.statusText}`);
    }

    // 24hr before
    const reminder24h = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000);
    await queueSMS(
      phone,
      `Hey ${firstName}, just a reminder — your launch call with me from ${companyName} is in 24 hours at ${apptTimeForContact}. I'll be sending the Zoom link 10 minutes before 😄`,
      reminder24h
    );
    if (myPhone) {
      await queueSMS(myPhone, `24hr reminder — launch call with ${contact.full_name} is tomorrow. Number: ${phone}`, reminder24h);
    }

    // 1hr before
    const reminder1h = new Date(meetingDate.getTime() - 60 * 60 * 1000);
    await queueSMS(
      phone,
      `Your launch call with ${myName} from ${companyName} is in 1 hour! Your Zoom link will be at the top of your inbox 10 minutes before. Here's the text link: ${zoomLink}`,
      reminder1h
    );
    await queueEmail(
      email,
      `Your launch call is in 1 hour`,
      `<p>Hey ${firstName}, here's the link to your launch call. Talk to you in 1 hour!</p><p><a href="${zoomLink}">Click here to join</a></p>`,
      reminder1h
    );
    if (myPhone) {
      await queueSMS(myPhone, `Launch call with ${contact.full_name} is in 1 hour. Number: ${phone}. Zoom: ${zoomLink}`, reminder1h);
    }

    // 10min before
    const reminder10m = new Date(meetingDate.getTime() - 10 * 60 * 1000);
    await queueSMS(
      phone,
      `Zoom link is in your inbox — talk to you in 10 minutes! If joining on phone: ${zoomLink}. Please try to join from a computer 😄`,
      reminder10m
    );
    await queueEmail(
      email,
      `Your launch call is in 10 minutes`,
      `<p>Hey ${firstName}, here's the link — talk to you in 10 minutes!</p><p><a href="${zoomLink}">Click here to join</a></p>`,
      reminder10m
    );
    if (myPhone) {
      await queueSMS(myPhone, `🚀 Launch call with ${contact.full_name} is in 10 minutes — get on Zoom! Number: ${phone}`, reminder10m);
    }

    // 3 days after: scam warning
    await queueSMS(
      phone,
      `Just a quick heads up — whenever a new website/Google page goes live, hundreds of companies get notified in the first 2-3 weeks. You'll probably get some spam calls. Don't fall for any sketchy salespeople pitching SEO/web stuff 😄 — ${myName}`,
      new Date(meetingDate.getTime() + 3 * 24 * 60 * 60 * 1000)
    );

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: bid,
      flow: "flow-ob-launch-call",
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