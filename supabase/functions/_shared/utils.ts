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

export function resolveTemplate(
  template: string,
  contact: Record<string, any>,
  settings: Record<string, any>
): string {
  const vars: Record<string, string> = {
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