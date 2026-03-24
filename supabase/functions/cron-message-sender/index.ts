import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;

// Cache Twilio numbers per business_id within a single cron run
const twilioNumberCache: Record<string, string> = {};

async function getTwilioNumber(
  supabase: ReturnType<typeof createClient>,
  business_id: string
): Promise<string | null> {
  if (twilioNumberCache[business_id]) return twilioNumberCache[business_id];

  const { data } = await supabase
    .from("settings")
    .select("twilio_phone_number")
    .eq("business_id", business_id)
    .single();

  const number = data?.twilio_phone_number ?? null;
  if (number) twilioNumberCache[business_id] = number;
  return number;
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
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio error: ${data.message}`);
}

async function sendEmail(
  to: string,
  subject: string,
  content: string,
  fromEmail: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail || "VargaFlow <hello@vargaflow.com>",
      to,
      subject,
      html: content,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${data.message}`);
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

serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Grab up to 50 pending messages due now
    const { data: messages, error } = await supabase
      .from("message_queue")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_at", new Date().toISOString())
      .limit(50);

    if (error) throw new Error(`Queue fetch error: ${error.message}`);
    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ sent: 0, failed: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let failed = 0;

    for (const msg of messages) {
      // Mark as processing immediately to prevent double-send
      await supabase
        .from("message_queue")
        .update({ status: "processing" })
        .eq("id", msg.id)
        .eq("status", "pending"); // extra guard against race condition

      try {
        if (msg.message_type === "sms") {
          // Use to_phone column first, fall back to metadata.to
          const to = msg.to_phone ?? msg.metadata?.to;
          if (!to) throw new Error(`No phone number for message ${msg.id}`);

          // Get the correct Twilio number for this business
          const fromNumber = msg.business_id
            ? await getTwilioNumber(supabase, msg.business_id)
            : null;

          // Fall back to env var (for your own internal messages)
          const from = fromNumber ?? Deno.env.get("TWILIO_PHONE_NUMBER");
          if (!from) throw new Error(`No Twilio from-number for business ${msg.business_id}`);

          await sendSMS(to, from, msg.message_content);

          await supabase
            .from("message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", msg.id);

          // Log to activity_log
          if (msg.contact_id) {
            await supabase.from("activity_log").insert({
              contact_id: msg.contact_id,
              business_id: msg.business_id,
              activity_type: "message_sent",
              description: `SMS sent: "${msg.message_content.slice(0, 60)}${msg.message_content.length > 60 ? "…" : ""}"`,
            });
          }

        } else if (msg.message_type === "email") {
          const to = msg.metadata?.to ?? msg.to_phone;
          const subject = msg.metadata?.subject ?? "Message from your contractor";
          const fromEmail = msg.metadata?.from_email ?? "hello@vargaflow.com";
          if (!to) throw new Error(`No email address for message ${msg.id}`);

          await sendEmail(to, subject, msg.message_content, fromEmail);

          await supabase
            .from("message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", msg.id);

        } else if (msg.message_type === "function_call") {
          // ── THIS IS THE KEY PIECE ──
          // Chained automations (review step 2, 1-year nurture, reactivation check, etc.)
          // all land here as function_call rows. We invoke the named edge function.
          const functionName = msg.metadata?.function_name;
          const payload = msg.metadata?.payload ?? {};

          if (!functionName) throw new Error(`No function_name in metadata for message ${msg.id}`);

          await invokeFunctionCall(functionName, payload);

          await supabase
            .from("message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", msg.id);

          console.log(`Invoked function: ${functionName} for contact ${msg.contact_id}`);

        } else {
          // Unknown type — mark as failed so it doesn't loop forever
          throw new Error(`Unknown message_type: ${msg.message_type}`);
        }

        sent++;

      } catch (msgErr) {
        failed++;
        await supabase
          .from("message_queue")
          .update({
            status: "failed",
            metadata: {
              ...(msg.metadata ?? {}),
              error: msgErr instanceof Error ? msgErr.message : String(msgErr),
              failed_at: new Date().toISOString(),
            },
          })
          .eq("id", msg.id);

        console.error(`Failed message ${msg.id} (${msg.message_type}):`, msgErr);
      }
    }

    console.log(`Cron run: ${sent} sent, ${failed} failed out of ${messages.length} total`);

    return new Response(
      JSON.stringify({ sent, failed, total: messages.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Cron fatal error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
