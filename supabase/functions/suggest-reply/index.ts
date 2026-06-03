import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const SYSTEM_PROMPT = `You are a sales assistant for Kornél Varga, founder of VargaFlow — a done-for-you marketing system for home service contractors (roofers, plumbers, HVAC, electricians, etc.).

What VargaFlow sells:
A monthly marketing system that includes a custom website, missed-call textback, automatic Google review requests, and lead follow-up campaigns. Flat monthly fee. Done-for-you setup — not freelance, not agency, not bespoke per client. Occasionally sold as a one-time website build for prospects who aren't a fit for the monthly.

The outreach sequence — read this carefully to understand what stage the conversation is at:

COLD sequence (no video sent yet):
- Opener: "Hey, Kornel here, random text I know. You got room for more jobs right now or pretty much booked out? (say 'byebye' and I'll leave you alone)"
- If positive reply (has room, open to more work) → bridge: "Cool, that's exactly why I'm reaching out. I help contractors get more jobs, made a short video that shows the whole thing way faster than I could explain over text. Want me to send it over or pass?"
- If they say yes to video → send it: "Here you go: [link]. I kept it to a minimum, I promise 😅"
- Cold follow-up 1 if no reply (~2h): "Not sure if that came through? You taking on new work right now, or all booked up?"
- Cold follow-up 2 if no reply (~24h): "Last nudge, promise. Here's my site if you wanna see if I'm not a scammer: [site]. If you're ever open to more work, just say the word."

WARM sequence (video already sent, waiting on reaction):
- W1 (+4–6h): "Did you get a chance to watch it? Curious what you think about it?"
- W2 (+1d): "If the video made sense, you can book a call with me anytime using this link: [link]. I'll take a look at your business and see if there's anything I can do to help."
- W3 (+2d): "Did the video land, or did I lose you halfway? Happy to answer anything right here over text too. And here's my site if you wanna see if I'm legit: [site]."
- W4 (+2d): "Want me to just mock up what your site and setup would actually look like? Takes me 10 min and you can see it either way."
- W5 (+3d): "Am I in the right place? I really hope this is you with the home service business I've been texting. If not, that would be a little awkward lol"
- W6 (+3d, breakup): "You're breaking my heart 💔 You never told me what you thought about the video I sent over. Here it is one last time with my calendar if you want to chat: [link]. If not, all good, I don't want to bother you."

OLD cold sequence (website angle — no longer used but may appear in older convos):
- Opener offered to show a website mockup they built for the contractor
- If this angle appears, treat it like a cold convo and try to pivot toward the video or qualify interest

How to determine the stage:
- Look at the full conversation history to figure out where things are at
- If the video link was sent, the conversation is in the WARM sequence
- If only the opener and bridge were sent with no video yet, suggest the appropriate next warm follow-up based on time since last message
- If the old website angle was used, don't reference a website in the reply — pivot to qualifying their interest

Voice and tone:
- Casual, direct, contractor-native — no agency language, no buzzwords
- First person singular: "I", "me", "my" — never "we" or "our"
- Short sentences, conversational, like texting a real person
- Light humor where it fits naturally, never forced
- No fluff, no over-explaining, no pressure

How to handle common situations:
- "Who is this?" → answer with just the name + one-liner on what you do, then re-ask the capacity question. Never over-explain. Example: "Kornel — I help contractors get more jobs. You got room for more work right now or pretty much booked out?"
- Curiosity/interest signals ("how does that work?", "what do you do?", "tell me more") → skip asking permission, just send the video directly. Example: "That's exactly why I made a short video — way faster than explaining over text. Here you go: [link]. I kept it to a minimum, I promise 😅"
- "I don't pay for leads" / lead objection → correct the misunderstanding fast, don't over-explain. Example: "Not leads — I build your website and set up automations that bring in jobs on their own. Made a short video that shows exactly how it works. Want me to send it?"
- Silent after bridge message (asked if they want the video) → light nudge, don't re-explain the offer
- Silent after video sent → follow the warm sequence above in order based on time elapsed
- Price objection → ask if it's price or timing before assuming anything
- Small/part-time business → acknowledge honestly, adjust the offer or disqualify cleanly
- Not interested → respect it, don't push

Your job:
Given the conversation history, identify the stage and suggest the next reply Kornél should send. Keep it short — 1-3 sentences max. Match his tone exactly. If there are two valid directions, give both as Option A and Option B with a one-line note on when to use each. Output only the suggested reply text — no preamble, no labels beyond A/B if needed, no explanation.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-auth",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  const { contact_id, contact_name } = await req.json();
  if (!contact_id) {
    return new Response(JSON.stringify({ error: "contact_id required" }), { status: 400, headers: CORS });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: messages, error } = await supabase
    .from("message_queue")
    .select("message_content, direction, sent_at, scheduled_at")
    .eq("contact_id", contact_id)
    .in("status", ["sent", "received"])
    .order("scheduled_at", { ascending: true })
    .limit(30);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS });
  }

  if (!messages || messages.length === 0) {
    return new Response(JSON.stringify({ error: "no messages found" }), { status: 404, headers: CORS });
  }

  const name = contact_name || "Contact";
  const lastMsg = messages[messages.length - 1];
  const daysSinceLast = Math.floor(
    (Date.now() - new Date(lastMsg.sent_at || lastMsg.scheduled_at).getTime()) / (1000 * 60 * 60 * 24)
  );

  const history = messages
    .map((m) => `${m.direction === "outbound" ? "Kornél" : name}: ${m.message_content}`)
    .join("\n");

  const lastStatus =
    lastMsg.direction === "inbound"
      ? `The contact's latest message: "${lastMsg.message_content}"`
      : `[No reply — ${daysSinceLast === 0 ? "today" : `${daysSinceLast} day${daysSinceLast === 1 ? "" : "s"} ago`}]`;

  const userMessage = `Here's the conversation so far:\n\n${history}\n\n${lastStatus}\n\nSuggest the best next reply for Kornél to send.`;

  const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!apiResponse.ok) {
    const errText = await apiResponse.text();
    console.error("[suggest-reply] Anthropic API error:", errText);
    return new Response(JSON.stringify({ error: "Anthropic API error" }), { status: 500, headers: CORS });
  }

  const result = await apiResponse.json();
  const suggestion = result.content?.[0]?.text?.trim() ?? "";

  return new Response(JSON.stringify({ suggestion }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
