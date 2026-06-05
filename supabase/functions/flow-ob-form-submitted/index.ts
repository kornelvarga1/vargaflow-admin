import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSettings, normalizePhone, notifyAdmin } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Onboarding form submission handler. No contact_id required — auto-matches by
// email then phone. Critical path: store the submission. Everything else
// (notifications, tag/stage updates, automation logs) is best-effort.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const formData = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Auto-match to an existing contact by email (most recent), then phone.
    // Using .order + .limit + .maybeSingle to be deterministic when duplicates
    // exist — picks the most recently created contact with that email/phone.
    let contact: any = null;
    try {
      if (formData.email) {
        const { data } = await supabase
          .from("contacts")
          .select("*")
          .eq("email", formData.email)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (data) contact = data;
      }
      if (!contact && formData.business_phone) {
        const normalized = normalizePhone(formData.business_phone);
        if (normalized) {
          const { data } = await supabase
            .from("contacts")
            .select("*")
            .eq("phone", normalized)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (data) contact = data;
        }
      }
    } catch (matchErr) {
      console.error("Contact auto-match failed:", matchErr);
    }

    const bid = contact?.business_id ?? Deno.env.get("VARGA_FLOW_ADMIN_BID") ?? null;

    // CRITICAL: store the submission. This must succeed.
    const { error: insertErr } = await supabase.from("onboarding_submissions").insert({
      contact_id: contact?.id ?? null,
      business_id: bid,
      data: formData,
    });
    if (insertErr) throw new Error(`Submission insert failed: ${insertErr.message}`);

    // From here on, everything is best-effort — failures are logged but don't
    // break the submission.
    if (contact) {
      try {
        const settings = await getSettings(supabase, bid).catch(() => null as any);
        const myName = settings?.my_name || "Kornel";
        const gmbReviewLink = settings?.gmb_review_link || "[GMB tutorial link]";

        const firstName = contact.full_name?.split(" ")[0] ?? "there";
        const phone = contact.phone;

        // Remove onboarding form tag + move stage
        const currentTags: string[] = Array.isArray(contact.tags) ? contact.tags : [];
        const updatedTags = currentTags.filter((t: string) => t !== "Needs to Fill Out Onboarding Form");

        const { error: updErr } = await supabase
          .from("contacts")
          .update({ tags: updatedTags, stage: "Form Submitted" })
          .eq("id", contact.id);
        if (updErr) console.error("Contact update failed:", updErr);

        // Internal notification
        await notifyAdmin(`${contact.full_name} just submitted their onboarding form. Email: ${contact.email}. Phone: ${phone}`)
          .catch((e) => console.error("Internal notif failed:", e));

        // SMS to client — GMB access request
        if (phone) {
          const { error: gmbErr } = await supabase.from("message_queue").insert({
            contact_id: contact.id,
            business_id: bid,
            message_type: "sms",
            message_content: `${firstName}, thank you for submitting your onboarding form! Next step — please provide us manager access to your Google My Business page. Here's a 2-minute video tutorial on how to do this: ${gmbReviewLink} — ${myName}`,
            scheduled_at: new Date(Date.now() + 60 * 1000).toISOString(),
            status: "pending",
            metadata: { to: phone },
          });
          if (gmbErr) console.error("GMB SMS failed:", gmbErr);
        }

        const { error: logErr } = await supabase.from("automation_logs").insert({
          contact_id: contact.id,
          business_id: bid,
          flow: "flow-ob-form-submitted",
          status: "completed",
          ran_at: new Date().toISOString(),
        });
        if (logErr) console.error("Automation log failed:", logErr);
      } catch (flowErr) {
        console.error("Matched-contact flow failed (non-fatal):", flowErr);
      }
    } else {
      // Unmatched — notify via Telegram.
      try {
        await notifyAdmin(`New onboarding form submission (unmatched). Name: ${formData.full_name ?? "?"}. Business: ${formData.business_name ?? "?"}. Email: ${formData.email ?? "?"}. Review in admin.`);
      } catch (notifErr) {
        console.error("Unmatched notification failed (non-fatal):", notifErr);
      }
    }

    return new Response(
      JSON.stringify({ success: true, matched: !!contact }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Fatal error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
