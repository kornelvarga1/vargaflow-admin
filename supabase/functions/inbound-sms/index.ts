import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = Deno.env.get("APP_URL") ?? "https://app.vargaflow.com";

const OUTREACH_PIPELINE = "Outreach";

// Stages we must NOT overwrite with 'Replied' — manual moves win.
const PROTECTED_REPLIED_STAGES = new Set([
  "Interested – Positive Reply",
  "Follow-up",
  "Appt Set",
]);

const OUTREACH_ANGLE_LABEL: Record<string, string> = {
  free_website: "Free Website",
  leads_incentive: "Leads Incentive",
};

// Inlined from _shared/outreach.ts (edge-function bundler doesn't follow _shared).
// Keep in sync with supabase/functions/_shared/outreach.ts.
const NEGATIVE_KEYWORDS = [
  "byebye", "bye bye", "stop", "not interested", "no thanks",
  "fuck off", "f off", "fuck you", "remove", "unsubscribe", "dnc",
  "wrong number", "lose my number", "don't text", "do not text",
];
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const NEGATIVE_PATTERNS = NEGATIVE_KEYWORDS.map((kw) => {
  const parts = kw.trim().split(/\s+/).map((w) => w.replace(REGEX_SPECIALS, "\\$&"));
  return new RegExp(`\\b${parts.join("\\s+")}\\b`, "i");
});
function matchesNegativeKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  return NEGATIVE_PATTERNS.some((re) => re.test(text));
}
async function addToDNC(
  supabase: any,
  phone: string,
  reason: string,
  sourceWorkflow: string | null,
  businessId: string | null,
): Promise<void> {
  if (!phone) return;
  const { error } = await supabase.from("dnc_list").insert({
    phone, reason, source_workflow: sourceWorkflow, business_id: businessId,
  });
  if (error && !/duplicate|unique/i.test(error.message)) {
    console.error(`[dnc] insert error for ${phone}:`, error.message);
  }
}

