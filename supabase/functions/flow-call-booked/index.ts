import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();

    const event = body.payload ?? body;
    const businessId = body.business_id ?? event.business_id;
    const eventId = event.uri ?? event.uuid ?? crypto.randomUUID();
    const invitee = event.invitee ?? {};
    const eventTime = event.event?.start_time ?? event.start_time;

    const contactName = invitee.name ?? "there";
    const contactEmail = invitee.email ?? "";
    const contactPhone = invitee.text_reminder_number ?? "";
    const meetingLink = event.event?.location?.join_url ?? "";
    const appointmentTime = eventTime
      ? new Date(eventTime).toLocaleString("en-US", { timeZone: "America/New_York" })
      : "your scheduled time";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Prevent duplicate webhook triggers
    const { error: dupError } = await supabase
      .from("processed_webhooks")
      .insert({ event_id: eventId });
    if (dupError) {
      return new Response(JSON.stringify({ skipped: "duplicate" }), { status: 200 });
    }

    // Find or create contact
    let contact;
    const { data: existing } = await supabase
      .from("contacts")
      .select("*")
      .eq("email", contactEmail)
      .single();

    if (existing) {
      contact = existing;
    } else {
      const { data: newContact, error: insertError } = await supabase
        .from("contacts")
        .insert({
          full_name: contactName,
          email: contactEmail,
          phone: contactPhone,
          business_id: businessId,
          pipeline: "Sales",
          stage: "Zoom Call Booked",
        })
        .select()
        .single();
      if (insertError) throw new Error(`Contact error: ${insertError.message}`);
      contact = newContact;
    }

    const bid = businessId ?? contact.business_id;

    // Cancel any pending messages from prior sequences before queuing new ones
    await supabase
      .from("message_queue")
      .update({ status: "cancelled" })
      .eq("contact_id", contact.id)
      .eq("status", "pending");

    await supabase
      .from("contacts")
      .update({ stage: "Zoom Call Booked" })
      .eq("id", contact.id);

    // Load settings from settings table
    const { data: settings, error: settingsError } = await supabase
      .from("settings")
      .select("*")
      .eq("business_id", bid)
      .single();
    if (settingsError) throw new Error(`Settings error: ${settingsError.message}`);

    const myName = settings.my_name || "Kornel";
    const myPhone = settings.my_phone || "";
    const companyName = settings.company_name || "Local Scaling";
    const videoLink = settings.software_explanation_video || "[video link]";
    const websiteUrl = settings.website_url || "[website]";
    const testimonialsLink = settings.testimonials_link || "[testimonials]";

    const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const twilioFrom = Deno.env.get("TWILIO_PHONE_NUMBER")!;
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

    const sendEmail = async (to: string, subject: string, html: string) => {
      if (!to) return;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${companyName} <hello@vargaflow.com>`,
          to,
          subject,
          html,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(`Resend error: ${data.message ?? res.statusText}`);
      }
    };

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
        metadata: { to, subject },
      });
    };

    const { data: tags } = await supabase
      .from("contacts")
      .select("tags")
      .eq("id", contact.id)
      .single();

    const tagsArr: string[] = Array.isArray(tags?.tags) ? tags.tags : [];
    const hasBookedTag = tagsArr.includes("Booked");
    const meetingDate = eventTime ? new Date(eventTime) : new Date();

    // Step 1: Confirmation SMS immediately
    await sendSMS(
      contactPhone,
      `Booked! Your Zoom call with ${myName} is all set for ${appointmentTime}. — ${myName}`
    );

    // Step 2: Internal SMS immediately
    if (myPhone) {
      await sendSMS(
        myPhone,
        `${contactName} just booked the call. Date: ${appointmentTime}. Number: ${contactPhone}.`
      );
    }

    if (!hasBookedTag) {
      // YES BRANCH — First time booker
      const updatedTags = tagsArr.includes("Booked") ? tagsArr : [...tagsArr, "Booked"];
      await supabase.from("contacts").update({ tags: updatedTags }).eq("id", contact.id);

      await sendEmail(
        contactEmail,
        `Action Required — Call with ${myName}`,
        `<p>${contactName}, your Zoom call has been booked.</p>
         <p>Date: ${appointmentTime}</p>
         <p>Join link: ${meetingLink || "[Zoom link will be sent before call]"}</p>
         <p>Reply YES to confirm.</p>
         <p>— ${myName}</p>`
      );

      await queueSMS(
        contactPhone,
        `Hey, it's ${myName}. I am real this time 😄 I have our Zoom call scheduled for ${appointmentTime} your time. Have you added it to your calendar?`,
        new Date(Date.now() + 2 * 60 * 1000)
      );

      await queueSMS(
        contactPhone,
        `👍👍 By the way, here is that short video breaking down exactly what we do: ${videoLink}`,
        new Date(Date.now() + 4 * 60 * 1000)
      );

      const reminder24h = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000);
      await queueSMS(
        contactPhone,
        `Hey, we have our call tomorrow. Just wanted to hit you with a few links if you want to do your homework on us: ${websiteUrl} ${videoLink}`,
        reminder24h
      );
      await queueEmail(
        contactEmail,
        `Action Required — Zoom Call with ${myName}`,
        `<p>Don't forget ${contactName}, your Zoom call with ${myName} is in 24 hours at ${appointmentTime}.</p>
         <p>Please reply YES to confirm. Talk soon, ${myName}, ${companyName}</p>`,
        reminder24h
      );

      await queueSMS(
        contactPhone,
        `Excited to talk in a few hours ${contactName}. I Googled your business and have some notes on easy fixes you can implement yourself. Talk soon, ${myName}`,
        new Date(meetingDate.getTime() - 2 * 60 * 60 * 1000)
      );

      const reminder1h = new Date(meetingDate.getTime() - 60 * 60 * 1000);
      await queueSMS(
        contactPhone,
        `See you on Zoom in 1 hour! Just sent the Zoom link to your email. Here it is: ${meetingLink}`,
        reminder1h
      );
      await queueEmail(
        contactEmail,
        `Your Zoom call is in 1 hour`,
        `<p>Hey ${contactName}, your Zoom call with me is in 1 hour at ${appointmentTime}. Talk soon, ${myName}, ${companyName}</p>
         <p><a href="${meetingLink}">Click here to join</a></p>`,
        reminder1h
      );
      if (myPhone) {
        await queueSMS(myPhone, `Your sales call with ${contactName} is in 1 hour. Number: ${contactPhone}.`, reminder1h);
      }

      const reminder10m = new Date(meetingDate.getTime() - 10 * 60 * 1000);
      await queueSMS(
        contactPhone,
        `Talk to you in 10 minutes! Joining on laptop is better. Here's the link if on phone: ${meetingLink}`,
        reminder10m
      );
      await queueEmail(
        contactEmail,
        `Zoom call in 10 minutes`,
        `<p>Hey ${contactName}, your Zoom call is in 10 minutes! <a href="${meetingLink}">Click here to join</a></p>`,
        reminder10m
      );

      const reminder3m = new Date(meetingDate.getTime() - 3 * 60 * 1000);
      await queueSMS(
        contactPhone,
        `I am on Zoom whenever you're ready. Here's the link if joining on phone: ${meetingLink}`,
        reminder3m
      );
      if (myPhone) {
        await queueSMS(myPhone, `Your sales call with ${contactName} is in 3 minutes. Number: ${contactPhone}.`, reminder3m);
      }

    } else {
      // NO BRANCH — Returning booker
      await sendEmail(
        contactEmail,
        `Action Required — Call with ${myName}`,
        `<p>${contactName}, your Zoom call has been booked.</p>
         <p>Date: ${appointmentTime}</p>
         <p>— ${myName}</p>`
      );

      await queueSMS(
        contactPhone,
        `Hey ${contactName}, got you scheduled in again for ${appointmentTime}. This 100% works for you, right? — ${myName}`,
        new Date(Date.now() + 60 * 1000)
      );

      await queueSMS(
        contactPhone,
        `😊 You might have seen these already but just so you know, we are not full of it — I take a lot of pride in our reviews: ${testimonialsLink}`,
        new Date(Date.now() + 15 * 60 * 1000)
      );

      const reminder24h = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000);
      await queueSMS(
        contactPhone,
        `Hey, see you on Zoom tomorrow. Just wanted to confirm your appointment. Talk soon, ${myName}, ${companyName}`,
        reminder24h
      );

      await queueSMS(
        contactPhone,
        `Here's that video again if you want to watch before our call — just 6 minutes: ${videoLink}`,
        new Date(meetingDate.getTime() - 2 * 60 * 60 * 1000)
      );

      const reminder1h = new Date(meetingDate.getTime() - 60 * 60 * 1000);
      await queueSMS(
        contactPhone,
        `See you in an hour! Sending the link to your email. Here it is: ${meetingLink} — ${myName}`,
        reminder1h
      );
      if (myPhone) {
        await queueSMS(myPhone, `Your sales call with ${contactName} is in 1 hour. Number: ${contactPhone}.`, reminder1h);
      }

      const reminder10m = new Date(meetingDate.getTime() - 10 * 60 * 1000);
      await queueSMS(
        contactPhone,
        `See you in 10 minutes! Just sent the meeting link to your email so it's at the top of your inbox`,
        reminder10m
      );
      await queueEmail(
        contactEmail,
        `Zoom call in 10 minutes`,
        `<p>Hey ${contactName}, your Zoom call is in 10 minutes! <a href="${meetingLink}">Click here to join</a></p>`,
        reminder10m
      );

      const reminder5m = new Date(meetingDate.getTime() - 5 * 60 * 1000);
      await queueSMS(
        contactPhone,
        `I am on the call. Let me know if you can't find the link.`,
        reminder5m
      );
      if (myPhone) {
        await queueSMS(myPhone, `Your sales call with ${contactName} is in 5 minutes. Number: ${contactPhone}.`, reminder5m);
      }
    }

    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: bid,
      flow: "flow-call-booked",
      status: "completed",
      ran_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({ success: true, contact_id: contact.id, branch: hasBookedTag ? "returning" : "first-time" }),
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