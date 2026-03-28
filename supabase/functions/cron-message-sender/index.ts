import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;

const MAX_RETRIES = 3;

// Cache Twilio numbers per business_id within a single cron run
const twilioNumberCache: Record<string, string> = {};

async function getTwilioNumber(
  supabase: ReturnType<typeof createClient>,
  business_id: string
): Promise<string | null> {
  if (twilioNumberCache[business_id]) return twilioNumberCache[business_id];

  const { data } = await supabase
    .from("settings")
    .select("twilio_phone_number")
    .eq("business_id", business_id)
    .single();

  const number = data?.twilio_phone_number ?? null;
  if (number) twilioNumberCache[business_id] = number;
  return number;
}

async function sendSMS(
  to: string,
  from: string,
  body: string
): Promise<void> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_SID}:${TWILIO_AUTH}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio error: ${data.message}`);
}

async function sendEmail(
  to: string,
  subject: string,
  content: string,
  fromEmail: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to,
      subject,
      html: content,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${data.message}`);
}

async function invokeFunctionCall(
  functionName: string,
  payload: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/${functionName}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Function ${functionName} failed: ${text}`);
  }
}

function getRetryDelay(retryCount: number): number {
  // Exponential backoff: 1min, 4min, 16min
  return Math.pow(4, retryCount) * 60 * 1000;
}

serve(async (_req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  // Track IDs marked "processing" so we can reset them on fatal error
  const processingIds: string[] = [];

  try {
    const now = new Date().toISOString();

    // Grab up to 50 pending messages due now, oldest first
    const { data: pendingMessages, error: pendingError } = await supabase
      .from("message_queue")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(50);

    if (pendingError) throw new Error(`Queue fetch error: ${pendingError.message}`);

    // Also pick up failed messages eligible for retry (retry_count < MAX_RETRIES, backoff elapsed)
    const { data: retryMessages, error: retryError } = await supabase
      .from("message_queue")
      .select("*")
      .eq("status", "failed")
      .lt("metadata->>retry_count", MAX_RETRIES)
      .lte("metadata->>retry_after", now)
      .order("scheduled_at", { ascending: true })
      .limit(10);

    if (retryError) throw new Error(`Retry fetch error: ${retryError.message}`);

    const messages = [...(pendingMessages ?? []), ...(retryMessages ?? [])];

    // Note: do NOT early-return here — push notification section must always run

    let sent = 0;
    let failed = 0;

    for (const msg of messages) {
      const previousStatus = msg.status; // "pending" or "failed" (retry)

      // Mark as processing — check that the row is still in its expected status
      const { data: claimResult } = await supabase
        .from("message_queue")
        .update({ status: "processing" })
        .eq("id", msg.id)
        .eq("status", previousStatus)
        .select("id");

      // If 0 rows matched, another instance already claimed this message — skip
      if (!claimResult || claimResult.length === 0) continue;

      processingIds.push(msg.id);

      try {
        if (msg.message_type === "sms" || msg.message_type === "internal_sms") {
          // SMS: to_phone first, fall back to metadata.to
          const to = msg.to_phone ?? msg.metadata?.to;
          if (!to) throw new Error(`No phone number for message ${msg.id}`);

          const fromNumber = msg.business_id
            ? await getTwilioNumber(supabase, msg.business_id)
            : null;

          const from = fromNumber ?? Deno.env.get("TWILIO_PHONE_NUMBER");
          if (!from) throw new Error(`No Twilio from-number for business ${msg.business_id}`);

          await sendSMS(to, from, msg.message_content);

          await supabase
            .from("message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", msg.id);

          // Log to activity_log — outside the success path so failure here
          // does NOT roll back the message status to "failed"
          try {
            if (msg.contact_id) {
              await supabase.from("activity_log").insert({
                contact_id: msg.contact_id,
                business_id: msg.business_id,
                activity_type: "message_sent",
                description: `SMS sent: "${msg.message_content.slice(0, 60)}${msg.message_content.length > 60 ? "…" : ""}"`,
              });
            }
          } catch (logErr) {
            console.error(`Activity log failed for SMS message ${msg.id}:`, logErr);
          }

        } else if (msg.message_type === "email") {
          // Email: metadata.to first, fall back to to_phone
          const to = msg.metadata?.to ?? msg.to_phone;
          const subject = msg.metadata?.subject ?? "Message from your contractor";
          const fromEmail = msg.metadata?.from_email ?? "VargaFlow <hello@vargaflow.com>";
          if (!to) throw new Error(`No email address for message ${msg.id}`);

          await sendEmail(to, subject, msg.message_content, fromEmail);

          await supabase
            .from("message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", msg.id);

          // Log to activity_log for emails too
          try {
            if (msg.contact_id) {
              await supabase.from("activity_log").insert({
                contact_id: msg.contact_id,
                business_id: msg.business_id,
                activity_type: "message_sent",
                description: `Email sent: "${(msg.metadata?.subject ?? "Message from your contractor").slice(0, 60)}"`,
              });
            }
          } catch (logErr) {
            console.error(`Activity log failed for email message ${msg.id}:`, logErr);
          }

        } else if (msg.message_type === "function_call") {
          const functionName = msg.metadata?.function_name;
          const payload = msg.metadata?.payload ?? {};

          if (!functionName) throw new Error(`No function_name in metadata for message ${msg.id}`);

          await invokeFunctionCall(functionName, payload);

          await supabase
            .from("message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", msg.id);

          // Log to activity_log for function calls
          try {
            if (msg.contact_id) {
              await supabase.from("activity_log").insert({
                contact_id: msg.contact_id,
                business_id: msg.business_id,
                activity_type: "automation_triggered",
                description: `Function invoked: ${functionName}`,
              });
            }
          } catch (logErr) {
            console.error(`Activity log failed for function_call message ${msg.id}:`, logErr);
          }

          console.log(`Invoked function: ${functionName} for contact ${msg.contact_id}`);

        } else {
          throw new Error(`Unknown message_type: ${msg.message_type}`);
        }

        // Remove from processing tracker on success
        const idx = processingIds.indexOf(msg.id);
        if (idx !== -1) processingIds.splice(idx, 1);
        sent++;

      } catch (msgErr) {
        failed++;
        const retryCount = (msg.metadata?.retry_count ?? 0) + 1;
        const isPermanentFailure = retryCount >= MAX_RETRIES;

        const retryAfter = isPermanentFailure
          ? undefined
          : new Date(Date.now() + getRetryDelay(retryCount)).toISOString();

        await supabase
          .from("message_queue")
          .update({
            status: "failed",
            metadata: {
              ...(msg.metadata ?? {}),
              error: msgErr instanceof Error ? msgErr.message : String(msgErr),
              failed_at: new Date().toISOString(),
              retry_count: retryCount,
              ...(retryAfter ? { retry_after: retryAfter } : {}),
              ...(isPermanentFailure ? { permanently_failed: true } : {}),
            },
          })
          .eq("id", msg.id);

        // Remove from processing tracker — it's now "failed"
        const idx = processingIds.indexOf(msg.id);
        if (idx !== -1) processingIds.splice(idx, 1);

        console.error(`Failed message ${msg.id} (${msg.message_type}, attempt ${retryCount}/${MAX_RETRIES}):`, msgErr);
      }
    }

    console.log(`Cron run: ${sent} sent, ${failed} failed out of ${messages.length} total`);

    // ── Inbound SMS push notifications ──────────────────────────────────────
    console.log("[push] scanning for unnotified inbound messages...");

    const { data: inbound, error: inboundErr } = await supabase
      .from("message_queue")
      .select("id, business_id, message_content, metadata")
      .eq("direction", "inbound")
      .eq("push_notified", false)
      .order("created_at", { ascending: true })
      .limit(20);

    if (inboundErr) {
      console.error("[push] inbound query error:", inboundErr.message, inboundErr.details, inboundErr.hint);
    } else {
      console.log(`[push] inbound rows found: ${inbound?.length ?? 0}`);
    }

    if (inbound && inbound.length > 0) {
      // Group by business_id — one push per business per cron tick (most recent)
      const byBusiness = new Map<string, typeof inbound[0]>();
      for (const row of inbound) {
        if (row.business_id) byBusiness.set(row.business_id, row);
        else console.log("[push] row missing business_id, skipping:", row.id);
      }

      console.log(`[push] businesses to notify: ${[...byBusiness.keys()].join(", ")}`);

      for (const [bizId, row] of byBusiness) {
        console.log(`[push] calling send-push-notification for business ${bizId}, message_id: ${row.id}`);
        try {
          const url = `${SUPABASE_URL}/functions/v1/send-push-notification`;
          const res = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              business_id: bizId,
              title: "New reply",
              body: row.message_content?.slice(0, 120) ?? "A lead replied to your message.",
            }),
          });
          const responseText = await res.text();
          console.log(`[push] send-push-notification response: status=${res.status} body=${responseText}`);
          if (!res.ok) {
            console.error(`[push] send-push-notification non-200 for business ${bizId}: ${res.status} ${responseText}`);
          }
        } catch (pushErr) {
          console.error(`[push] fetch error for business ${bizId}:`, pushErr instanceof Error ? pushErr.message : pushErr);
        }
      }

      // Mark all fetched inbound rows as notified regardless of per-business outcome
      const ids = inbound.map((r) => r.id);
      console.log(`[push] marking ${ids.length} rows as push_notified=true: ${ids.join(", ")}`);
      const { error: markErr } = await supabase
        .from("message_queue")
        .update({ push_notified: true })
        .in("id", ids);
      if (markErr) {
        console.error("[push] failed to mark rows notified:", markErr.message);
      } else {
        console.log("[push] rows marked push_notified=true successfully");
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    return new Response(
      JSON.stringify({ sent, failed, total: messages.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Cron fatal error:", err);

    // Reset any messages stuck in "processing" back to "pending"
    if (processingIds.length > 0) {
      try {
        await supabase
          .from("message_queue")
          .update({ status: "pending" })
          .in("id", processingIds);
        console.log(`Reset ${processingIds.length} processing messages back to pending`);
      } catch (resetErr) {
        console.error("Failed to reset processing messages:", resetErr);
      }
    }

    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
