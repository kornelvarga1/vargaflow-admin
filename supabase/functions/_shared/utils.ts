import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
        ? { to, subject: `Message from ${settings.company_name ?? "your contractor"}` }
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