// Always return TwiML so Twilio doesn't retry on non-200 or missing body
const twiml = () =>
  new Response("<Response></Response>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return twiml();

  try {
    // Twilio sends application/x-www-form-urlencoded
    const text = await req.text();
    const params = new URLSearchParams(text);

    const from       = params.get("From") ?? "";
    const to         = params.get("To") ?? "";
    const body       = params.get("Body") ?? "";
    const messageSid = params.get("MessageSid") ?? "";

    console.log("[inbound-sms] From:", from, "To:", to, "Sid:", messageSid);

    if (!from || !to) {
      console.log("[inbound-sms] missing From/To — returning empty TwiML");
      return twiml();
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Look up business by the Twilio number that received the SMS
    const { data: settings, error: settingsErr } = await supabase
      .from("settings")
      .select("business_id, my_phone, twilio_phone_number")
      .eq("twilio_phone_number", to)
      .single();

    if (settingsErr || !settings?.business_id) {
      console.log("[inbound-sms] no business found for number:", to, settingsErr?.message);
      return twiml();
    }

    const businessId = settings.business_id;

    // 2. Find or create contact by phone
    //    CRM contacts have business_id = null, so try that first before falling back to business_id match
    let contactId: string;

    const { data: byNullBiz } = await supabase
      .from("contacts")
      .select("id, full_name, pipeline, outreach_angle, stage")
      .eq("phone", from)
      .is("business_id", null)
      .maybeSingle();

    const { data: byBiz } = !byNullBiz ? await supabase
      .from("contacts")
      .select("id, full_name, pipeline, outreach_angle, stage")
      .eq("phone", from)
      .eq("business_id", businessId)
      .maybeSingle() : { data: null };

    const existing = byNullBiz ?? byBiz;

    if (existing) {
      contactId = existing.id;
      console.log("[inbound-sms] existing contact:", contactId);
    } else {
      const { data: created, error: createErr } = await supabase
        .from("contacts")
        .insert({
          phone: from,
          business_id: null,
          full_name: from,      // placeholder — can be updated later
          pipeline: "Sales",
          stage: "Lead",
        })
        .select("id")
        .single();

      if (createErr || !created) {
        console.error("[inbound-sms] failed to create contact:", createErr?.message);
        return twiml();
      }

      contactId = created.id;
      console.log("[inbound-sms] new contact created:", contactId);
    }

    const now = new Date().toISOString();

    // 3. Insert inbound message into message_queue
    const { error: mqErr } = await supabase.from("message_queue").insert({
      contact_id:      contactId,
      business_id:     businessId,
      direction:       "inbound",
      status:          "received",
      message_type:    "sms",
      message_content: body,
      to_phone:        from,
      scheduled_at:    now,
      metadata:        { from, to, message_sid: messageSid },
    });

    if (mqErr) {
      console.error("[inbound-sms] message_queue insert failed:", mqErr.message);
    } else {
      console.log("[inbound-sms] message queued for contact:", contactId);
    }

    // 4. Log to activity_log
    try {
      await supabase.from("activity_log").insert({
        contact_id:    contactId,
        business_id:   businessId,
        activity_type: "inbound_sms",
        description:   `Inbound SMS: "${body.slice(0, 100)}${body.length > 100 ? "…" : ""}"`,
      });
    } catch (logErr) {
      console.error("[inbound-sms] activity_log insert failed:", logErr);
    }

    // 4b. Outreach reply handling (only when contact is in the outreach pipeline).
    //     Negative keyword → DNC + force Not Interested. Non-negative → stage='Replied'
    //     (idempotent: don't overwrite manual moves). Stop active outreach sequences in both cases.
    const isOutreach = existing?.pipeline === OUTREACH_PIPELINE;
    let outreachHandled = false;

    if (isOutreach) {
      outreachHandled = true;
      const isNegative = matchesNegativeKeyword(body);
      const angle = existing?.outreach_angle ?? null;
      const angleLabel = (angle && OUTREACH_ANGLE_LABEL[angle]) || "Outreach";

      if (isNegative) {
        await addToDNC(supabase, from, "negative_keyword", angle, businessId);
        await supabase
          .from("contacts")
          .update({ stage: "Not Interested", stage_entered_at: now })
          .eq("id", contactId);
      } else if (!PROTECTED_REPLIED_STAGES.has(existing?.stage ?? "")) {
        await supabase
          .from("contacts")
          .update({ stage: "Replied", stage_entered_at: now })
          .eq("id", contactId);
      }

      // Stop any active outreach contact_sequences so queued followups no-op.
      try {
        const { data: activeSeqs } = await supabase
          .from("contact_sequences")
          .select("id, sequence:sequences(pipeline)")
          .eq("contact_id", contactId)
          .eq("status", "active");
        const outreachSeqIds = (activeSeqs ?? [])
          .filter((s: any) => s.sequence?.pipeline === OUTREACH_PIPELINE)
          .map((s: any) => s.id);
        if (outreachSeqIds.length > 0) {
          await supabase
            .from("contact_sequences")
            .update({ status: "stopped" })
            .in("id", outreachSeqIds);
        }
      } catch (stopErr) {
        console.error("[inbound-sms] failed to stop outreach sequences:", stopErr);
      }

      // Send outreach-specific notification to my_phone.
      try {
        if (settings.my_phone) {
          const twilioSid  = Deno.env.get("TWILIO_ACCOUNT_SID")!;
          const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
          const twilioFrom = settings.twilio_phone_number ?? Deno.env.get("TWILIO_PHONE_NUMBER")!;
          const preview    = body.slice(0, 200) + (body.length > 200 ? "…" : "");
          const tag        = isNegative ? "DNC" : "REPLY";
          const message    = `[${tag}] New reply from ${angleLabel} | ${from} | ${preview}`;

          await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: "Basic " + btoa(`${twilioSid}:${twilioAuth}`),
              },
              body: new URLSearchParams({ To: settings.my_phone, From: twilioFrom, Body: message }),
            },
          );
        }
      } catch (notifyErr) {
        console.error("[inbound-sms] outreach notification failed:", notifyErr);
      }
    }

    // 5. Notify contractor via SMS (direct Twilio — not queued, so it never appears in the inbox).
    //    Skipped for outreach replies; they got their own notification above.
    try {
      if (!outreachHandled && settings.my_phone) {
        const twilioSid   = Deno.env.get("TWILIO_ACCOUNT_SID")!;
        const twilioAuth  = Deno.env.get("TWILIO_AUTH_TOKEN")!;
        const twilioFrom  = Deno.env.get("TWILIO_PHONE_NUMBER")!;
        const contactName = existing?.full_name ?? from;
        const preview     = body.slice(0, 100) + (body.length > 100 ? "…" : "");
        const message     = `Reply from ${contactName}: "${preview}"\n${APP_URL}/messages`;

        await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: "Basic " + btoa(`${twilioSid}:${twilioAuth}`),
            },
            body: new URLSearchParams({ To: settings.my_phone, From: twilioFrom, Body: message }),
          }
        );
      }
    } catch (notifyErr) {
      console.error("[inbound-sms] contractor notification failed:", notifyErr);
    }

    return twiml();

  } catch (err) {
    console.error("[inbound-sms] unexpected error:", err);
    // Always return valid TwiML so Twilio doesn't retry
    return twiml();
  }
});
