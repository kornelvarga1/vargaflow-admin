// Claude tool definitions + dispatcher for the AI text agent. Reuses the
// exact same booking backend the voice receptionist's Retell tools already
// hit (get-availability / book-call / manage-booking, all scoped to
// ADMIN_BUSINESS_ID) — same JSON-Schema shape as the Retell tool defs in
// contractor-voice-template/clients/vargaflow-self-*.json, just under
// input_schema instead of parameters.
//
// Deliberate simplification over the voice version: `phone` is never a
// model-supplied parameter. Voice needed the {{caller_number}} template
// (resolved server-side, but still something the model had to be told not to
// mis-fill) because a caller's number could arrive as an unresolved
// placeholder. A text agent has zero ambiguity — the real sender number is
// the inbound SMS `From` — so it's injected here unconditionally and dropped
// from every tool's input schema entirely. That removes the whole
// "did the model pass an invented/placeholder number" bug class.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID, markContactNotInterested } from "./utils.ts";

const FUNCTIONS_BASE = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;

export const TEXT_AGENT_TOOLS = [
  {
    name: "check_availability",
    description:
      "Call this when you're ready to offer real open times to book a call with Kornél. Returns real slots, soonest first. Always call this instead of guessing or making up times — only mention the first 2-3 in your reply.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "book_appointment",
    description:
      "Call this once they've picked one of the slots you offered from check_availability, and you've confirmed their name and email. Actually books the call on Kornél's real calendar and triggers the automatic SMS + email confirmation. Use the exact start_iso/end_iso from the slot they chose — never invent your own times.",
    input_schema: {
      type: "object",
      properties: {
        start_iso: { type: "string", description: "The exact start_iso value from the slot they chose in check_availability's response" },
        end_iso: { type: "string", description: "The exact end_iso value from the slot they chose in check_availability's response" },
        full_name: { type: "string", description: "Their full name, as they typed it" },
        email: { type: "string", description: "Their email, as they typed it" },
        timezone: { type: "string", description: "Their IANA timezone, e.g. America/New_York, America/Chicago, America/Denver, America/Los_Angeles" },
      },
      required: ["start_iso", "end_iso", "full_name", "email", "timezone"],
    },
  },
  {
    name: "reschedule_appointment",
    description:
      "Call this to move their existing booking with Kornél to a new time. Looks up their soonest upcoming booking automatically — no need to ask which one unless they mention having multiple. Always call check_availability first to get a real new slot before calling this.",
    input_schema: {
      type: "object",
      properties: {
        start_iso: { type: "string", description: "The exact start_iso value from the new slot they chose in check_availability's response" },
        end_iso: { type: "string", description: "The exact end_iso value from the new slot they chose in check_availability's response" },
        timezone: { type: "string", description: "Their IANA timezone, e.g. America/New_York, America/Chicago, America/Denver, America/Los_Angeles" },
      },
      required: ["start_iso", "end_iso", "timezone"],
    },
  },
  {
    name: "cancel_appointment",
    description:
      "Call this to cancel their existing booking with Kornél. Looks up their soonest upcoming booking automatically — no need to ask which one unless they mention having multiple.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "flag_not_interested",
    description:
      "Call this when their message is a CLEAR, unambiguous signal they want to be left alone or are done with the conversation — hostile, dismissive, or a decline that doesn't use an exact opt-out word (e.g. \"kick rocks\", a creative insult, \"who gave you this number\"). This stops all future contact to them — it's a real, permanent action, not a soft flag. Do NOT call this for someone just being brief, skeptical, or asking a blunt question — those aren't declines. When in doubt, don't call it. After calling it, send exactly one short, low-key, respectful closing reply in the same turn — never silence, and never keep pitching or asking questions afterward.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export async function executeTextAgentTool(
  toolName: string,
  modelInput: Record<string, unknown>,
  ctx: { fromPhone: string; supabase: SupabaseClient; contact: Record<string, any> }
): Promise<unknown> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${FUNCTIONS_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  switch (toolName) {
    case "check_availability": {
      const res = await fetch(`${FUNCTIONS_BASE}/get-availability`, {
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      return res.json();
    }
    case "book_appointment":
      return post("book-call", { ...modelInput, phone: ctx.fromPhone });
    case "reschedule_appointment":
      return post("manage-booking", { ...modelInput, action: "reschedule", phone: ctx.fromPhone });
    case "cancel_appointment":
      return post("manage-booking", { action: "cancel", phone: ctx.fromPhone });
    case "flag_not_interested":
      await markContactNotInterested(ctx.supabase, {
        contactId: ctx.contact.id,
        phone: ctx.fromPhone,
        pipeline: ctx.contact.pipeline ?? null,
        outreachAngle: ctx.contact.outreach_angle ?? null,
        businessId: ADMIN_BUSINESS_ID,
        reason: "ai_text_agent_judgment",
      });
      return { success: true };
    default:
      return { error: `unknown tool: ${toolName}` };
  }
}
