// Starts a Retell web call (talk in the browser) for one of a fixed set of demo
// lines on kornelvarga.com. Exists because European visitors often cannot dial
// the US demo numbers from their mobile plans.
//
// The browser sends a line key, never an agent id: this function only ever
// starts calls for the lines below, so it cannot be used to run arbitrary
// agents on Kornél's Retell account. The agent is resolved from the phone
// number at request time because deploy scripts recreate agents (and change
// their ids) whenever a published LLM is edited.
//
// Deploy with --no-verify-jwt: it is called anonymously from a public page.

const LINES: Record<string, string> = {
  plumbing: "+16562460255",
  roofing: "+12132385364",
  kornel: "+3197006533490",
};

// Browsers always send Origin on a cross-origin POST. A script can fake it, so
// this is a speed bump against hotlinking, not access control; the fixed line
// list above is what actually limits what can be started.
const ALLOWED_ORIGINS = new Set([
  "https://kornelvarga.com",
  "https://www.kornelvarga.com",
  "http://localhost:8080",
]);

const MAX_WEB_CALLS_PER_HOUR = 20;

async function countRecentWebCalls(headers: Record<string, string>): Promise<number | null> {
  try {
    const res = await fetch("https://api.retellai.com/v2/list-calls", {
      method: "POST",
      headers,
      body: JSON.stringify({
        filter_criteria: {
          call_type: ["web_call"],
          start_timestamp: { lower_threshold: Date.now() - 60 * 60 * 1000 },
        },
        limit: MAX_WEB_CALLS_PER_HOUR + 1,
      }),
    });
    if (!res.ok) return null;
    const calls = await res.json();
    return Array.isArray(calls) ? calls.length : null;
  } catch {
    return null;
  }
}

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://kornelvarga.com",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(status: number, body: unknown, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, origin);
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return json(403, { error: "forbidden" }, origin);

  let line = "";
  try {
    line = String((await req.json())?.line ?? "");
  } catch {
    return json(400, { error: "invalid body" }, origin);
  }
  const number = LINES[line];
  if (!number) return json(400, { error: "unknown line" }, origin);

  const apiKey = Deno.env.get("RETELL_API_KEY")!;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const numRes = await fetch(`https://api.retellai.com/get-phone-number/${encodeURIComponent(number)}`, { headers });
  const numData = await numRes.json();
  const agentId = numData?.inbound_agents?.[0]?.agent_id ?? numData?.inbound_agent_id;
  if (!numRes.ok || !agentId) {
    console.error("[demo-web-call] no agent bound to", number, numData);
    return json(502, { error: "demo line unavailable" }, origin);
  }

  // Cost guard: every web call bills Retell minutes, and this endpoint is
  // anonymous. Cap how many browser calls can start per hour across all demo
  // lines, counted from Retell itself so no table is needed. If the count
  // cannot be read, fail open rather than break the demo for a real visitor.
  const recent = await countRecentWebCalls(headers);
  if (recent !== null && recent >= MAX_WEB_CALLS_PER_HOUR) {
    console.warn(`[demo-web-call] hourly cap hit (${recent})`);
    return json(429, { error: "busy, try again later" }, origin);
  }

  const callRes = await fetch("https://api.retellai.com/v2/create-web-call", {
    method: "POST",
    headers,
    body: JSON.stringify({ agent_id: agentId, metadata: { source: "kornelvarga.com", line } }),
  });
  const callData = await callRes.json();
  if (!callRes.ok || !callData?.access_token) {
    console.error("[demo-web-call] create-web-call failed", callData);
    return json(502, { error: "could not start call" }, origin);
  }

  return json(200, { access_token: callData.access_token }, origin);
});
