import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_BUSINESS_ID, getTwilioFromNumber, notifyAdmin, sendSmsNow } from "./utils.ts";
import { TEXT_AGENT_SYSTEM_PROMPT } from "./textAgentPrompt.ts";
import { executeTextAgentTool, TEXT_AGENT_TOOLS } from "./textAgentTools.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 5;
const HISTORY_LIMIT = 20;
const LOOP_GUARD_LIMIT = 10; // max AI-sent replies to one contact per 24h

type ClaudeMessage = { role: "user" | "assistant"; content: unknown };

async function callClaude(system: string, messages: ClaudeMessage[]): Promise<{
  content: Array<Record<string, any>>;
  stop_reason: string;
}> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TEXT_AGENT_TOOLS,
      messages,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }
  return res.json();
}

function extractText(content: Array<Record<string, any>>): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

// Generates and sends the AI's reply to an inbound text on Kornél's own
// number. Called via EdgeRuntime.waitUntil from inbound-sms so the Twilio
// webhook itself still returns fast — this can take a few seconds across
// multiple tool-use round trips. Never throws: any failure is caught,
// reported to Kornél via Telegram, and swallowed, since a throw here has no
// effect on anything (the webhook response is already sent).
export async function handleInboundTextAgentReply(
  supabase: SupabaseClient,
  params: { contact: Record<string, any>; fromPhone: string; inboundBody: string }
): Promise<void> {
  const { contact, fromPhone, inboundBody } = params;
  const contactId: string = contact.id;

  try {
    // 1. Human-takeover check.
    const { data: freshContact } = await supabase
      .from("contacts")
      .select("ai_texting_paused_at")
      .eq("id", contactId)
      .single();
    if (freshContact?.ai_texting_paused_at) {
      console.log("[textAgent] paused for contact, skipping:", contactId);
      return;
    }

    // 2. Loop guard: cap AI-sent replies to this contact in the last 24h.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: recentAiReplies } = await supabase
      .from("message_queue")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId)
      .eq("direction", "outbound")
      .gte("scheduled_at", since)
      .contains("metadata", { sent_by: "ai_text_agent" });
    if ((recentAiReplies ?? 0) >= LOOP_GUARD_LIMIT) {
      await supabase.from("contacts").update({ ai_texting_paused_at: new Date().toISOString() }).eq("id", contactId);
      await notifyAdmin(`[text-agent] paused on ${contact.full_name ?? fromPhone} (${fromPhone}) — hit the 24h reply cap, check the thread`);
      return;
    }

    // 3. Build conversation history for Claude. Scoped to message_type=sms
    //    only — this contact's row can also carry "telegram"/"email" rows
    //    (e.g. internal booking-reminder notifications queued to Kornél but
    //    stamped with the lead's own contact_id) which default to
    //    direction='outbound' and would otherwise get fed to Claude as
    //    things it supposedly already told this person over text.
    const { data: history } = await supabase
      .from("message_queue")
      .select("message_content, direction, metadata")
      .eq("contact_id", contactId)
      .eq("message_type", "sms")
      .in("status", ["sent", "received"])
      .order("scheduled_at", { ascending: true })
      .limit(HISTORY_LIMIT);

    // Whether the AI itself has ever replied to this contact before — NOT
    // the same as "is there a prior outbound message," since outbound rows
    // also include Kornél's own scripted cold-outreach texts. Computed here,
    // not left for the model to infer, so the AI-disclosure rule is reliable
    // even when a cold-outreach opener already sits earlier in the thread.
    const hasPriorAiReply = (history ?? []).some((m) => (m.metadata as any)?.sent_by === "ai_text_agent");
    const system = `${TEXT_AGENT_SYSTEM_PROMPT}

## Context for this reply
${hasPriorAiReply
  ? "You have already introduced yourself as VargaFlow's AI assistant to this person in an earlier reply — do not repeat that disclosure, just reply normally."
  : "You have NOT yet introduced yourself as an AI to this person, even if earlier messages already appear in the conversation below (those may be Kornél's own scripted outreach texts, not anything you said). Your reply must open with a brief, natural AI disclosure before anything else."}`;

    const messages: ClaudeMessage[] = (history ?? []).map((m) => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      content: m.message_content,
    }));
    // The just-received inbound message was already logged by inbound-sms
    // before this ran, so it's already the last row in `history` — don't
    // duplicate it here.
    if (messages.length === 0 || messages[messages.length - 1].content !== inboundBody) {
      messages.push({ role: "user", content: inboundBody });
    }

    // 4. Bounded tool-use loop.
    let replyText = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await callClaude(system, messages);
      if (response.stop_reason !== "tool_use") {
        replyText = extractText(response.content);
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTextAgentTool(block.name, block.input ?? {}, { fromPhone, supabase, contact });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        if (block.name === "flag_not_interested") {
          const preview = inboundBody.slice(0, 150) + (inboundBody.length > 150 ? "…" : "");
          await notifyAdmin(`[DNC-AI] text agent flagged ${contact.full_name ?? fromPhone} (${fromPhone}) not interested | "${preview}"`);
        }
      }
      messages.push({ role: "user", content: toolResults });

      if (round === MAX_TOOL_ROUNDS - 1) {
        // Ran out of rounds without a final text reply — fall back honestly
        // rather than sending nothing.
        replyText = "Sorry, having some trouble on my end right now — Kornél will follow up personally.";
      }
    }

    if (!replyText) return;

    // 5. Re-check the pause flag right before sending (best-effort race guard
    //    against Kornél jumping in mid-generation).
    const { data: recheck } = await supabase
      .from("contacts")
      .select("ai_texting_paused_at")
      .eq("id", contactId)
      .single();
    if (recheck?.ai_texting_paused_at) {
      console.log("[textAgent] paused mid-generation, dropping reply:", contactId);
      return;
    }

    // 6. Send + log.
    const fromNumber = await getTwilioFromNumber(supabase, ADMIN_BUSINESS_ID);
    const { sid } = await sendSmsNow({ to: fromPhone, from: fromNumber, body: replyText });

    const now = new Date().toISOString();
    await supabase.from("message_queue").insert({
      contact_id: contactId,
      business_id: contact.business_id ?? null,
      message_type: "sms",
      message_content: replyText,
      scheduled_at: now,
      sent_at: now,
      status: "sent",
      direction: "outbound",
      metadata: { to: fromPhone, twilio_sid: sid, sent_by: "ai_text_agent" },
    });

    await supabase.from("activity_log").insert({
      contact_id: contactId,
      business_id: contact.business_id ?? null,
      activity_type: "message_sent",
      description: `AI text agent replied: "${replyText.slice(0, 80)}${replyText.length > 80 ? "…" : ""}"`,
      metadata: { to: fromPhone, twilio_sid: sid },
    });
  } catch (err) {
    console.error("[textAgent] failed:", err);
    try {
      await notifyAdmin(`[text-agent] failed to reply to ${fromPhone}: ${err instanceof Error ? err.message : String(err)}`);
    } catch (notifyErr) {
      console.error("[textAgent] failed to notify admin of failure:", notifyErr);
    }
  }
}
