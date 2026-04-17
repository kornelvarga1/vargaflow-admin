// Public unsubscribe endpoint for email opt-out. Deployed with --no-verify-jwt.
//
// Accepts:
//   GET  /unsubscribe?c=<contact_uuid>   — human clicks the footer link
//   POST /unsubscribe?c=<contact_uuid>   — Gmail/Outlook RFC 8058 One-Click Unsubscribe
//
// Sets contacts.dnd_email = true for the given contact_id. Never returns an
// error to the browser — always responds with a friendly confirmation (or a
// generic "request received" page) so we don't leak whether a given UUID maps
// to a real contact.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const html = (body: string) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribe</title>
   <meta name="viewport" content="width=device-width, initial-scale=1">
   <style>
     body { font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 10vh auto; padding: 2rem; text-align: center; color: #222; }
     h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
     p { color: #555; line-height: 1.5; }
   </style></head>
   <body>${body}</body></html>`,
  { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
);

serve(async (req) => {
  const url = new URL(req.url);
  const contactId = url.searchParams.get("c") ?? "";

  // Always respond 200 with a friendly page, even for invalid requests —
  // avoids leaking info about which UUIDs are real contacts.
  if (!UUID_RE.test(contactId)) {
    return html("<h1>Request received</h1><p>If this email was sent to you, you will no longer receive further messages.</p>");
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    await supabase.from("contacts").update({ dnd_email: true }).eq("id", contactId);
  } catch (err) {
    console.error("[unsubscribe] update failed:", err);
    // Swallow — user gets the same page either way. Failures logged for ops.
  }

  return html("<h1>You've been unsubscribed</h1><p>You won't receive further emails from this sender.</p><p style=\"font-size:0.85em;color:#888;margin-top:2rem\">If this was a mistake, reply to any recent email from us and we'll re-enable delivery.</p>");
});
