import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getTwilioFromNumber, normalizePhone, validateWebhookToken } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!validateWebhookToken(req, "CALENDLY_WEBHOOK_TOKEN")) {
    console.warn("[flow-call-booked] rejected: invalid or missing ?k= token");
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  console.log("[1] flow-call-booked invoked");

  try {
    const body = await req.json();
    console.log("[2] body parsed:", JSON.stringify(body).slice(0, 500));

    const event = body.payload ?? body;
    console.log("[2.5] full raw payload:", JSON.stringify(event));

    const businessId = body.business_id ?? event.business_id ?? Deno.env.get("VARGA_FLOW_ADMIN_BID");
    const eventId = event.uri ?? event.uuid ?? crypto.randomUUID();
    const invitee = event.invitee ?? {};
    const eventTime = event.scheduled_event?.start_time ?? event.start_time;
    console.log("[2.7] eventTime raw value:", eventTime, "| source: event.scheduled_event?.start_time:", event.scheduled_event?.start_time, "| fallback event.start_time:", event.start_time);

    const contactName = invitee.name ?? event.name ?? event.first_name ?? "there";
    const contactEmail = invitee.email ?? event.email ?? "";
    const meetingLink = event.scheduled_event?.location?.join_url ?? "";
    // Calendly auto-detects the invitee's TZ from their browser. Fallback to
    // ET so the lead's reminder still reads sanely if Calendly omits it.
    const inviteeTz = invitee.timezone ?? event.timezone ?? "America/New_York";
    const formatTime = (tz: string) =>
      eventTime ? new Date(eventTime).toLocaleString("en-US", { timeZone: tz }) : "your scheduled time";
    const appointmentTimeForContact = formatTime(inviteeTz);
    // Internal SMS goes to Kornél in Hungary — Europe/Budapest handles DST
    // automatically (CET in winter, CEST in summer).
    const appointmentTimeForMe = formatTime("Europe/Budapest");

    // Extract phone: check text_reminder_number first, then questions_and_answers
    let contactPhone = invitee.text_reminder_number ?? "";
    if (!contactPhone && Array.isArray(event.questions_and_answers)) {
      const phoneEntry = event.questions_and_answers.find((qa: { question: string; answer: string }) =>
        /phone|mobile|cell|number/i.test(qa.question)
      );
      if (phoneEntry?.answer) contactPhone = phoneEntry.answer;
      console.log("[2.6] questions_and_answers phone search:", phoneEntry ?? "not found");
    }

    console.log("[3] parsed fields — eventId:", eventId, "email:", contactEmail, "phone:", contactPhone, "businessId:", businessId);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Prevent duplicate webhook triggers
    const { error: dupError } = await supabase
      .from("processed_webhooks")
      .insert({ event_id: eventId });
    if (dupError) {
      console.log("[4] duplicate webhook, skipping. error:", dupError.message);
      return new Response(JSON.stringify({ skipped: "duplicate" }), { status: 200 });
    }
    console.log("[4] dedup passed");

    // Find or create contact — match by email first, then by normalized phone
    // so duplicates don't slip in when the Calendly webhook fires for a contact
    // we already track. Normalization keeps everything E.164-consistent with
    // the (business_id, phone) unique constraint.
    const normalizedPhone = normalizePhone(contactPhone);
    let contact;

    const { data: byEmail } = contactEmail ? await supabase
      .from("contacts")
      .select("*")
      .eq("email", contactEmail)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle() : { data: null };

    const { data: byPhone } = !byEmail && normalizedPhone ? await supabase
      .from("contacts")
      .select("*")
      .eq("phone", normalizedPhone)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle() : { data: null };

    contact = byEmail ?? byPhone;

    if (contact) {
      console.log("[5] existing contact found:", contact.id, "phone:", contact.phone);
      // Backfill timezone if Calendly provided one and we don't have it yet.
      if (invitee.timezone && !contact.timezone) {
        await supabase.from("contacts").update({ timezone: invitee.timezone }).eq("id", contact.id);
      }
    } else {
      const { data: newContact, error: insertError } = await supabase
        .from("contacts")
        .insert({
          full_name: contactName,
          email: contactEmail,
          phone: normalizedPhone,
          business_id: businessId,
          pipeline: "Sales",
          stage: "Zoom Call Booked",
          timezone: invitee.timezone ?? null,
        })
        .select()
        .single();
      if (insertError) throw new Error(`Contact error: ${insertError.message}`);
      contact = newContact;
      console.log("[5] new contact created:", contact.id);
    }

    const bid = businessId ?? contact.business_id;
    const resolvedPhone = normalizedPhone || contact.phone || "";
    console.log("[6] bid:", bid, "resolvedPhone:", resolvedPhone);

    if (!resolvedPhone) {
      console.log("[6-WARN] no phone number found anywhere — skipping SMS sequences and exiting gracefully");
      await supabase.from("automation_logs").insert({
        contact_id: contact.id,
        business_id: bid,
        flow: "flow-call-booked",
        status: "skipped-no-phone",
        ran_at: new Date().toISOString(),
      });
      return new Response(
        JSON.stringify({ success: false, reason: "no phone number available for contact" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If the contact record had no phone but the webhook provided one, save it
    if (normalizedPhone && !contact.phone) {
      await supabase.from("contacts").update({ phone: normalizedPhone }).eq("id", contact.id);
    }

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
    console.log("[7] fetching settings, bid:", bid);
    const { data: settings, error: settingsError } = await supabase
      .from("settings")
      .select("*")
      .eq("business_id", bid)
      .single();
    if (settingsError) throw new Error(`Settings error: ${settingsError.message}`);
    console.log("[8] settings loaded, my_name:", settings.my_name, "my_phone:", settings.my_phone);

    // If bid was missing, resolve it from settings so downstream inserts have it
    const resolvedBid = bid ?? settings.business_id;

    const myName = settings.my_name || "Kornel";
    const myPhone = settings.my_phone || "";
    const companyName = settings.company_name || "Local Scaling";
    const videoLink = settings.software_explanation_video || "[video link]";
    const websiteUrl = settings.website_url || "[website]";
    const testimonialsLink = settings.testimonials_link || "[testimonials]";

    const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const twilioFrom = await getTwilioFromNumber(supabase, businessId);
    const resendKey = Deno.env.get("RESEND_API_KEY")!;
    console.log("[9] twilio from:", twilioFrom, "twilioSid set:", !!twilioSid, "resendKey set:", !!resendKey);

    const sendSMS = async (to: string, body: string) => {
      if (!to) { console.log("[SMS] skipped — no 'to' number"); return; }
      console.log("[SMS] sending to:", to, "from:", twilioFrom);
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
      console.log("[SMS] sent ok to:", to);
    };

    const sendEmail = async (to: string, subject: string, html: string) => {
      if (!to) return;
      console.log("[EMAIL] sending to:", to, "subject:", subject);
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
          ...(settings.my_email ? { reply_to: settings.my_email } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(`Resend error: ${data.message ?? res.statusText}`);
      }
      console.log("[EMAIL] sent ok to:", to);
    };

    const now = Date.now();

    const queueSMS = async (to: string, body: string, scheduledAt: Date) => {
      if (scheduledAt.getTime() <= now) { console.log("[QUEUE] skipped past-time SMS for:", to, "at:", scheduledAt.toISOString()); return; }
      const { error: qErr } = await supabase.from("message_queue").insert({
        contact_id: contact.id,
        business_id: resolvedBid,
        message_type: "sms",
        message_content: body,
        scheduled_at: scheduledAt.toISOString(),
        status: "pending",
        metadata: { to },
      });
      if (qErr) {
        console.error("[QUEUE] insert FAILED for:", to, "scheduled_at:", scheduledAt.toISOString(), "error:", qErr.message);
      } else {
        console.log("[QUEUE] insert OK — to:", to, "scheduled_at:", scheduledAt.toISOString());
      }
    };

    const queueEmail = async (to: string, subject: string, html: string, scheduledAt: Date) => {
      if (!to) { console.log("[QUEUE EMAIL] skipped — no email address"); return; }
      if (scheduledAt.getTime() <= now) { console.log("[QUEUE EMAIL] skipped past-time email for:", to, "at:", scheduledAt.toISOString()); return; }
      console.log("[QUEUE EMAIL] inserting — to:", to, "subject:", subject, "scheduled_at:", scheduledAt.toISOString());
      const { error: qErr } = await supabase.from("message_queue").insert({
        contact_id: contact.id,
        business_id: resolvedBid,
        message_type: "email",
        message_content: html,
        scheduled_at: scheduledAt.toISOString(),
        status: "pending",
        metadata: { to, subject, ...(settings.my_email ? { reply_to: settings.my_email } : {}) },
      });
      if (qErr) {
        console.error("[QUEUE EMAIL] insert FAILED — to:", to, "subject:", subject, "error:", qErr.message);
      } else {
        console.log("[QUEUE EMAIL] insert OK — to:", to, "scheduled_at:", scheduledAt.toISOString());
      }
    };

    const { data: tags } = await supabase
      .from("contacts")
      .select("tags")
      .eq("id", contact.id)
      .single();

    const tagsArr: string[] = Array.isArray(tags?.tags) ? tags.tags : [];
    const hasBookedTag = tagsArr.includes("Booked");
    const meetingDate = eventTime ? new Date(eventTime) : new Date();
    console.log("[10] hasBookedTag:", hasBookedTag, "| eventTime:", eventTime ?? "UNDEFINED — meetingDate will be now(), all reminders will be skipped as past-time", "| meetingDate:", meetingDate.toISOString());

    // Step 1: Confirmation SMS immediately
    console.log("[11] sending confirmation SMS to:", resolvedPhone);
    await sendSMS(
      resolvedPhone,
      `Booked! Your Zoom call with ${myName} is all set for ${appointmentTimeForContact}. — ${myName}`
    );

    // Step 2: Internal SMS immediately
    console.log("[12] sending internal SMS to myPhone:", myPhone);
    if (myPhone) {
      await sendSMS(
        myPhone,
        `${contactName} just booked the call. Date: ${appointmentTimeForMe}. Number: ${resolvedPhone}.`
      );
    }

    if (!hasBookedTag) {
      console.log("[13] first-time booker branch");
      const updatedTags = tagsArr.includes("Booked") ? tagsArr : [...tagsArr, "Booked"];
      await supabase.from("contacts").update({ tags: updatedTags }).eq("id", contact.id);

      await sendEmail(
        contactEmail,
        `Your call with ${myName} is booked`,
        `<p>Hey ${contactName},</p>
         <p>Your Zoom call with ${myName} is booked for ${appointmentTimeForContact}.</p>
         <p>Join link: ${meetingLink || "[Zoom link will be sent before call]"}</p>
         <p>If anything's changed, just reply to this email.</p>
         <p>— ${myName}</p>`
      );

      await queueSMS(
        resolvedPhone,
        `By the way, here's a short video breaking down exactly what I built: ${videoLink}`,
        new Date(Date.now() + 4 * 60 * 1000)
      );

      const reminder24h = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000);
      await queueSMS(
        resolvedPhone,
        `Hey, we have our call tomorrow. A few links if you want to do your homework on me: ${websiteUrl} ${videoLink}`,
        reminder24h
      );
      await queueEmail(
        contactEmail,
        `Your Zoom call with ${myName} is in 24 hours`,
        `<p>Hey ${contactName},</p>
         <p>Don't forget — your Zoom call with ${myName} is in 24 hours at ${appointmentTimeForContact}.</p>
         <p>If anything's changed, just reply and we'll sort it out.</p>
         <p>— ${myName}, ${companyName}</p>`,
        reminder24h
      );

      await queueSMS(
        resolvedPhone,
        `Looking forward to our call in a few hours ${contactName}. Talk soon, ${myName}`,
        new Date(meetingDate.getTime() - 2 * 60 * 60 * 1000)
      );

      const reminder1h = new Date(meetingDate.getTime() - 60 * 60 * 1000);
      await queueSMS(
        resolvedPhone,
        `See you on Zoom in 1 hour! Zoom link is in your Calendly confirmation email — also here: ${meetingLink}`,
        reminder1h
      );
      await queueEmail(
        contactEmail,
        `Your Zoom call is in 1 hour`,
        `<p>Hey ${contactName},</p>
         <p>Your Zoom call with me is in 1 hour at ${appointmentTimeForContact}.</p>
         <p><a href="${meetingLink}">Click here to join</a></p>
         <p>Talk soon — ${myName}</p>`,
        reminder1h
      );
      if (myPhone) {
        await queueSMS(myPhone, `Your sales call with ${contactName} is in 1 hour. Number: ${resolvedPhone}.`, reminder1h);
      }

      const reminder10m = new Date(meetingDate.getTime() - 10 * 60 * 1000);
      await queueSMS(
        resolvedPhone,
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
        resolvedPhone,
        `I am on Zoom whenever you're ready. Here's the link if joining on phone: ${meetingLink}`,
        reminder3m
      );
      if (myPhone) {
        await queueSMS(myPhone, `Your sales call with ${contactName} is in 3 minutes. Number: ${resolvedPhone}.`, reminder3m);
      }

    } else {
      console.log("[13] returning booker branch");
      await sendEmail(
        contactEmail,
        `Your call with ${myName} is rebooked`,
        `<p>Hey ${contactName},</p>
         <p>Got you back on the calendar — Zoom call with ${myName} is set for ${appointmentTimeForContact}.</p>
         <p>If anything's changed, just reply to this email.</p>
         <p>— ${myName}</p>`
      );

      await queueSMS(
        resolvedPhone,
        `Hey ${contactName}, got you scheduled in again for ${appointmentTimeForContact}. This 100% works for you, right? — ${myName}`,
        new Date(Date.now() + 60 * 1000)
      );

      await queueSMS(
        resolvedPhone,
        `You might have seen this already but just so you know — I take a lot of pride in my work. Take a look: ${websiteUrl}`,
        new Date(Date.now() + 15 * 60 * 1000)
      );

      const reminder24h = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000);
      await queueSMS(
        resolvedPhone,
        `Hey, see you on Zoom tomorrow. Just wanted to confirm your appointment. Talk soon, ${myName}, ${companyName}`,
        reminder24h
      );

      await queueSMS(
        resolvedPhone,
        `Here's that video again if you want to watch before our call — just 6 minutes: ${videoLink}`,
        new Date(meetingDate.getTime() - 2 * 60 * 60 * 1000)
      );

      const reminder1h = new Date(meetingDate.getTime() - 60 * 60 * 1000);
      await queueSMS(
        resolvedPhone,
        `See you in an hour! Zoom link is in your Calendly confirmation email — also here: ${meetingLink} — ${myName}`,
        reminder1h
      );
      if (myPhone) {
        await queueSMS(myPhone, `Your sales call with ${contactName} is in 1 hour. Number: ${resolvedPhone}.`, reminder1h);
      }

      const reminder10m = new Date(meetingDate.getTime() - 10 * 60 * 1000);
      await queueSMS(
        resolvedPhone,
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
        resolvedPhone,
        `I am on the call. Let me know if you can't find the link.`,
        reminder5m
      );
      if (myPhone) {
        await queueSMS(myPhone, `Your sales call with ${contactName} is in 5 minutes. Number: ${resolvedPhone}.`, reminder5m);
      }
    }

    console.log("[14] all done, logging to automation_logs");
    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: resolvedBid,
      flow: "flow-call-booked",
      status: "completed",
      ran_at: new Date().toISOString(),
    });

    console.log("[15] success");
    return new Response(
      JSON.stringify({ success: true, contact_id: contact.id, branch: hasBookedTag ? "returning" : "first-time" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[ERROR]", err.message, err.stack);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
