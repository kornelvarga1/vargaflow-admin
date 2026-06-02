import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authErrorResponse, getSettings, requireAdmin, resolveTemplate } from "../_shared/utils.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_BUSINESS_ID = "79036fbb-997c-4f7b-b46f-ccc97a64c38d";
const WARM_SEQUENCE_NAME = "Outreach — Leads Incentive (Warm)";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-auth",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    await requireAdmin(req);

    const { contact_id } = await req.json();
    if (!contact_id) return json(400, { error: "contact_id required" });

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .select("id, full_name, phone, email, business_id, dnd_sms")
      .eq("id", contact_id)
      .maybeSingle();
    if (contactErr || !contact) return json(404, { error: "contact not found" });
    if (!contact.phone) return json(400, { error: "contact has no phone number" });
    if (contact.dnd_sms) return json(400, { error: "contact has dnd_sms=true" });

    const { data: sequence, error: seqErr } = await supabase
      .from("sequences")
      .select("id, is_active")
      .eq("name", WARM_SEQUENCE_NAME)
      .single();
    if (seqErr || !sequence) return json(404, { error: `sequence not found: ${WARM_SEQUENCE_NAME}` });
    if (!sequence.is_active) return json(400, { error: "warm sequence is inactive" });

    // Idempotent: return early if already enrolled (active or paused).
    const { data: existingCs } = await supabase
      .from("contact_sequences")
      .select("id, status")
      .eq("contact_id", contact_id)
      .eq("sequence_id", sequence.id)
      .in("status", ["active", "paused"])
      .maybeSingle();
    if (existingCs) {
      return json(200, { enrolled: false, already_active: true, contact_sequence_id: existingCs.id });
    }

    const { data: steps, error: stepsErr } = await supabase
      .from("sequence_steps")
      .select("*")
      .eq("sequence_id", sequence.id)
      .order("step_order");
    if (stepsErr || !steps || steps.length === 0) {
      return json(500, { error: "warm sequence has no steps" });
    }

    const now = new Date().toISOString();

    const { data: cs, error: csErr } = await supabase
      .from("contact_sequences")
      .insert({
        contact_id,
        sequence_id: sequence.id,
        current_step: 0,
        status: "active",
        started_at: now,
      })
      .select("id")
      .single();
    if (csErr || !cs) {
      return json(500, { error: `enrollment failed: ${csErr?.message}` });
    }

    const settingsBid = contact.business_id ?? ADMIN_BUSINESS_ID;
    const settings = await getSettings(supabase, settingsBid);
    const step1 = steps[0];

    const { error: queueErr } = await supabase.from("message_queue").insert({
      contact_id,
      contact_sequence_id: cs.id,
      business_id: contact.business_id,
      message_type: step1.message_type,
      message_content: resolveTemplate(step1.message_template, contact, settings),
      to_phone: contact.phone,
      scheduled_at: now,
      status: "pending",
      metadata: { to: contact.phone, step_order: 1 },
    });
    if (queueErr) {
      await supabase.from("contact_sequences").update({ status: "stopped" }).eq("id", cs.id);
      return json(500, { error: `queue insert failed: ${queueErr.message}` });
    }

    try {
      await supabase.from("activity_log").insert({
        contact_id,
        business_id: contact.business_id,
        activity_type: "automation_triggered",
        description: `Enrolled in warm follow-up sequence (${WARM_SEQUENCE_NAME})`,
      });
    } catch { /* non-fatal */ }

    return json(200, { enrolled: true, contact_sequence_id: cs.id });
  } catch (err) {
    const authResp = authErrorResponse(err, CORS);
    if (authResp) return authResp;
    console.error("[flow-outreach-warm-enroll] fatal:", err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
