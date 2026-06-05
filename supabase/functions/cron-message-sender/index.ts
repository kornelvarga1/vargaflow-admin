import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
// Fallback only — settings.outreach_timezone wins when present.
const OUTREACH_TZ_FALLBACK = Deno.env.get("OUTREACH_TIMEZONE") ?? "America/New_York";
// Healthchecks.io heartbeat URL — pinged at end of every successful run.
// If healthchecks.io misses pings beyond grace period, it alerts. Optional;
// leave unset to disable monitoring.
const HEALTHCHECKS_URL = Deno.env.get("HEALTHCHECKS_URL");

const MAX_RETRIES = 3;
const OUTREACH_PIPELINE = "Outreach";
// Receives async delivery-status updates from Twilio. When a message fails
// with an invalid-number code (30003–30006), the callback sets dnd_sms=true
// and cancels pending follow-ups — closing the gap where sendSMS returns 200
// but Twilio reports undelivered asynchronously.
const STATUS_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/twilio-status-callback`;
// Admin's business_id — used as fallback when a contact/message has business_id=NULL.
// Never pick "any" settings row by accident — that could land on a test client.
const ADMIN_BUSINESS_ID = "79036fbb-997c-4f7b-b46f-ccc97a64c38d";

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

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function isAllowedDay(
  allowedDays: number[] | null | undefined,
  now: Date,
  timeZone: string,
): boolean {
  if (!allowedDays || allowedDays.length === 0) return false;
  const weekdayShort = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone,
  }).format(now);
  const day = WEEKDAY_INDEX[weekdayShort];
  return day !== undefined && allowedDays.includes(day);
}

function dateAtHourInTz(now: Date, hour: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const datePart = `${get("year")}-${get("month")}-${get("day")}`;
  const naive = new Date(`${datePart}T${String(hour).padStart(2, "0")}:00:00Z`);
  const seenHour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(naive),
  );
  let delta = seenHour - hour;
  if (delta > 12) delta -= 24;
  if (delta < -12) delta += 24;
  return new Date(naive.getTime() - delta * 3600_000);
}

function startOfDayInTz(now: Date, timeZone: string): Date {
  return dateAtHourInTz(now, 0, timeZone);
}

// Return the next time the send window opens at windowStartHour in timeZone,
// starting from `from`. If today's window open is still in the future, return
// that; otherwise return tomorrow's window open.
function nextWindowOpen(from: Date, windowStartHour: number, timeZone: string): Date {
  const todayOpen = dateAtHourInTz(from, windowStartHour, timeZone);
  if (todayOpen > from) return todayOpen;
  const nextDay = new Date(from.getTime() + 24 * 3600_000);
  return dateAtHourInTz(nextDay, windowStartHour, timeZone);
}

interface PacingConfig {
  dailyCap: number;
  windowSeconds: number;
  hourlyThrottle: number | null;
}
interface PacingState {
  sentToday: number;
  sentLastHour: number;
  secondsSinceLastSendToday: number | null;
}
interface PacingDecision {
  allowed: 0 | 1;
  reason: string;
  paceIntervalSeconds: number;
}

// Inlined from _shared/utils.ts resolveTemplate. Keep in sync.
function resolveTemplate(
  template: string,
  contact: Record<string, any>,
  settings: Record<string, any>,
): string {
  const vars: Record<string, string> = {
    contact_first_name: contact?.full_name?.split(" ")[0] ?? "",
    contact_name: contact?.full_name ?? "",
    contact_phone: contact?.phone ?? "",
    contact_email: contact?.email ?? "",
    contact_company: settings?.company_name ?? "",
    my_name: settings?.my_name ?? "",
    my_phone: settings?.my_phone ?? "",
    my_email: settings?.my_email ?? "",
    company_name: settings?.company_name ?? "",
    website_url: settings?.website_url ?? "",
    software_explanation_video: settings?.software_explanation_video ?? "",
    testimonials_link: settings?.testimonials_link ?? "",
    case_study_link: settings?.case_study_link ?? "",
    demo_calendar_link: settings?.demo_calendar_link ?? "",
    launch_call_calendar_link: settings?.launch_call_calendar_link ?? "",
    onboarding_form_link: settings?.onboarding_form_link ?? "",
    instagram_url: settings?.instagram_url ?? "",
    gmb_tutorial_link: settings?.gmb_tutorial_link ?? "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function computeOutreachBudget(cfg: PacingConfig, st: PacingState): PacingDecision {
  const paceIntervalSeconds =
    cfg.dailyCap > 0 ? Math.max(1, Math.floor(cfg.windowSeconds / cfg.dailyCap)) : 0;
  if (cfg.dailyCap <= 0) return { allowed: 0, reason: "daily_cap_zero", paceIntervalSeconds };
  if (st.sentToday >= cfg.dailyCap) return { allowed: 0, reason: "daily_cap_hit", paceIntervalSeconds };
  if (st.secondsSinceLastSendToday !== null && st.secondsSinceLastSendToday < paceIntervalSeconds) {
    return {
      allowed: 0,
      reason: `pacing(${st.secondsSinceLastSendToday}s<${paceIntervalSeconds}s)`,
      paceIntervalSeconds,
    };
  }
  if (cfg.hourlyThrottle !== null && cfg.hourlyThrottle > 0 && st.sentLastHour >= cfg.hourlyThrottle) {
    return { allowed: 0, reason: "hourly_throttle_hit", paceIntervalSeconds };
  }
  return { allowed: 1, reason: "ok", paceIntervalSeconds };
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

// Cache settings rows by business_id within a single cron run (used by template
// resolution when queueing the next sequence step after a successful send).
const settingsCache: Record<string, Record<string, unknown>> = {};

async function getSettingsCached(
  supabase: ReturnType<typeof createClient>,
  businessId: string | null,
): Promise<Record<string, unknown>> {
  const lookupBid = businessId ?? ADMIN_BUSINESS_ID;
  if (settingsCache[lookupBid]) return settingsCache[lookupBid];
  const { data } = await supabase
    .from("settings")
    .select("*")
    .eq("business_id", lookupBid)
    .maybeSingle();
  settingsCache[lookupBid] = (data as Record<string, unknown>) ?? {};
  return settingsCache[lookupBid];
}

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

// Queue the next step in this contact's sequence (if any).
// For regular sequences: schedules relative to this step's actual send time.
// For anchor_timing sequences: schedules as (started_at + cumulative_delay),
// so follow-ups always land at the same clock-time as the initial trigger
// regardless of when earlier steps actually sent. Also enforces the send window
// for anchor sequences (defers outside-window times to next 9am).
async function queueNextStep(
  supabase: ReturnType<typeof createClient>,
  msg: any,
): Promise<void> {
  if (!msg.contact_sequence_id) return;
  const justSentOrder = Number(msg.metadata?.step_order ?? 0);
  if (justSentOrder <= 0) return;

  const { data: cs } = await supabase
    .from("contact_sequences")
    .select("sequence_id, status, started_at")
    .eq("id", msg.contact_sequence_id)
    .maybeSingle();
  const seqRow = cs as { sequence_id: string; status: string; started_at: string | null } | null;
  if (!seqRow || seqRow.status !== "active") return;

  // Fetch anchor_timing flag from the sequence.
  const { data: seqMeta } = await supabase
    .from("sequences")
    .select("anchor_timing")
    .eq("id", seqRow.sequence_id)
    .maybeSingle();
  const anchorTiming: boolean = (seqMeta as any)?.anchor_timing ?? false;

  // Look up the next step + the just-sent step in one go so we can compute the
  // gap-from-previous (sequence_steps stores delays as cumulative-from-enrollment).
  const { data: stepsData } = await supabase
    .from("sequence_steps")
    .select("step_order, delay_hours, delay_minutes, message_type, message_template")
    .eq("sequence_id", seqRow.sequence_id)
    .in("step_order", [justSentOrder, justSentOrder + 1]);
  const steps = (stepsData ?? []) as Array<{
    step_order: number;
    delay_hours: number | null;
    delay_minutes: number | null;
    message_type: string;
    message_template: string;
  }>;
  const current = steps.find((s) => s.step_order === justSentOrder);
  const next = steps.find((s) => s.step_order === justSentOrder + 1);
  if (!next) return; // sequence done

  const currentTotalMin = (current?.delay_hours ?? 0) * 60 + (current?.delay_minutes ?? 0);
  const nextTotalMin = (next.delay_hours ?? 0) * 60 + (next.delay_minutes ?? 0);

  // Fetch settings once — needed for both template resolution and anchor window checks.
  const settings = await getSettingsCached(supabase, msg.business_id ?? null);

  let sendAt: Date;
  if (anchorTiming && seqRow.started_at) {
    // Anchor all steps to the sequence's enrollment start time so follow-ups
    // always land at the same clock-time as the initial trigger.
    const startedAtMs = new Date(seqRow.started_at).getTime();
    const calculatedMs = startedAtMs + nextTotalMin * 60_000;
    // If in the past (e.g. sequence was paused), send ASAP.
    sendAt = new Date(Math.max(calculatedMs, Date.now() + 5_000));
    // Enforce send window: defer to next window-open (default 9am) if outside.
    const tz = (settings.outreach_timezone as string) ?? OUTREACH_TZ_FALLBACK;
    const windowStart = (settings.send_window_start as number) ?? 9;
    const windowEnd = (settings.send_window_end as number) ?? 19;
    if (!isWithinSendWindow({ send_window_start: windowStart, send_window_end: windowEnd }, sendAt, tz)) {
      sendAt = nextWindowOpen(sendAt, windowStart, tz);
    }
  } else {
    const deltaMin = Math.max(0, nextTotalMin - currentTotalMin);
    sendAt = new Date(Date.now() + deltaMin * 60_000);
  }

  // Fetch fresh contact for template resolution (msg.contact is a partial join).
  const { data: contactRow } = await supabase
    .from("contacts")
    .select("full_name, phone, email")
    .eq("id", msg.contact_id)
    .maybeSingle();
  const resolved = resolveTemplate(next.message_template, contactRow ?? {}, settings);

  const { error: insErr } = await supabase.from("message_queue").insert({
    contact_id: msg.contact_id,
    contact_sequence_id: msg.contact_sequence_id,
    business_id: msg.business_id,
    message_type: next.message_type,
    message_content: resolved,
    to_phone: msg.to_phone,
    scheduled_at: sendAt.toISOString(),
    status: "pending",
    metadata: { to: msg.to_phone, step_order: justSentOrder + 1 },
  });
  if (insErr) {
    console.error(
      `[cron] queueNextStep insert FAILED for contact ${msg.contact_id} step ${justSentOrder + 1}: ${insErr.message}`,
    );
  } else {
    console.log(
      `[cron] queued step ${justSentOrder + 1} for contact ${msg.contact_id} at ${sendAt.toISOString()}`,
    );
  }
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
  // NULL business_id (admin convention) routes to ADMIN_BUSINESS_ID's Twilio
  // number — never fall through to "any settings row" since that risks sending
  // from a test client's number.
  const lookupBid = business_id ?? ADMIN_BUSINESS_ID;
  if (twilioNumberCache[lookupBid]) return twilioNumberCache[lookupBid];
  const { data } = await supabase
    .from("settings")
    .select("twilio_phone_number")
    .eq("business_id", lookupBid)
    .maybeSingle();
  const number = (data as any)?.twilio_phone_number ?? null;
  if (number) twilioNumberCache[lookupBid] = number;
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
      body: new URLSearchParams({ To: to, From: from, Body: body, StatusCallback: STATUS_CALLBACK_URL }),
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

async function sendTelegram(text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(`Telegram error: ${data.description ?? res.statusText}`);
  }
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

    // Load outreach pacing config. Single-user tool: first row wins.
    let sendWindow = { send_window_start: 9, send_window_end: 19 };
    let dailyCap = 20;
    let allowedDays: number[] = [1, 2, 3, 4, 5];
    let outreachTz = OUTREACH_TZ_FALLBACK;
    let hourlyThrottle: number | null = null;
    try {
      // CRITICAL: target ADMIN_BUSINESS_ID specifically. Without this filter, .limit(1)
      // would race between rows (e.g. test client "Mike" with window 9-19 instead of
      // admin's 10-13), bypassing the operator's configured send window entirely.
      const { data: settingsRow } = await supabase
        .from("settings")
        .select(
          "send_window_start, send_window_end, daily_send_cap, send_days_of_week, outreach_timezone, hourly_throttle",
        )
        .eq("business_id", ADMIN_BUSINESS_ID)
        .maybeSingle();
      if (settingsRow) {
        sendWindow = {
          send_window_start: settingsRow.send_window_start ?? 9,
          send_window_end: settingsRow.send_window_end ?? 19,
        };
        dailyCap = settingsRow.daily_send_cap ?? 20;
        allowedDays = settingsRow.send_days_of_week ?? [1, 2, 3, 4, 5];
        outreachTz = settingsRow.outreach_timezone ?? OUTREACH_TZ_FALLBACK;
        hourlyThrottle =
          typeof settingsRow.hourly_throttle === "number" ? settingsRow.hourly_throttle : null;
      }
    } catch (e) {
      console.warn("[cron] settings fetch failed, using defaults:", e);
    }

    const nowDate = new Date();
    const withinOutreachWindow = isWithinSendWindow(sendWindow, nowDate, outreachTz);
    const dayAllowed = isAllowedDay(allowedDays, nowDate, outreachTz);

    // Pacing state: count today's FRESH outreach sends (step 1 only) + find the most-recent
    // one. Follow-ups don't count toward the cap and don't reset the pacing clock — only
    // first-touch sends do.
    let outreachSentToday = 0;
    let outreachSentLastHour = 0;
    let lastSentTodayMs: number | null = null;
    if (dayAllowed) {
      const startOfToday = startOfDayInTz(nowDate, outreachTz);
      const startOfTodayIso = startOfToday.toISOString();
      const hourAgoIso = new Date(nowDate.getTime() - 3600_000).toISOString();

      const { count: todayCount } = await supabase
        .from("message_queue")
        .select("id, contact:contacts!inner(pipeline)", { count: "exact", head: true })
        .eq("message_type", "sms")
        .eq("status", "sent")
        .eq("contact.pipeline", OUTREACH_PIPELINE)
        .eq("metadata->>step_order", "1")
        .gte("sent_at", startOfTodayIso);
      outreachSentToday = todayCount ?? 0;

      const { count: hourCount } = await supabase
        .from("message_queue")
        .select("id, contact:contacts!inner(pipeline)", { count: "exact", head: true })
        .eq("message_type", "sms")
        .eq("status", "sent")
        .eq("contact.pipeline", OUTREACH_PIPELINE)
        .eq("metadata->>step_order", "1")
        .gte("sent_at", hourAgoIso);
      outreachSentLastHour = hourCount ?? 0;

      const { data: lastRow } = await supabase
        .from("message_queue")
        .select("sent_at, contact:contacts!inner(pipeline)")
        .eq("message_type", "sms")
        .eq("status", "sent")
        .eq("contact.pipeline", OUTREACH_PIPELINE)
        .eq("metadata->>step_order", "1")
        .gte("sent_at", startOfTodayIso)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastRow?.sent_at) lastSentTodayMs = new Date(lastRow.sent_at).getTime();
    }

    const windowSeconds = Math.max(
      0,
      (sendWindow.send_window_end - sendWindow.send_window_start) * 3600,
    );
    const pacingDecision = computeOutreachBudget(
      { dailyCap, windowSeconds, hourlyThrottle },
      {
        sentToday: outreachSentToday,
        sentLastHour: outreachSentLastHour,
        secondsSinceLastSendToday:
          lastSentTodayMs !== null ? Math.floor((nowDate.getTime() - lastSentTodayMs) / 1000) : null,
      },
    );

    // Outreach can send 1 message this tick if all gates pass; otherwise 0 (messages stay pending).
    let outreachBudget: number =
      dayAllowed && withinOutreachWindow ? pacingDecision.allowed : 0;

    console.log(
      `[cron] outreach tz=${outreachTz} day=${dayAllowed} window=${withinOutreachWindow} sentToday=${outreachSentToday}/${dailyCap} sentLastHr=${outreachSentLastHour} paceInterval=${pacingDecision.paceIntervalSeconds}s reason=${pacingDecision.reason} budget=${outreachBudget}`,
    );

    // Fetch pending messages in three batches to prevent outreach step-1 cold
    // sends from starving follow-ups or warm-sequence messages.
    //
    // Batch A — everything except step-1 (CRM flows, step 2+, emails).
    //   step_order IS NULL  → CRM messages (queueSteps doesn't set step_order)
    //   step_order != '1'   → follow-ups (step 2, 3…) for any sequence
    // Batch B — cold outreach step-1 only (stage='Sequence Active'), max 1.
    //   Gated by daily send cap, send window, and pacing interval.
    // Batch C — warm/replied step-1 (stage != 'Sequence Active'), up to 5.
    //   Bypasses daily cap — these are responses to positive replies, not
    //   cold first-touches. Timing already enforced at scheduling time via
    //   queueNextStep anchor_timing logic.
    const [
      { data: pendingOther,     error: pendingOtherError },
      { data: pendingStep1Cold, error: pendingStep1ColdError },
      { data: pendingStep1Warm, error: pendingStep1WarmError },
    ] = await Promise.all([
      supabase
        .from("message_queue")
        .select("*, contact:contacts(pipeline, stage, outreach_angle)")
        .eq("status", "pending")
        .lte("scheduled_at", now)
        .or("metadata->>step_order.is.null,metadata->>step_order.neq.1")
        .order("scheduled_at", { ascending: true })
        .limit(44),
      supabase
        .from("message_queue")
        .select("*, contact:contacts!inner(pipeline, stage, outreach_angle)")
        .eq("status", "pending")
        .lte("scheduled_at", now)
        .eq("metadata->>step_order", "1")
        .eq("contact.stage", "Sequence Active")
        .order("scheduled_at", { ascending: true })
        .limit(1),
      supabase
        .from("message_queue")
        .select("*, contact:contacts!inner(pipeline, stage, outreach_angle)")
        .eq("status", "pending")
        .lte("scheduled_at", now)
        .eq("metadata->>step_order", "1")
        .neq("contact.stage", "Sequence Active")
        .order("scheduled_at", { ascending: true })
        .limit(5),
    ]);

    if (pendingOtherError) throw new Error(`Queue fetch error: ${pendingOtherError.message}`);
    if (pendingStep1ColdError) throw new Error(`Queue fetch error (step1 cold): ${pendingStep1ColdError.message}`);
    if (pendingStep1WarmError) throw new Error(`Queue fetch error (step1 warm): ${pendingStep1WarmError.message}`);

    // Also pick up failed messages eligible for retry (retry_count < MAX_RETRIES, backoff elapsed)
    const { data: retryMessages, error: retryError } = await supabase
      .from("message_queue")
      .select("*, contact:contacts(pipeline, stage, outreach_angle)")
      .eq("status", "failed")
      .lt("metadata->>retry_count", MAX_RETRIES)
      .lte("metadata->>retry_after", now)
      .order("scheduled_at", { ascending: true })
      .limit(10);

    if (retryError) throw new Error(`Retry fetch error: ${retryError.message}`);

    const messages = [
      ...(pendingOther ?? []),
      ...(pendingStep1Cold ?? []),
      ...(pendingStep1Warm ?? []),
      ...(retryMessages ?? []),
    ];

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
      const stepOrder = Number(msg.metadata?.step_order ?? 0);
      // First-touch cold send: gated by send window, day filter, daily cap, and pacing.
      // Warm/replied step-1s (stage != 'Sequence Active') bypass all gates — timing
      // is already enforced at scheduling time via queueNextStep anchor_timing logic.
      const isFirstSend = isOutreach && stepOrder === 1 && (msg.contact?.stage ?? "") === "Sequence Active";
      const releaseProcessing = (newStatus: string) =>
        supabase.from("message_queue").update({ status: newStatus }).eq("id", msg.id);
      const dropProcessingId = () => {
        const idx = processingIds.indexOf(msg.id);
        if (idx !== -1) processingIds.splice(idx, 1);
      };

      // ── Global dnd_sms + not-interested stage check (all SMS, not just outreach) ──
      if ((msg.message_type === "sms" || msg.message_type === "internal_sms") && msg.contact_id) {
        const { data: contactRow } = await supabase
          .from("contacts")
          .select("dnd_sms, stage, pipeline")
          .eq("id", msg.contact_id)
          .maybeSingle();
        const isNotInterested = contactRow?.pipeline === "Outreach" && contactRow?.stage === "Not Interested";
        if (contactRow?.dnd_sms || isNotInterested) {
          const reason = contactRow?.dnd_sms ? "dnd_sms=true" : "stage=Not Interested";
          console.log(`[cron] skipping message ${msg.id} — contact ${msg.contact_id} has ${reason}`);
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

      // Outreach guardrails (SMS). CRM flows bypass entirely.
      // DNC applies to ALL outreach sends (fresh + follow-ups).
      // Window / day / pacing / cap apply to first-touch sends ONLY — follow-ups
      // fire whenever their scheduled_at hits, even outside the send window.
      if (isOutreach && (msg.message_type === "sms" || msg.message_type === "internal_sms")) {
        const toCheck = msg.to_phone ?? msg.metadata?.to;
        if (toCheck && (await isDNC(supabase, toCheck))) {
          await releaseProcessing("skipped_dnc");
          dropProcessingId();
          continue;
        }

        if (isFirstSend) {
          if (!withinOutreachWindow || !dayAllowed) {
            await releaseProcessing("pending");
            dropProcessingId();
            continue;
          }
          if (outreachBudget <= 0) {
            await releaseProcessing("pending");
            dropProcessingId();
            continue;
          }
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

          // Only first-touch sends consume the daily cap.
          if (isFirstSend) outreachBudget--;

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

        } else if (msg.message_type === "telegram") {
          await sendTelegram(msg.message_content);

          await supabase
            .from("message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", msg.id);

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

        // For outreach sequences: schedule the next step relative to THIS step's
        // actual send time. Do this BEFORE advanceContactSequence so failure here
        // doesn't leave us with current_step bumped but no next message queued.
        if (isOutreach && msg.contact_sequence_id) {
          try {
            await queueNextStep(supabase, msg);
          } catch (qErr) {
            console.error(`queueNextStep failed for contact ${msg.contact_id}:`, qErr);
          }
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
