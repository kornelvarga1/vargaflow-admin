// Retell "inbound call webhook" — fires before the agent starts talking on
// an inbound call. We use it purely to inject the caller's own number as a
// real dynamic variable ({{caller_number}}), since Retell's documented
// "automatic" system variable ({{from_number}}) does not actually resolve
// inside a retell-llm's general_prompt for inbound calls (tested 2026-08-25:
// it came through as the literal unresolved string). Custom dynamic
// variables set via this webhook DO resolve correctly — same mechanism the
// pre-existing "Alex" sales agent already relies on for {{lead_first_name}}
// etc., just sourced here instead of from a Create Phone Call API call.
//
// See: https://docs.retellai.com/features/inbound-call-webhook
//      https://docs.retellai.com/features/secure-webhook

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retell-signature",
};

async function verifySignature(rawBody: string, signatureHeader: string | null, apiKey: string): Promise<boolean> {
  if (!signatureHeader) return false;
  const match = signatureHeader.match(/^v=(\d+),d=(.+)$/);
  if (!match) return false;
  const [, timestamp, digest] = match;

  const fiveMinutesMs = 5 * 60 * 1000;
  if (Math.abs(Date.now() - Number(timestamp)) > fiveMinutesMs) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody + timestamp),
  );
  const expected = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== digest.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ digest.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const rawBody = await req.text();
  const apiKey = Deno.env.get("RETELL_API_KEY")!;
  const signatureHeader = req.headers.get("x-retell-signature");

  if (!(await verifySignature(rawBody, signatureHeader, apiKey))) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = JSON.parse(rawBody);

  if (body.event === "call_inbound") {
    const fromNumber = body.call_inbound?.from_number ?? "";
    return new Response(
      JSON.stringify({
        call_inbound: {
          dynamic_variables: { caller_number: fromNumber },
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Unrecognized event type (e.g. chat_inbound) — no-op, let Retell use defaults.
  return new Response(JSON.stringify({}), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
