import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID, findOrCreateContact, normalizePhone, notifyAdmin, validateTwilioSignature } from "../_shared/utils.ts";
import { handleInboundTextAgentReply } from "../_shared/textAgent.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

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
  free_trial_incentive: "Free Trial",
  ai_receptionist: "AI Receptionist",
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

    // Validate Twilio's signature before touching anything — endpoint is
    // public (verify_jwt=false) so the signature is our only auth.
    const paramObj: Record<string, string> = {};
    params.forEach((v, k) => { paramObj[k] = v; });
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const signature = req.headers.get("X-Twilio-Signature");
    // Supabase's gateway rewrites req.url to http + internal path; the Host
    // header points at edge-runtime.supabase.com. Neither matches the public
    // URL Twilio signed. req.url DOES preserve the public hostname though,
    // so reconstruct: https + that hostname + the public function path.
    const reqHost = new URL(req.url).host;
    const validationUrl = `https://${reqHost}/functions/v1/inbound-sms`;
    const valid = await validateTwilioSignature(authToken, signature, validationUrl, paramObj);
    if (!valid) {
      console.warn("[inbound-sms] invalid Twilio signature — rejecting");
      return new Response("Forbidden", { status: 403 });
    }

    // Twilio sends phones in E.164, but normalize anyway so we match the
    // (business_id, phone) unique index consistently regardless of source.
    const from       = normalizePhone(params.get("From")) ?? "";
    const to         = normalizePhone(params.get("To")) ?? "";
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
    // contactBid is what actually gets written to contacts.business_id. Your
    // own Twilio number resolves businessId to your internal admin account
    // (ADMIN_BUSINESS_ID) via the settings row — that's only a routing id,
    // never a real customer-owning business, so contacts stay
    // business_id=null like the rest of your own leads instead of vanishing
    // from the Contacts view (which filters business_id IS NULL for "mine").
    const contactBid = businessId === ADMIN_BUSINESS_ID ? null : businessId;

    // 2. Find or create contact by phone. findOrCreateContact scopes the
    //    match to contactBid first, falling back to a business_id=null
    //    legacy/CRM contact when nothing business-scoped exists yet — so the
    //    same phone number never ends up in two rows no matter which form,
    //    webhook, or flow it comes through.
    const { contact: existing, created: createdContact } = await findOrCreateContact(supabase, {
      phone: from,
      contactBusinessId: contactBid,
      onCreate: {
        full_name: from, // placeholder — can be updated later
        pipeline: "Sales",
        stage: "Lead In",
      },
    });

    const contactId: string = existing.id;
    const contactBusinessId: string | null = existing.business_id ?? null;
    console.log(`[inbound-sms] ${createdContact ? "new" : "existing"} contact:`, contactId, "business_id:", contactBusinessId);

    const now = new Date().toISOString();

    // 3. Insert inbound message into message_queue
    //    Use the contact's business_id so it appears in the correct app's inbox.
    const { data: mqRow, error: mqErr } = await supabase
      .from("message_queue")
      .insert({
        contact_id:      contactId,
        business_id:     contactBusinessId,
        direction:       "inbound",
        status:          "received",
        message_type:    "sms",
        message_content: body,
        to_phone:        from,
        scheduled_at:    now,
        sent_at:         now,
        metadata:        { from, to, message_sid: messageSid },
      })
      .select("id")
      .single();

    if (mqErr) {
      console.error("[inbound-sms] message_queue insert failed:", mqErr.message);
    } else {
      console.log("[inbound-sms] message queued for contact:", contactId);
    }

    // 3b. Fire push notification in the background so the contractor sees
    //     it within ~1s instead of waiting for the next cron tick. The push
    //     block in cron-message-sender stays as the safety net for rows we
    //     fail to mark push_notified=true here.
    if (!mqErr && mqRow?.id && contactBusinessId) {
      const pushUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-push-notification`;
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const messageId = mqRow.id;
      const bizId = contactBusinessId;
      EdgeRuntime.waitUntil((async () => {
        try {
          const res = await fetch(pushUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              business_id: bizId,
              title: "New reply",
              body: body.slice(0, 120),
            }),
          });
          console.log(`[inbound-sms] push fired for biz ${bizId} status=${res.status}`);
          await supabase
            .from("message_queue")
            .update({ push_notified: true })
            .eq("id", messageId);
        } catch (pushErr) {
          console.error("[inbound-sms] background push failed:", pushErr);
        }
      })());
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

    // Global negative-keyword handling: set dnd_sms=true so ALL future SMS
    // (sales, onboarding, outreach) are blocked by cron-message-sender.
    // Also cancel this contact's pending SMS so nothing already queued fires.
    const isNegativeGlobal = matchesNegativeKeyword(body);
    if (isNegativeGlobal && contactId) {
      await supabase
        .from("contacts")
        .update({ dnd_sms: true })
        .eq("id", contactId);
      await supabase
        .from("message_queue")
        .update({ status: "cancelled" })
        .eq("contact_id", contactId)
        .eq("status", "pending")
        .in("message_type", ["sms", "internal_sms"]);
    }

    if (isOutreach) {
      outreachHandled = true;
      const isNegative = isNegativeGlobal;
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
          .filter((s: any) => s.sequence?.pipeline?.toLowerCase() === OUTREACH_PIPELINE.toLowerCase())
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

      // Cancel all pending messages so nothing queued fires after a reply.
      try {
        await supabase
          .from("message_queue")
          .update({ status: "cancelled" })
          .eq("contact_id", contactId)
          .eq("status", "pending");
      } catch (cancelErr) {
        console.error("[inbound-sms] failed to cancel pending messages:", cancelErr);
      }

      // Notify via Telegram.
      try {
        const preview = body.slice(0, 200) + (body.length > 200 ? "…" : "");
        const tag     = isNegative ? "DNC" : "REPLY";
        await notifyAdmin(`[${tag}] New reply from ${angleLabel} | ${from} | ${preview}`);
      } catch (notifyErr) {
        console.error("[inbound-sms] outreach notification failed:", notifyErr);
      }
    }

    // 5. Notify via Telegram — skipped for outreach replies (already handled above).
    try {
      if (!outreachHandled) {
        const contactName = existing?.full_name ?? from;
        const preview     = body.slice(0, 100) + (body.length > 100 ? "…" : "");
        await notifyAdmin(`Reply from ${contactName}: "${preview}"\n${APP_URL}/messages`);
      }
    } catch (notifyErr) {
      console.error("[inbound-sms] contractor notification failed:", notifyErr);
    }

    // 6. AI text-agent auto-reply — Kornél's own line only, never for a
    //    negative/opt-out reply just handled above, and never for a contact
    //    already globally DNC'd from a previous message. Runs in the
    //    background (can take a few seconds across tool-use round trips) so
    //    the Twilio webhook response above isn't held up.
    if (!isNegativeGlobal && !existing?.dnd_sms && contactBusinessId === null) {
      EdgeRuntime.waitUntil(
        handleInboundTextAgentReply(supabase, { contact: existing, fromPhone: from, inboundBody: body })
      );
    }

    return twiml();

  } catch (err) {
    console.error("[inbound-sms] unexpected error:", err);
    // Always return valid TwiML so Twilio doesn't retry
    return twiml();
  }
});
