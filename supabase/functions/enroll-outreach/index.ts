import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authErrorResponse, getSettings, requireAdmin, resolveTemplate } from "../_shared/utils.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OUTREACH_PIPELINE = "Outreach";
// Admin's business_id — used as fallback when a contact has business_id=NULL,
// so we never accidentally pick up a test-client settings row.
const ADMIN_BUSINESS_ID = "79036fbb-997c-4f7b-b46f-ccc97a64c38d";

const SEQUENCE_BY_ANGLE: Record<string, string> = {
  free_website: "Outreach — Free Website Incentive",
  leads_incentive: "Outreach — Leads Incentive",
  free_trial_incentive: "Outreach — Free Trial Incentive",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-auth",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Batched DNC check for a set of phones — was previously one query per contact
// (up to 50 sequential round trips per enroll batch), which made large enrolls
// slow enough to risk hitting the edge function's execution timeout partway
// through and losing all progress on every batch after it. One query per chunk
// instead; chunked the same way as the contacts fetch to stay under the URL limit.
async function fetchDncPhones(supabase: any, phones: string[]): Promise<Set<string>> {
  const dncPhones = new Set<string>();
  const uniquePhones = [...new Set(phones.filter(Boolean))];
  const CHUNK_SIZE = 200;
  for (let i = 0; i < uniquePhones.length; i += CHUNK_SIZE) {
    const chunk = uniquePhones.slice(i, i + CHUNK_SIZE);
    const { data, error } = await supabase
      .from("dnc_list")
      .select("phone")
      .in("phone", chunk);
    if (error) {
      console.error(`[enroll-outreach] DNC batch lookup error:`, error.message);
      // fail-closed: treat this whole chunk's phones as DNC rather than risk texting them
      chunk.forEach((p) => dncPhones.add(p));
      continue;
    }
    (data ?? []).forEach((d: any) => dncPhones.add(d.phone));
  }
  return dncPhones;
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

    // .in() with hundreds+ of IDs builds a GET request that can exceed Cloudflare's
    // URL length limit and silently return [] (no error) — chunk to stay well under it.
    const CHUNK_SIZE = 200;
    const contacts: any[] = [];
    for (let i = 0; i < contact_ids.length; i += CHUNK_SIZE) {
      const chunk = contact_ids.slice(i, i + CHUNK_SIZE);
      const { data: chunkContacts, error: contactsErr } = await supabase
        .from("contacts")
        .select("id, full_name, phone, pipeline, outreach_angle, business_id")
        .in("id", chunk);
      if (contactsErr) {
        return json(500, { error: `contacts fetch failed: ${contactsErr.message}` });
      }
      contacts.push(...(chunkContacts ?? []));
    }

    const dncPhones = await fetchDncPhones(supabase, contacts.map((c: any) => c.phone));
    const settingsCache = new Map<string, any>();

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
      if (dncPhones.has(contact.phone)) {
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

      try {
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
        // Falls back to ADMIN_BUSINESS_ID when contact.business_id is NULL (the
        // admin convention) — never pick a random row, that could land on a test
        // client's settings (e.g. "Mike / Arizona Roofing Pro").
        const settingsBid = contact.business_id ?? ADMIN_BUSINESS_ID;
        let settings = settingsCache.get(settingsBid);
        if (!settings) {
          settings = await getSettings(supabase, settingsBid);
          settingsCache.set(settingsBid, settings);
        }

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
      } catch (perContactErr) {
        // A single contact throwing (e.g. a settings fetch hiccup) used to crash
        // the whole batch's HTTP response, silently discarding every contact
        // after it too — isolate failures to just this one contact instead.
        console.error(`[enroll-outreach] contact ${id} threw:`, perContactErr);
        skipped.push({
          id,
          name,
          reason: perContactErr instanceof Error ? perContactErr.message : String(perContactErr),
        });
      }
    }

    return json(200, { enrolled, skipped });
  } catch (err) {
    const authResp = authErrorResponse(err, CORS);
    if (authResp) return authResp;
    console.error("[enroll-outreach] fatal:", err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
