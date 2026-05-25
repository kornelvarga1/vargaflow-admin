import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authErrorResponse, getSettings, requireAdmin, resolveTemplate } from "../_shared/utils.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OUTREACH_PIPELINE = "Outreach";

const SEQUENCE_BY_ANGLE: Record<string, string> = {
  free_website: "Outreach — Free Website Incentive",
  leads_incentive: "Outreach — Leads Incentive",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-auth",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function isDNC(supabase: any, phone: string): Promise<boolean> {
  if (!phone) return false;
  const { data, error } = await supabase
    .from("dnc_list")
    .select("id")
    .eq("phone", phone)
    .maybeSingle();
  if (error) {
    console.error(`[enroll-outreach] DNC lookup error for ${phone}:`, error.message);
    return true; // fail-closed
  }
  return !!data;
}

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

    const { contact_ids, workflow } = await req.json();

    if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
      return json(400, { error: "contact_ids must be a non-empty array" });
    }
    const sequenceName = SEQUENCE_BY_ANGLE[workflow];
    if (!sequenceName) {
      return json(400, { error: `invalid workflow: ${workflow}` });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: sequence, error: seqErr } = await supabase
      .from("sequences")
      .select("id")
      .eq("name", sequenceName)
      .single();
    if (seqErr || !sequence) {
      return json(404, { error: `sequence not found: ${sequenceName}` });
    }

    const { data: steps, error: stepsErr } = await supabase
      .from("sequence_steps")
      .select("*")
      .eq("sequence_id", sequence.id)
      .order("step_order");
    if (stepsErr || !steps || steps.length === 0) {
      return json(500, { error: "sequence has no steps" });
    }

    const { data: contacts, error: contactsErr } = await supabase
      .from("contacts")
      .select("id, full_name, phone, pipeline, outreach_angle, business_id")
      .in("id", contact_ids);
    if (contactsErr) {
      return json(500, { error: `contacts fetch failed: ${contactsErr.message}` });
    }

    const enrolled: { id: string; name: string }[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];

    for (const id of contact_ids) {
      const contact = contacts?.find((c: any) => c.id === id);
      const name = contact?.full_name ?? id;

      if (!contact) {
        skipped.push({ id, name, reason: "contact not found" });
        continue;
      }
      if (!contact.phone) {
        skipped.push({ id, name, reason: "no phone number" });
        continue;
      }
      if (await isDNC(supabase, contact.phone)) {
        skipped.push({ id, name, reason: "phone is on DNC list" });
        continue;
      }
      if (contact.outreach_angle) {
        skipped.push({
          id,
          name,
          reason: `already enrolled (${contact.outreach_angle})`,
        });
        continue;
      }

      const { error: updateErr } = await supabase
        .from("contacts")
        .update({
          pipeline: OUTREACH_PIPELINE,
          stage: "Sequence Active",
          outreach_angle: workflow,
          stage_entered_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (updateErr) {
        skipped.push({ id, name, reason: `contact update failed: ${updateErr.message}` });
        continue;
      }

      const { data: cs, error: csErr } = await supabase
        .from("contact_sequences")
        .insert({
          contact_id: id,
          sequence_id: sequence.id,
          current_step: 0,
          status: "active",
        })
        .select("id")
        .single();
      if (csErr || !cs) {
        skipped.push({ id, name, reason: `sequence enroll failed: ${csErr?.message}` });
        continue;
      }

      // Resolve {{my_name}} etc. against this contact's business settings.
      // Without this, templates land in message_queue with literal mustache braces.
      const settings = await getSettings(supabase, contact.business_id);

      // Only queue step 1. Each subsequent step is queued by cron-message-sender
      // after the previous step actually sends — so follow-up timing is relative
      // to send time, not enrollment time, and the daily cap only governs first sends.
      const step1 = steps[0];
      const sendAt = new Date();
      sendAt.setHours(sendAt.getHours() + (step1.delay_hours ?? 0));
      sendAt.setMinutes(sendAt.getMinutes() + (step1.delay_minutes ?? 0));
      const { error: queueErr } = await supabase.from("message_queue").insert({
        contact_id: id,
        contact_sequence_id: cs.id,
        business_id: contact.business_id,
        message_type: step1.message_type,
        message_content: resolveTemplate(step1.message_template, contact, settings),
        to_phone: contact.phone,
        scheduled_at: sendAt.toISOString(),
        status: "pending",
        metadata: { to: contact.phone, step_order: 1 },
      });
      if (queueErr) {
        await supabase
          .from("contact_sequences")
          .update({ status: "stopped" })
          .eq("id", cs.id);
        skipped.push({ id, name, reason: `queue insert failed: ${queueErr.message}` });
        continue;
      }

      enrolled.push({ id, name });
    }

    return json(200, { enrolled, skipped });
  } catch (err) {
    const authResp = authErrorResponse(err, CORS);
    if (authResp) return authResp;
    console.error("[enroll-outreach] fatal:", err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
