import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizePhone, notifyAdmin } from "../_shared/utils.ts";

// Stable per project_ai_receptionist_pivot memory — Retell locks/recreates the
// LLM+agent pair on prompt edits, but the two demo phone numbers stay fixed.
const DEMO_NUMBER_LABELS: Record<string, string> = {
  "+12132385364": "Ryan / Summit Roofing (roofing-estimate demo)",
  "+16562460255": "Jake / Ironclad Plumbing (emergency demo)",
};

// Below this, treat the call as a misdial/immediate-hangup, not real engagement.
const FOLLOWUP_MIN_DURATION_SEC = 15;
// Delay before the "how was it" text goes out — this is the fast-response
// mechanism (Kornél mostly can't beat it manually, day job + sleep), so it's
// short. Just enough of a gap that it doesn't read as a bot watching the call
// in real time, matching the personal-founder tone the rest of the copy uses.
const FOLLOWUP_DELAY_MINUTES = 3;

// Retell agent-level webhook (call_started / call_ended / call_analyzed) —
// configured once per demo agent via `retell agent update <agent_id>
// --webhook-url`. Logs every call to the shared voice-demo numbers (Jake/
// plumbing, Ryan/roofing) into voice_demo_calls, so a prospect who calls the
// demo but never replies to the cold SMS still shows up as an interest
// signal — matched back to a contacts row by phone number when possible.
//
// call_started has only call_id/agent_id/from_number/to_number/start_timestamp.
// call_ended adds end_timestamp/transcript/recording_url/disconnection_reason.
// call_analyzed adds call_analysis (summary/sentiment/success) on top of that.
// Each event upserts by call_id, merging onto whatever's already stored so an
// earlier event's fields are never clobbered back to null by a later one.
//
// See: https://docs.retellai.com/features/secure-webhook

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retell-signature",
};

async function verifySignature(rawBody: string, signatureHeader: string | null, apiKey: string): Promise<boolean> {
  if (!signatureHeader) return false;
  const match = signatureHeader.match(/^v=(\d+),d=(.+)$/);
  if (!match) return false;
  const [, timestamp, digest] = match;

  const fiveMinutesMs = 5 * 60 * 1000;
  if (Math.abs(Date.now() - Number(timestamp)) > fiveMinutesMs) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody + timestamp),
  );
  const expected = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== digest.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ digest.charCodeAt(i);
  return diff === 0;
}

