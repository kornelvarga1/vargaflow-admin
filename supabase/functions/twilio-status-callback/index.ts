import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateTwilioSignature } from "../_shared/utils.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;

// Matches INVALID_NUMBER_CODES in cron-message-sender — codes that mean the
// destination number is permanently unreachable. Async delivery failures with
// these codes trigger the same cleanup that a synchronous throw would have.
const INVALID_NUMBER_CODES = new Set(["30003", "30004", "30005", "30006"]);

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.text();
  const params = Object.fromEntries(new URLSearchParams(body));

  // Reconstruct the public URL exactly as Twilio signed it.
  const url = `https://${new URL(req.url).host}/functions/v1/twilio-status-callback`;
  const signature = req.headers.get("x-twilio-signature") ?? null;

  const valid = await validateTwilioSignature(TWILIO_AUTH_TOKEN, signature, url, params);
  if (!valid) {
    console.error("[status-callback] invalid Twilio signature — rejecting");
    return new Response("Forbidden", { status: 403 });
  }

  const { MessageStatus, ErrorCode, To } = params;

  console.log(`[status-callback] To=${To} status=${MessageStatus} error=${ErrorCode ?? "none"}`);

  // Only act on permanent delivery failures from bad destination numbers.
  // Transient failures (30001 queuing timeout, 30002 unknown error, etc.) are
  // left alone — the cron retry logic handles those.
  if (
    (MessageStatus !== "undelivered" && MessageStatus !== "failed") ||
    !INVALID_NUMBER_CODES.has(ErrorCode)
  ) {
    return new Response("ok", { status: 200 });
  }

  if (!To) {
    console.error("[status-callback] missing To field, cannot clean up");
    return new Response("ok", { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Look up contact(s) by phone number.
  const { data: contacts, error: contactErr } = await supabase
    .from("contacts")
    .select("id, full_name")
    .eq("phone", To);

  if (contactErr) {
    console.error(`[status-callback] contact lookup error for ${To}:`, contactErr.message);
    return new Response("ok", { status: 200 });
  }

  if (!contacts || contacts.length === 0) {
    console.log(`[status-callback] no contact found for ${To} — nothing to clean up`);
    return new Response("ok", { status: 200 });
  }

  const contactIds = contacts.map((c) => c.id);
  const names = contacts.map((c) => c.full_name).join(", ");

  // Flag as do-not-SMS so no future message ever attempts this number.
  const { error: dndErr } = await supabase
    .from("contacts")
    .update({ dnd_sms: true })
    .in("id", contactIds);

  if (dndErr) {
    console.error(`[status-callback] dnd_sms update failed for ${To}:`, dndErr.message);
  } else {
    console.log(`[status-callback] dnd_sms=true set for ${names} (${To}), error_code=${ErrorCode}`);
  }

  // Cancel any messages still waiting in the queue for this contact.
  const { data: cancelled, error: cancelErr } = await supabase
    .from("message_queue")
    .update({ status: "skipped_dnd" })
    .in("contact_id", contactIds)
    .eq("status", "pending")
    .select("id");

  if (cancelErr) {
    console.error(`[status-callback] queue cancel failed for ${To}:`, cancelErr.message);
  } else if (cancelled && cancelled.length > 0) {
    console.log(`[status-callback] cancelled ${cancelled.length} pending messages for ${To}`);
  }

  // Flip already-sent messages to "failed" so the dashboard doesn't count
  // this contact as "contacted". The number is permanently bad so every send
  // to it was wasted regardless of when it was sent.
  const { data: flippedRows, error: flipErr } = await supabase
    .from("message_queue")
    .update({ status: "failed" })
    .in("contact_id", contactIds)
    .eq("status", "sent")
    .select("id");

  if (flipErr) {
    console.error(`[status-callback] sent→failed flip error for ${To}:`, flipErr.message);
  } else if (flippedRows && flippedRows.length > 0) {
    console.log(`[status-callback] marked ${flippedRows.length} sent messages as failed for ${To} (error_code=${ErrorCode})`);
  }

  return new Response("ok", { status: 200 });
});
