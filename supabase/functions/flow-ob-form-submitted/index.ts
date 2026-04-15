import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSettings } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Onboarding form submission handler.
 *
 * Accepts the full form payload. No contact_id required — the form is a plain
 * public URL. Critical path: store the submission. Everything else (notifications,
 * tag/stage updates, automation logs) is best-effort and won't fail the request.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const formData = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Try to auto-match to an existing contact by email, then phone.
    let contact: any = null;
    try {
      if (formData.email) {
        const { data } = await supabase
          .from("contacts")
          .select("*")
          .eq("email", formData.email)
          .limit(1)
          .maybeSingle();
        if (data) contact = data;
      }
      if (!contact && formData.business_phone) {
        const { data } = await supabase
          .from("contacts")
          .select("*")
          .eq("phone", formData.business_phone)
          .limit(1)
          .maybeSingle();
        if (data) contact = data;
      }
    } catch (matchErr) {
      console.error("Contact auto-match failed:", matchErr);
    }

    const bid = contact?.business_id ?? null;

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
        // Skip getSettings entirely if we don't have a business_id — avoids a
        // guaranteed "invalid uuid" error on the eq() call.
        const settings = bid ? await getSettings(supabase, bid).catch(() => null as any) : null;
        const myName = settings?.my_name || "Kornel";
        const myPhone = settings?.my_phone || "";
        const gmbReviewLink = settings?.gmb_review_link || "[GMB tutorial link]";

        const firstName = contact.full_name?.split(" ")[0] ?? "there";
        const phone = contact.phone;

        // Remove onboarding form tag + move stage
        const currentTags: string[] = Array.isArray(contact.tags) ? contact.tags : [];
        const updatedTags = currentTags.filter((t: string) => t !== "Needs to Fill Out Onboarding Form");

        await supabase
          .from("contacts")
          .update({ tags: updatedTags, stage: "Form Submitted" })
          .eq("id", contact.id)
          .then(({ error }) => { if (error) console.error("Contact update failed:", error); });

        // Internal notification
        if (myPhone) {
          await supabase.from("message_queue").insert({
            contact_id: contact.id,
            business_id: bid,
            message_type: "sms",
            message_content: `${contact.full_name} just submitted their onboarding form. Email: ${contact.email}. Phone: ${phone}`,
            scheduled_at: new Date(Date.now() + 30 * 1000).toISOString(),
            status: "pending",
            metadata: { to: myPhone },
          }).then(({ error }) => { if (error) console.error("Internal notif failed:", error); });
        }

        // SMS to client — GMB access request
        if (phone) {
          await supabase.from("message_queue").insert({
            contact_id: contact.id,
            business_id: bid,
            message_type: "sms",
            message_content: `${firstName}, thank you for submitting your onboarding form! Next step — please provide us manager access to your Google My Business page. Here's a 2-minute video tutorial on how to do this: ${gmbReviewLink} — ${myName}`,
            scheduled_at: new Date(Date.now() + 60 * 1000).toISOString(),
            status: "pending",
            metadata: { to: phone },
          }).then(({ error }) => { if (error) console.error("GMB SMS failed:", error); });
        }

        await supabase.from("automation_logs").insert({
          contact_id: contact.id,
          business_id: bid,
          flow: "flow-ob-form-submitted",
          status: "completed",
          ran_at: new Date().toISOString(),
        }).then(({ error }) => { if (error) console.error("Automation log failed:", error); });
      } catch (flowErr) {
        console.error("Matched-contact flow failed (non-fatal):", flowErr);
      }
    } else {
      // Unmatched — notify Kornel via whatever my_phone is configured anywhere in settings.
      try {
        const { data: anySettings } = await supabase
          .from("settings")
          .select("my_phone")
          .not("my_phone", "is", null)
          .limit(1)
          .maybeSingle();
        const myPhone = (anySettings as any)?.my_phone || "";
        if (myPhone) {
          await supabase.from("message_queue").insert({
            message_type: "sms",
            message_content: `New onboarding form submission (unmatched). Name: ${formData.full_name ?? "?"}. Business: ${formData.business_name ?? "?"}. Email: ${formData.email ?? "?"}. Review in admin.`,
            scheduled_at: new Date(Date.now() + 30 * 1000).toISOString(),
            status: "pending",
            metadata: { to: myPhone },
          }).then(({ error }) => { if (error) console.error("Unmatched notif failed:", error); });
        }
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
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