function toIso(ms: number | undefined | null): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const rawBody = await req.text();
  const apiKey = Deno.env.get("RETELL_API_KEY")!;
  const signatureHeader = req.headers.get("x-retell-signature");

  if (!(await verifySignature(rawBody, signatureHeader, apiKey))) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = JSON.parse(rawBody);
  const call = body.call;
  if (!call?.call_id) {
    // e.g. an event type we don't care about — no-op.
    return new Response(JSON.stringify({}), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: existing } = await supabase
    .from("voice_demo_calls")
    .select("*")
    .eq("call_id", call.call_id)
    .maybeSingle();

  const fromNumberNormalized = normalizePhone(call.from_number) ?? existing?.from_number_normalized ?? null;

  let matchedContactId = existing?.matched_contact_id ?? null;
  if (!matchedContactId && fromNumberNormalized) {
    // Cold-outreach leads live under business_id IS NULL — see ADMIN_BUSINESS_ID
    // note in _shared/utils.ts.
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .is("business_id", null)
      .eq("phone", fromNumberNormalized)
      .maybeSingle();
    matchedContactId = contact?.id ?? null;
  }

  let businessId = existing?.business_id ?? null;
  if (!businessId && call.agent_id) {
    const { data: voiceAgent } = await supabase
      .from("voice_agents")
      .select("business_id")
      .eq("retell_agent_id", call.agent_id)
      .maybeSingle();
    businessId = voiceAgent?.business_id ?? null;
  }

  const row = {
    call_id: call.call_id,
    agent_id: call.agent_id ?? existing?.agent_id ?? null,
    to_number: call.to_number ?? existing?.to_number ?? null,
    from_number: call.from_number ?? existing?.from_number ?? null,
    from_number_normalized: fromNumberNormalized,
    business_id: businessId,
    matched_contact_id: matchedContactId,
    call_status: call.call_status ?? existing?.call_status ?? null,
    start_timestamp: toIso(call.start_timestamp) ?? existing?.start_timestamp ?? null,
    end_timestamp: toIso(call.end_timestamp) ?? existing?.end_timestamp ?? null,
    duration_ms: call.start_timestamp && call.end_timestamp
      ? call.end_timestamp - call.start_timestamp
      : existing?.duration_ms ?? null,
    disconnection_reason: call.disconnection_reason ?? existing?.disconnection_reason ?? null,
    transcript: call.transcript ?? existing?.transcript ?? null,
    recording_url: call.recording_url ?? existing?.recording_url ?? null,
    call_summary: call.call_analysis?.call_summary ?? existing?.call_summary ?? null,
    user_sentiment: call.call_analysis?.user_sentiment ?? existing?.user_sentiment ?? null,
    call_successful: call.call_analysis?.call_successful ?? existing?.call_successful ?? null,
    raw_event: body,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("voice_demo_calls").upsert(row, { onConflict: "call_id" });
  if (error) {
    console.error("[voice-call-webhook] upsert error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Fire the Telegram ping on call_ended specifically — earliest event where
  // duration and from_number are both known, so the notification lands as
  // soon as possible rather than waiting on call_analyzed.
  if (body.event === "call_ended") {
    const durationSec = row.duration_ms != null ? Math.round(row.duration_ms / 1000) : null;
    const durationLabel = durationSec != null
      ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, "0")}`
      : "unknown";
    const demoLabel = (row.to_number && DEMO_NUMBER_LABELS[row.to_number]) ?? row.to_number ?? "unknown demo number";

    let contactLabel = row.from_number ?? "unknown number";
    if (row.matched_contact_id) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("full_name")
        .eq("id", row.matched_contact_id)
        .maybeSingle();
      contactLabel += contact?.full_name ? ` (${contact.full_name})` : "";
    } else {
      contactLabel += " (no match in outreach list)";
    }

    await notifyAdmin(
      `📞 New demo call — ${demoLabel}\nFrom: ${contactLabel}\nDuration: ${durationLabel}` +
      (row.disconnection_reason ? `\nEnded: ${row.disconnection_reason}` : ""),
    );

    // Auto follow-up SMS for silent callers — someone who called the demo and
    // never texted back has no reason to re-engage on their own. Only for
    // real engagement (duration threshold), only for known outreach contacts
    // (need a number we're allowed to text), only if they haven't already
    // engaged by SMS (don't step on an active conversation/warm sequence),
    // and only once per contact (in case they call again).
    if (
      row.matched_contact_id &&
      durationSec != null &&
      durationSec >= FOLLOWUP_MIN_DURATION_SEC
    ) {
      const { data: alreadyEngaged } = await supabase
        .from("message_queue")
        .select("id")
        .eq("contact_id", row.matched_contact_id)
        .or("direction.eq.inbound,metadata->>source.eq.call_followup")
        .limit(1)
        .maybeSingle();

      if (!alreadyEngaged) {
        const { error: followupError } = await supabase.from("message_queue").insert({
          contact_id: row.matched_contact_id,
          business_id: null,
          to_phone: row.from_number_normalized,
          message_type: "sms",
          message_content:
            "Hey, noticed you called and tried out the AI receptionist demo, curious what you thought, liked it or nah?",
          status: "pending",
          scheduled_at: new Date(Date.now() + FOLLOWUP_DELAY_MINUTES * 60 * 1000).toISOString(),
          metadata: { source: "call_followup", call_id: call.call_id },
        });
        if (followupError) {
          console.error("[voice-call-webhook] follow-up queue insert error:", followupError.message);
        }
      }
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
