import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Authorization guard for admin-only edge functions.
// Accepts two kinds of bearer token:
//   1. The service_role JWT (used by cron + server-side invokers via
//      invokeFunctionCall) — no DB lookup, direct token comparison.
//   2. A Supabase-issued user JWT whose profiles.role = 'admin'.
// Anything else (anon JWT, non-admin user JWT, missing token) throws.
// Call this as the FIRST line inside serve() for any function that can
// spend money (Twilio, Resend) or send notifications.
export class AuthError extends Error {
  constructor(public code: "UNAUTHORIZED" | "FORBIDDEN", message: string) {
    super(message);
  }
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder("utf-8").decode(bytes);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function requireAdmin(req: Request): Promise<void> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const authToken = authHeader.replace(/^Bearer\s+/i, "").trim();

  // Gateway (verify_jwt=true) already validated the token signature, so we
  // can trust the decoded claims. Service-role calls (cron + internal) get a
  // free pass.
  const authClaims = decodeJwtClaims(authToken);
  if (authClaims?.role === "service_role") return;

  // Admin UI sends X-User-Auth with the user session JWT because the gateway
  // slot carries the HS256 anon JWT. Fall back to Authorization if absent
  // (direct invocations outside the UI flow).
  const userAuthHeader = req.headers.get("X-User-Auth") ?? "";
  const userToken = (userAuthHeader || authHeader).replace(/^Bearer\s+/i, "").trim();
  if (!userToken) throw new AuthError("UNAUTHORIZED", "missing token");

  const userClaims = decodeJwtClaims(userToken);
  if (!userClaims || userClaims.role === "anon") {
    throw new AuthError("UNAUTHORIZED", "user session required");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser(userToken);
  if (userErr || !userData?.user) throw new AuthError("UNAUTHORIZED", "invalid user token");

  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profErr || profile?.role !== "admin") {
    throw new AuthError("FORBIDDEN", "admin role required");
  }
}

// Authorization for endpoints a business owner needs to call from their own
// app (vargaflow-client), not just admin tooling. Accepts:
//   1. service_role bearer (cron + server-side invokers).
//   2. profile.role = 'admin' (vargaflow-admin tooling — full access).
//   3. profile.business_id === businessId (the client owns this business).
// Anything else throws.
export async function requireAdminOrBusinessMember(
  req: Request,
  businessId: string,
): Promise<void> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const authToken = authHeader.replace(/^Bearer\s+/i, "").trim();

  const authClaims = decodeJwtClaims(authToken);
  if (authClaims?.role === "service_role") return;

  const userAuthHeader = req.headers.get("X-User-Auth") ?? "";
  const userToken = (userAuthHeader || authHeader).replace(/^Bearer\s+/i, "").trim();
  if (!userToken) throw new AuthError("UNAUTHORIZED", "missing token");

  const userClaims = decodeJwtClaims(userToken);
  if (!userClaims || userClaims.role === "anon") {
    throw new AuthError("UNAUTHORIZED", "user session required");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser(userToken);
  if (userErr || !userData?.user) throw new AuthError("UNAUTHORIZED", "invalid user token");

  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("role, business_id")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profErr || !profile) throw new AuthError("FORBIDDEN", "profile not found");
  if (profile.role === "admin") return;
  if (profile.business_id === businessId) return;
  throw new AuthError("FORBIDDEN", "business membership required");
}

