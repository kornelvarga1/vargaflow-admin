import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const OUTREACH_TZ = Deno.env.get("OUTREACH_TIMEZONE") ?? "America/New_York";
// Healthchecks.io heartbeat URL — pinged at end of every successful run.
// If healthchecks.io misses pings beyond grace period, it alerts. Optional;
// leave unset to disable monitoring.
const HEALTHCHECKS_URL = Deno.env.get("HEALTHCHECKS_URL");

const MAX_RETRIES = 3;
const OUTREACH_PIPELINE = "Outreach";

// Inlined from _shared/outreach.ts — kept here because this function is deployed
// without a shared-folder bundle. Keep signatures in sync with _shared/outreach.ts.
function isWithinSendWindow(
  settings: { send_window_start: number; send_window_end: number },
  now: Date,
  timeZone: string,
): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone,
    }).format(now),
  );
  return hour >= settings.send_window_start && hour < settings.send_window_end;
}

// Fail-closed: on lookup error, treat as DNC.
async function isDNC(supabase: any, phone: string): Promise<boolean> {
  if (!phone) return false;
  const { data, error } = await supabase
    .from("dnc_list")
    .select("id")
    .eq("phone", phone)
    .maybeSingle();
  if (error) {
    console.error(`[dnc] lookup error for ${phone}:`, error.message);
    return true;
  }
  return !!data;
}

// Cache Twilio numbers per business_id within a single cron run.
// Null business_id (CRM/admin/outreach context) → use the settings row where business_id IS NULL.
const twilioNumberCache: Record<string, string> = {};
const NULL_BIZ_KEY = "__null_business__";

// Cache sequence step counts per cron run so we don't re-query on every send.
const stepCountCache: Record<string, number> = {};

async function getSequenceStepCount(
  supabase: ReturnType<typeof createClient>,
  sequenceId: string,
): Promise<number> {
  if (stepCountCache[sequenceId] !== undefined) return stepCountCache[sequenceId];
  const { count } = await supabase
    .from("sequence_steps")
    .select("*", { count: "exact", head: true })
    .eq("sequence_id", sequenceId);
  stepCountCache[sequenceId] = count ?? 0;
  return count ?? 0;
}

// Increment current_step on the contact_sequences row; mark completed when all steps sent.
async function advanceContactSequence(
  supabase: ReturnType<typeof createClient>,
  contactSequenceId: string,
): Promise<void> {
  const { data } = await supabase
    .from("contact_sequences")
    .select("current_step, sequence_id, status")
    .eq("id", contactSequenceId)
    .maybeSingle();
  const cs = data as { current_step: number | null; sequence_id: string; status: string } | null;
  if (!cs || cs.status !== "active") return;
  const newStep = (cs.current_step ?? 0) + 1;
  const total = await getSequenceStepCount(supabase, cs.sequence_id);
  const updates: Record<string, unknown> = { current_step: newStep };
  if (total > 0 && newStep >= total) updates.status = "completed";
  await supabase.from("contact_sequences").update(updates).eq("id", contactSequenceId);
}

async function getTwilioNumber(
  supabase: ReturnType<typeof createClient>,
  business_id: string | null
): Promise<string | null> {
  const key = business_id ?? NULL_BIZ_KEY;
  if (twilioNumberCache[key]) return twilioNumberCache[key];

  const base = supabase.from("settings").select("twilio_phone_number");
  const { data } = business_id
    ? await base.eq("business_id", business_id).maybeSingle()
    : await base.is("business_id", null).limit(1).maybeSingle();

  const number = (data as any)?.twilio_phone_number ?? null;
  if (number) twilioNumberCache[key] = number;
  return number;
}

// Twilio error codes that indicate a permanently-bad destination number.
// When any of these come back, we immediately mark the message permanently
// failed AND flip contacts.dnd_sms=true so no future send wastes credits.
// 30003 = unreachable handset, 30004 = blocked, 30005 = unknown handset, 30006 = landline/unreachable carrier.
const INVALID_NUMBER_CODES = new Set([30003, 30004, 30005, 30006]);

class TwilioSendError extends Error {
  code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
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
  if (!res.ok) {
    const code = typeof data?.code === "number" ? data.code : null;
    throw new TwilioSendError(`Twilio ${code ?? "?"}: ${data?.message ?? "unknown error"}`, code);
  }
}