// Lightweight webhook authenticator for providers whose dashboard UI can't
// configure HMAC signatures (e.g. Calendly dashboard-created webhooks).
// The webhook URL includes `?k=<secret>` and we verify it against an env var.
// Constant-time compare so timing attacks can't leak the secret byte-by-byte.
export function validateWebhookToken(req: Request, envVarName: string): boolean {
  const expected = Deno.env.get(envVarName);
  if (!expected) {
    console.warn(`[validateWebhookToken] ${envVarName} not set — rejecting`);
    return false;
  }
  const url = new URL(req.url);
  const provided = url.searchParams.get("k") ?? "";
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function authErrorResponse(err: unknown, corsHeaders: Record<string, string> = {}) {
  if (err instanceof AuthError) {
    const status = err.code === "UNAUTHORIZED" ? 401 : 403;
    return new Response(JSON.stringify({ error: err.message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}

// Validate an incoming Twilio webhook's X-Twilio-Signature header per
// https://www.twilio.com/docs/usage/security
//  - Concatenate URL + sorted form-param key-value pairs
//  - HMAC-SHA1 using your TWILIO_AUTH_TOKEN
//  - Base64 → compare to the header
// Call this at the entry of every endpoint Twilio POSTs to (inbound-sms,
// inbound-call, missed-call-text-back). Returns false on any mismatch or
// missing signature.
export async function validateTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  if (!authToken || !signature) return false;
  const sortedKeys = Object.keys(params).sort();
  let payload = url;
  for (const k of sortedKeys) payload += k + params[k];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// Normalize phone numbers to E.164 format so the unique (business_id, phone)
// constraint works consistently. 10 digits → prepend "+1" (US/CA), 11+ digits
// → prepend "+". Anything else (including empty strings, "Anonymous", < 10
// digits) → null so the row doesn't pollute the dataset.
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length >= 11) return "+" + digits;
  return null;
}

// Your own internal "business" record — used ONLY to look up which Twilio
// number/settings row to send from when a flow has no real client business_id
// to work with (e.g. your personal Calendly, or your own Twilio number
// receiving a first-time text). Never write this onto contacts.business_id
// or message_queue.business_id — those fields mean "which client's customer
// is this," and stamping your own admin id on them makes the row disappear
// from every contacts view (they all filter business_id IS NULL for "mine").
// Keep in sync with cron-message-sender's ADMIN_BUSINESS_ID.
export const ADMIN_BUSINESS_ID = "79036fbb-997c-4f7b-b46f-ccc97a64c38d";

// Find an existing contact or create a new one, without ever producing a
// second row for the same phone number.
//   - contactBusinessId is the value that will be READ from and WRITTEN to
//     contacts.business_id. Pass null for your own leads (see ADMIN_BUSINESS_ID
//     above) — never pass a routing-only business id here.
//   - Matches by email first (global — a real email address identifies a
//     person regardless of which business_id they're currently filed under),
//     then by phone scoped to contactBusinessId.
//   - Safety net: if contactBusinessId is a real (non-null) business and
//     nothing matched, also checks phone under business_id IS NULL, so a
//     contact that hasn't been assigned a business yet doesn't get duplicated
//     the first time it's matched against a specific one.
export async function findOrCreateContact(
  supabase: SupabaseClient,
  opts: {
    phone: string | null | undefined;
    email?: string | null;
    contactBusinessId: string | null;
    onCreate: Record<string, any>;
  },
): Promise<{ contact: Record<string, any>; created: boolean }> {
  const phone = normalizePhone(opts.phone);

  if (opts.email) {
    const { data } = await supabase
      .from("contacts")
      .select("*")
      .eq("email", opts.email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return { contact: data, created: false };
  }

  if (phone) {
    let primaryQuery = supabase.from("contacts").select("*").eq("phone", phone);
    primaryQuery = opts.contactBusinessId === null
      ? primaryQuery.is("business_id", null)
      : primaryQuery.eq("business_id", opts.contactBusinessId);
    const { data: primary } = await primaryQuery
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (primary) return { contact: primary, created: false };

    if (opts.contactBusinessId !== null) {
      const { data: fallback } = await supabase
        .from("contacts")
        .select("*")
        .eq("phone", phone)
        .is("business_id", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (fallback) return { contact: fallback, created: false };
    }
  }

  const { data: created, error } = await supabase
    .from("contacts")
    .insert({
      ...opts.onCreate,
      phone,
      email: opts.email ?? opts.onCreate.email ?? null,
      business_id: opts.contactBusinessId,
    })
    .select()
    .single();
  if (error) throw new Error(`Contact create error: ${error.message}`);
  return { contact: created, created: true };
}

export async function getSettings(supabase: SupabaseClient, businessId: string) {
  const { data, error } = await supabase
    .from("settings")
    .select("*")
    .eq("business_id", businessId)
    .single();
  if (error) throw new Error(`Settings fetch error: ${error.message}`);
  return data;
}

export async function getSequenceSteps(supabase: SupabaseClient, sequenceName: string) {
  const { data: sequence, error: seqError } = await supabase
    .from("sequences")
    .select("id, is_active")
    .eq("name", sequenceName)
    .single();

  if (seqError) throw new Error(`Sequence fetch error: ${seqError.message}`);
  if (!sequence.is_active) return [];

  const { data: steps, error: stepsError } = await supabase
    .from("sequence_steps")
    .select("*")
    .eq("sequence_id", sequence.id)
    .order("step_order");

  if (stepsError) throw new Error(`Steps fetch error: ${stepsError.message}`);
  return steps;
}

// Trade-matched voice demos. A contact scraped for a given trade carries that
// trade as a tag (set at import time), and the outreach copy points them at the
// demo answering as their own trade rather than a generic one — a roofing demo
// made non-roofers hang up inside 20 seconds, while roofers stayed minutes.
// Keyed by the trade tag on contacts.tags; falls back to the roofing demo.
const TRADE_DEMOS: Record<string, { company: string; number: string }> = {
  garage_door:      { company: "Apex Overhead Door",        number: "(616) 449-1976" },
  appliance_repair: { company: "Redline Appliance Repair",  number: "(567) 364-8596" },
  air_duct:         { company: "Clearway Duct & Air",       number: "(878) 378-9417" },
  chimney:          { company: "Hearth & Flue Chimney",     number: "(708) 438-6561" },
  pest_control:     { company: "Sentry Pest Solutions",     number: "(716) 576-3217" },
};
const DEFAULT_DEMO = { company: "Summit Roofing & Exteriors", number: "(213) 238-5364" };

function demoForContact(contact: Record<string, any>) {
  const tags: string[] = Array.isArray(contact.tags) ? contact.tags : [];
  for (const t of tags) {
    const hit = TRADE_DEMOS[t];
    if (hit) return hit;
  }
  return DEFAULT_DEMO;
}

export function resolveTemplate(
  template: string,
  contact: Record<string, any>,
  settings: Record<string, any>
): string {
  const demo = demoForContact(contact);
  const vars: Record<string, string> = {
    demo_number: demo.number,
    demo_company: demo.company,
    contact_first_name: contact.full_name?.split(" ")[0] ?? "",
    contact_name: contact.full_name ?? "",
    contact_phone: contact.phone ?? "",
    contact_email: contact.email ?? "",
    contact_company: settings.company_name ?? "",
    my_name: settings.my_name ?? "",
    my_phone: settings.my_phone ?? "",
    my_email: settings.my_email ?? "",
    company_name: settings.company_name ?? "",
    website_url: settings.website_url ?? "",
    software_explanation_video: settings.software_explanation_video ?? "",
    testimonials_link: settings.testimonials_link ?? "",
    case_study_link: settings.case_study_link ?? "",
    demo_calendar_link: settings.demo_calendar_link ?? "",
    launch_call_calendar_link: settings.launch_call_calendar_link ?? "",
    onboarding_form_link: settings.onboarding_form_link ?? "",
    instagram_url: settings.instagram_url ?? "",
    gmb_tutorial_link: settings.gmb_tutorial_link ?? "",
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export async function queueSteps(
  supabase: SupabaseClient,
  contactId: string,
  steps: any[],
  contact: Record<string, any>,
  settings: Record<string, any>,
  businessId: string
) {
  if (steps.length === 0) return;

  const now = new Date();

  const rows = steps.map((step) => {
    const sendAt = new Date(now);
    sendAt.setHours(sendAt.getHours() + (step.delay_hours ?? 0));
    sendAt.setMinutes(sendAt.getMinutes() + (step.delay_minutes ?? 0));

    const to = step.message_type === "email" ? contact.email : contact.phone;

    return {
      contact_id: contactId,
      business_id: businessId,
      message_type: step.message_type,
      message_content: resolveTemplate(step.message_template, contact, settings),
      scheduled_at: sendAt.toISOString(),
      status: "pending",
      metadata: step.message_type === "email"
        ? { to, subject: `Message from ${settings.company_name ?? "your contractor"}`, ...(settings.my_email ? { reply_to: settings.my_email } : {}) }
        : { to },
    };
  });

  const { error } = await supabase.from("message_queue").insert(rows);
  if (error) throw new Error(`Queue insert error: ${error.message}`);
}

export async function cancelPendingMessages(
  supabase: SupabaseClient,
  contactId: string
): Promise<number> {
  const { data, error } = await supabase
    .from("message_queue")
    .update({ status: "cancelled" })
    .eq("contact_id", contactId)
    .eq("status", "pending")
    .select("id");

  if (error) console.error(`Cancel pending messages error: ${error.message}`);
  return data?.length ?? 0;
}

// Build the unsubscribe URL for a given contact.
function unsubscribeUrl(contactId: string): string {
  const base = (globalThis as any).Deno?.env.get("SUPABASE_URL") ?? "";
  return `${base}/functions/v1/unsubscribe?c=${contactId}`;
}

// Send an email via Resend with the CAN-SPAM/GDPR-required unsubscribe plumbing:
//  - List-Unsubscribe + List-Unsubscribe-Post headers (RFC 2369 + RFC 8058)
//    so Gmail/Outlook show a native "Unsubscribe" button
//  - Visible footer link in the HTML body
// Every transactional email to a contact must go through this helper — direct
// fetches to api.resend.com skip compliance plumbing.
export async function sendEmailWithUnsubscribe(
  params: {
    resendKey: string;
    from: string;
    to: string;
    subject: string;
    html: string;
    contactId: string;
    replyTo?: string;
  }
): Promise<Response> {
  const unsubUrl = unsubscribeUrl(params.contactId);
  const footer = `
<hr style="margin-top:2rem;border:none;border-top:1px solid #eee" />
<p style="color:#888;font-size:0.85em;line-height:1.4">
  Don't want these emails? <a href="${unsubUrl}" style="color:#888">Unsubscribe</a>.
</p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      subject: params.subject,
      html: params.html + footer,
      ...(params.replyTo ? { reply_to: params.replyTo } : {}),
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>, <mailto:unsub@vargaflow.com>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  return res;
}

export async function getTwilioFromNumber(
  supabase: SupabaseClient,
  businessId: string
): Promise<string> {
  const { data } = await supabase
    .from("settings")
    .select("twilio_phone_number")
    .eq("business_id", businessId)
    .single();
  const number = data?.twilio_phone_number;
  if (number) return number;
  const fallback = (globalThis as any).Deno?.env.get("TWILIO_PHONE_NUMBER");
  if (!fallback) throw new Error(`No twilio_phone_number for business ${businessId} and no env fallback`);
  return fallback;
}

// Send a single SMS immediately via the Twilio REST API (not the
// message_queue/cron-message-sender pipeline — that adds up to ~60s of
// latency plus is subject to DNC/window/pacing gates meant for bulk
// sends, not a live conversational reply). Same request shape as the
// private sendSMS closures duplicated in cron-message-sender and
// handleCallBooked, just exported for direct reuse (e.g. the text agent).
export async function sendSmsNow(
  params: { to: string; from: string; body: string }
): Promise<{ sid: string }> {
  const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${twilioSid}:${twilioAuth}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: params.to, From: params.from, Body: params.body }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Twilio error: ${data.message ?? res.statusText}`);
  }
  return { sid: data.sid };
}

// Applies the same DNC/opt-out mechanics as inbound-sms's regex-based
// negative-keyword path (dnd_sms + DNC-list + stage flip + stop active
// outreach sequences + cancel pending messages), but for the AI text agent's
// own judgment call on a reply that reads as a clear decline/hostile
// dismissal without matching an exact opt-out phrase (e.g. "kick rocks").
// Deliberately NOT wired into inbound-sms's existing regex path — that path
// is compliance-critical (literal STOP-type keywords) and already proven in
// production; left untouched rather than refactored to share this, so a bug
// here can't regress it.
export async function markContactNotInterested(
  supabase: SupabaseClient,
  params: {
    contactId: string;
    phone: string;
    pipeline: string | null;
    outreachAngle: string | null;
    businessId: string;
    reason: string;
  }
): Promise<void> {
  const { contactId, phone, pipeline, outreachAngle, businessId, reason } = params;
  const now = new Date().toISOString();

  await supabase.from("contacts").update({ dnd_sms: true }).eq("id", contactId);
  await supabase
    .from("message_queue")
    .update({ status: "cancelled" })
    .eq("contact_id", contactId)
    .eq("status", "pending")
    .in("message_type", ["sms", "internal_sms"]);

  if (pipeline === "Outreach") {
    const { error: dncError } = await supabase.from("dnc_list").insert({
      phone, reason, source_workflow: outreachAngle, business_id: businessId,
    });
    if (dncError && !/duplicate|unique/i.test(dncError.message)) {
      console.error(`[markContactNotInterested] dnc_list insert error for ${phone}:`, dncError.message);
    }

    await supabase.from("contacts").update({ stage: "Not Interested", stage_entered_at: now }).eq("id", contactId);

    const { data: activeSeqs } = await supabase
      .from("contact_sequences")
      .select("id, sequence:sequences(pipeline)")
      .eq("contact_id", contactId)
      .eq("status", "active");
    const outreachSeqIds = (activeSeqs ?? [])
      .filter((s: any) => s.sequence?.pipeline?.toLowerCase() === "outreach")
      .map((s: any) => s.id);
    if (outreachSeqIds.length > 0) {
      await supabase.from("contact_sequences").update({ status: "stopped" }).in("id", outreachSeqIds);
    }

    await supabase.from("message_queue").update({ status: "cancelled" }).eq("contact_id", contactId).eq("status", "pending");
  }
}

export async function notifyAdmin(text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.warn("[notifyAdmin] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("[notifyAdmin] Telegram send failed:", err);
  }
}

// Exchanges a stored Google OAuth refresh token for a short-lived access
// token. Called fresh on every calendar request rather than caching/tracking
// expiry ourselves — call volume here is low (one voice call at a time per
// business), so the extra round-trip is cheap and avoids expiry-tracking bugs.
export async function getGoogleAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

export async function hasPendingMessages(
  supabase: SupabaseClient,
  contactId: string
): Promise<boolean> {
  const { count, error } = await supabase
    .from("message_queue")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .eq("status", "pending");

  if (error) console.error(`Check pending messages error: ${error.message}`);
  return (count ?? 0) > 0;
}

// Everything that happens once a sales call is confirmed for a time slot:
// dedupe, contact creation, the immediate confirmation SMS/email, the full
// time-relative reminder cascade, and the returning-booker ("rebooked")
// branch. Originally lived inline in flow-call-booked (Calendly webhook);
// extracted so both that legacy adapter and the self-built booking flow
// (book-call, manage-booking) share one implementation. Callers pass an
// eventId used only for idempotency — reuse the same id to no-op a repeat
// call, or pass a fresh one (e.g. on reschedule) to force a new cascade.
export async function handleCallBooked(
  supabase: SupabaseClient,
  params: {
    eventId: string;
    contactName: string;
    contactEmail: string;
    contactPhone: string;
    eventTime: string;
    meetingLink: string;
    inviteeTz: string;
    routingBid: string;
    manageUrl?: string;
  }
): Promise<{
  contact: Record<string, any> | null;
  created: boolean;
  duplicate: boolean;
  noPhone: boolean;
  branch?: "first-time" | "returning";
}> {
  const { eventId, contactName, contactEmail, contactPhone, eventTime, meetingLink, inviteeTz, routingBid, manageUrl } = params;
  const contactBid = routingBid === ADMIN_BUSINESS_ID ? null : routingBid ?? null;

  const formatTime = (tz: string) =>
    eventTime ? new Date(eventTime).toLocaleString("en-US", { timeZone: tz }) : "your scheduled time";
  const appointmentTimeForContact = formatTime(inviteeTz);
  // Internal SMS/Telegram goes to Kornél in Hungary — Europe/Budapest handles
  // DST automatically (CET in winter, CEST in summer).
  const appointmentTimeForMe = formatTime("Europe/Budapest");

  const { error: dupError } = await supabase
    .from("processed_webhooks")
    .insert({ event_id: eventId });
  if (dupError) {
    console.log("[handleCallBooked] duplicate event, skipping:", dupError.message);
    return { contact: null, created: false, duplicate: true, noPhone: false };
  }

  const { contact, created } = await findOrCreateContact(supabase, {
    phone: contactPhone,
    email: contactEmail,
    contactBusinessId: contactBid,
    onCreate: {
      full_name: contactName,
      pipeline: "Sales",
      stage: "Zoom Call Booked",
      timezone: inviteeTz ?? null,
    },
  });

  if (!created && inviteeTz && !contact.timezone) {
    await supabase.from("contacts").update({ timezone: inviteeTz }).eq("id", contact.id);
  }

  const normalizedPhone = normalizePhone(contactPhone);
  const resolvedPhone = normalizedPhone || contact.phone || "";

  if (!resolvedPhone) {
    await supabase.from("automation_logs").insert({
      contact_id: contact.id,
      business_id: contact.business_id,
      flow: "flow-call-booked",
      status: "skipped-no-phone",
      ran_at: new Date().toISOString(),
    });
    return { contact, created, duplicate: false, noPhone: true };
  }

  if (normalizedPhone && !contact.phone) {
    await supabase.from("contacts").update({ phone: normalizedPhone }).eq("id", contact.id);
  }

  await cancelPendingMessages(supabase, contact.id);

  await supabase
    .from("contacts")
    .update({ stage: "Zoom Call Booked" })
    .eq("id", contact.id);

  const settingsBid = routingBid ?? contact.business_id;
  const settings = await getSettings(supabase, settingsBid);

  const myName = settings.my_name || "Kornel";
  const companyName = settings.company_name || "Local Scaling";
  const videoLink = settings.software_explanation_video || "[video link]";
  const websiteUrl = settings.website_url || "[website]";

  const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const twilioAuth = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const twilioFrom = await getTwilioFromNumber(supabase, settingsBid);
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
    const res = await sendEmailWithUnsubscribe({
      resendKey,
      from: `${companyName} <hello@vargaflow.com>`,
      to,
      subject,
      html,
      contactId: contact.id,
      replyTo: settings.my_email || undefined,
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(`Resend error: ${data.message ?? res.statusText}`);
    }
  };

  const now = Date.now();

  const queueTelegram = async (text: string, scheduledAt: Date) => {
    if (scheduledAt.getTime() <= now) return;
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      business_id: contact.business_id,
      message_type: "telegram",
      message_content: text,
      scheduled_at: scheduledAt.toISOString(),
      status: "pending",
      metadata: {},
    });
  };

  const queueSMS = async (to: string, body: string, scheduledAt: Date) => {
    if (scheduledAt.getTime() <= now) return;
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      business_id: contact.business_id,
      message_type: "sms",
      message_content: body,
      scheduled_at: scheduledAt.toISOString(),
      status: "pending",
      metadata: { to },
    });
  };

  const queueEmail = async (to: string, subject: string, html: string, scheduledAt: Date) => {
    if (!to) return;
    if (scheduledAt.getTime() <= now) return;
    await supabase.from("message_queue").insert({
      contact_id: contact.id,
      business_id: contact.business_id,
      message_type: "email",
      message_content: html,
      scheduled_at: scheduledAt.toISOString(),
      status: "pending",
      metadata: { to, subject, ...(settings.my_email ? { reply_to: settings.my_email } : {}) },
    });
  };

  const { data: tagsRow } = await supabase
    .from("contacts")
    .select("tags")
    .eq("id", contact.id)
    .single();

  const tagsArr: string[] = Array.isArray(tagsRow?.tags) ? tagsRow.tags : [];
  const hasBookedTag = tagsArr.includes("Booked");
  const meetingDate = eventTime ? new Date(eventTime) : new Date();
  const manageLine = manageUrl ? ` Need to reschedule or cancel? ${manageUrl}` : "";
  const manageHtml = manageUrl
    ? `<p>Need to reschedule or cancel? <a href="${manageUrl}">Manage your booking here</a>.</p>`
    : "";

  // Step 1: Confirmation SMS immediately
  await sendSMS(
    resolvedPhone,
    `Booked! Your Zoom call with ${myName} is all set for ${appointmentTimeForContact}. — ${myName}${manageLine}`
  );

  // Step 2: Internal Telegram notification immediately
  await notifyAdmin(`${contactName} just booked the call. Date: ${appointmentTimeForMe}. Number: ${resolvedPhone}.`);

  if (!hasBookedTag) {
    const updatedTags = tagsArr.includes("Booked") ? tagsArr : [...tagsArr, "Booked"];
    await supabase.from("contacts").update({ tags: updatedTags }).eq("id", contact.id);

    await sendEmail(
      contactEmail,
      `Your call with ${myName} is booked`,
      `<p>Hey ${contactName},</p>
       <p>Your Zoom call with ${myName} is booked for ${appointmentTimeForContact}.</p>
       <p>Join link: ${meetingLink || "[Zoom link will be sent before call]"}</p>
       ${manageHtml}
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
      `See you on Zoom in 1 hour! Your Zoom link: ${meetingLink}`,
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
    await queueTelegram(`Sales call with ${contactName} is in 1 hour. Number: ${resolvedPhone}.`, reminder1h);

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
    await queueTelegram(`Sales call with ${contactName} is in 3 minutes. Number: ${resolvedPhone}.`, reminder3m);

  } else {
    await sendEmail(
      contactEmail,
      `Your call with ${myName} is rebooked`,
      `<p>Hey ${contactName},</p>
       <p>Got you back on the calendar — Zoom call with ${myName} is set for ${appointmentTimeForContact}.</p>
       ${manageHtml}
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
      `See you in an hour! Your Zoom link: ${meetingLink} — ${myName}`,
      reminder1h
    );
    await queueTelegram(`Sales call with ${contactName} is in 1 hour. Number: ${resolvedPhone}.`, reminder1h);

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
    await queueTelegram(`Sales call with ${contactName} is in 5 minutes. Number: ${resolvedPhone}.`, reminder5m);
  }

  await supabase.from("automation_logs").insert({
    contact_id: contact.id,
    business_id: contact.business_id,
    flow: "flow-call-booked",
    status: "completed",
    ran_at: new Date().toISOString(),
  });

  return { contact, created, duplicate: false, noPhone: false, branch: hasBookedTag ? "returning" : "first-time" };
}