async function sendEmail(
  to: string,
  subject: string,
  content: string,
  fromEmail: string,
  contactId: string | null,
  replyTo: string | null = null,
): Promise<void> {
  const unsubUrl = contactId
    ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/unsubscribe?c=${contactId}`
    : null;
  const footer = unsubUrl
    ? `<hr style="margin-top:2rem;border:none;border-top:1px solid #eee" /><p style="color:#888;font-size:0.85em;line-height:1.4">Don't want these emails? <a href="${unsubUrl}" style="color:#888">Unsubscribe</a>.</p>`
    : "";
  const headers: Record<string, string> = unsubUrl
    ? {
        "List-Unsubscribe": `<${unsubUrl}>, <mailto:unsub@vargaflow.com>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : {};

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
      html: content + footer,
      ...(replyTo ? { reply_to: replyTo } : {}),
      headers,
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

    // Load outreach settings (send window + per-hour rate cap). Single-user tool: first row wins.
    let sendWindow = { send_window_start: 9, send_window_end: 19 };
    let ratePerHour = 60;
    try {
      const { data: settingsRow } = await supabase
        .from("settings")
        .select("send_window_start, send_window_end, outbound_rate_per_hour")
        .limit(1)
        .maybeSingle();
      if (settingsRow) {
        sendWindow = {
          send_window_start: settingsRow.send_window_start ?? 9,
          send_window_end: settingsRow.send_window_end ?? 19,
        };
        ratePerHour = settingsRow.outbound_rate_per_hour ?? 60;
      }
    } catch (e) {
      console.warn("[cron] settings fetch failed, using defaults:", e);
    }

    const withinOutreachWindow = isWithinSendWindow(sendWindow, new Date(), OUTREACH_TZ);

    // Count outreach SMS sent in the last hour so we can cap how many more we send this tick.
    let outreachSentLastHour = 0;
    {
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const { count } = await supabase
        .from("message_queue")
        .select("id, contact:contacts!inner(pipeline)", { count: "exact", head: true })
        .eq("message_type", "sms")
        .eq("status", "sent")
        .eq("contact.pipeline", OUTREACH_PIPELINE)
        .gte("sent_at", hourAgo);
      outreachSentLastHour = count ?? 0;
    }
    let outreachBudget = Math.max(0, ratePerHour - outreachSentLastHour);
    console.log(
      `[cron] outreach window=${withinOutreachWindow} sentLastHr=${outreachSentLastHour} budget=${outreachBudget}/${ratePerHour}`,
    );

    // Grab up to 50 pending messages due now, oldest first. Join contacts to know pipeline/angle per row.
    const { data: pendingMessages, error: pendingError } = await supabase
      .from("message_queue")
      .select("*, contact:contacts(pipeline, outreach_angle)")
      .eq("status", "pending")
      .lte("scheduled_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(50);

    if (pendingError) throw new Error(`Queue fetch error: ${pendingError.message}`);

    // Also pick up failed messages eligible for retry (retry_count < MAX_RETRIES, backoff elapsed)
    const { data: retryMessages, error: retryError } = await supabase
      .from("message_queue")
      .select("*, contact:contacts(pipeline, outreach_angle)")
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

      const isOutreach = msg.contact?.pipeline === OUTREACH_PIPELINE;
      const releaseProcessing = (newStatus: string) =>
        supabase.from("message_queue").update({ status: newStatus }).eq("id", msg.id);
      const dropProcessingId = () => {
        const idx = processingIds.indexOf(msg.id);
        if (idx !== -1) processingIds.splice(idx, 1);
      };

      // ── Global dnd_sms check (all SMS, not just outreach) ──
      if ((msg.message_type === "sms" || msg.message_type === "internal_sms") && msg.contact_id) {
        const { data: contactRow } = await supabase
          .from("contacts")
          .select("dnd_sms")
          .eq("id", msg.contact_id)
          .maybeSingle();
        if (contactRow?.dnd_sms) {
          console.log(`[cron] skipping message ${msg.id} — contact ${msg.contact_id} has dnd_sms=true`);
          await releaseProcessing("skipped_dnd");
          dropProcessingId();
          continue;
        }
      }

      // ── Global dnd_email check (mirrors dnd_sms) ──
      if (msg.message_type === "email" && msg.contact_id) {
        const { data: contactRow } = await supabase
          .from("contacts")
          .select("dnd_email")
          .eq("id", msg.contact_id)
          .maybeSingle();
        if (contactRow?.dnd_email) {
          console.log(`[cron] skipping email ${msg.id} — contact ${msg.contact_id} has dnd_email=true`);
          await releaseProcessing("skipped_dnd");
          dropProcessingId();
          continue;
        }
      }

      // Global sequence-status gate — honors pause/stop for ALL message types.
      // Paused: leave pending so it fires after resume. Stopped/cancelled/completed: permanently skip.
      if (msg.contact_sequence_id) {
        const { data: cs } = await supabase
          .from("contact_sequences")
          .select("status")
          .eq("id", msg.contact_sequence_id)
          .maybeSingle();
        if (cs) {
          if (cs.status === "paused") {
            await releaseProcessing("pending");
            dropProcessingId();
            continue;
          }
          if (cs.status !== "active") {
            await releaseProcessing("skipped_stopped");
            dropProcessingId();
            continue;
          }
        }
      }

      // Outreach-only guardrails (SMS). CRM flows bypass these entirely.
      if (isOutreach && (msg.message_type === "sms" || msg.message_type === "internal_sms")) {
        // 1. Send window — leave pending so it retries on a later tick inside the window.
        if (!withinOutreachWindow) {
          await releaseProcessing("pending");
          dropProcessingId();
          continue;
        }
        // 2. Per-hour rate cap — leave pending; next tick will reassess budget.
        if (outreachBudget <= 0) {
          await releaseProcessing("pending");
          dropProcessingId();
          continue;
        }
        // 3. DNC suppression (fail-closed).
        const toCheck = msg.to_phone ?? msg.metadata?.to;
        if (toCheck && (await isDNC(supabase, toCheck))) {
          await releaseProcessing("skipped_dnc");
          dropProcessingId();
          continue;
        }
      }

      try {
        if (msg.message_type === "sms" || msg.message_type === "internal_sms") {
          // SMS: to_phone first, fall back to metadata.to
          const to = msg.to_phone ?? msg.metadata?.to;
          if (!to) throw new Error(`No phone number for message ${msg.id}`);

          const fromNumber = await getTwilioNumber(supabase, msg.business_id ?? null);

          const from = fromNumber ?? Deno.env.get("TWILIO_PHONE_NUMBER");
          if (!from) throw new Error(`No Twilio from-number for business ${msg.business_id}`);

          await sendSMS(to, from, msg.message_content);

          if (isOutreach) outreachBudget--;

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
          const replyTo = msg.metadata?.reply_to ?? null;
          if (!to) throw new Error(`No email address for message ${msg.id}`);

          await sendEmail(to, subject, msg.message_content, fromEmail, msg.contact_id, replyTo);

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

        // Advance contact_sequence progress (increment current_step, mark completed when done).
        if (msg.contact_sequence_id) {
          try {
            await advanceContactSequence(supabase, msg.contact_sequence_id);
          } catch (advErr) {
            console.error(`advanceContactSequence failed for ${msg.contact_sequence_id}:`, advErr);
          }
        }

        // Remove from processing tracker on success
        const idx = processingIds.indexOf(msg.id);
        if (idx !== -1) processingIds.splice(idx, 1);
        sent++;

      } catch (msgErr) {
        failed++;
        const retryCount = (msg.metadata?.retry_count ?? 0) + 1;

        // Detect Twilio "this number is permanently bad" errors — no point retrying.
        // Flip the contact's dnd_sms so future outbound messages don't waste credits either.
        const twilioCode = msgErr instanceof TwilioSendError ? msgErr.code : null;
        const isInvalidNumber = twilioCode !== null && INVALID_NUMBER_CODES.has(twilioCode);

        if (isInvalidNumber && msg.contact_id) {
          try {
            await supabase.from("contacts").update({ dnd_sms: true }).eq("id", msg.contact_id);
            console.log(`[cron] contact ${msg.contact_id} flagged dnd_sms=true after Twilio ${twilioCode}`);
          } catch (dndErr) {
            console.error(`[cron] failed to flip dnd_sms for ${msg.contact_id}:`, dndErr);
          }
        }

        const isPermanentFailure = isInvalidNumber || retryCount >= MAX_RETRIES;

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
              ...(twilioCode !== null ? { twilio_error_code: twilioCode } : {}),
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

    // Heartbeat ping — healthchecks.io tracks "cron actually ran" (not just "endpoint up").
    // Fire-and-forget: a failed heartbeat must not turn a successful cron run into a 500.
    if (HEALTHCHECKS_URL) {
      try {
        await fetch(HEALTHCHECKS_URL, { method: "GET" });
      } catch (hcErr) {
        console.error("[healthcheck] ping failed:", hcErr);
      }
    }

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
