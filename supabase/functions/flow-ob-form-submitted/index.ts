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
 * public URL (vargaflow.com/onboarding-form). After storing the submission, we
 * attempt to auto-match to an existing contact by email or phone. If matched,
 * we run the existing post-submission flow (tag removal, stage change, GMB SMS).
 * If unmatched, we still store the submission and notify Kornel.
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

    const bid = contact?.business_id ?? null;

    // Always store the submission.
    await supabase.from("onboarding_submissions").insert({
      contact_id: contact?.id ?? null,
      business_id: bid,
      data: formData,
    });

    // If we matched to a contact, run the existing post-submission flow.
    if (contact) {
      const settings = await getSettings(supabase, bid);
      const myName = settings.my_name || "Kornel";
      const myPhone = settings.my_phone || "";
      const gmbReviewLink = settings.gmb_review_link || "[GMB tutorial link]";

      const firstName = contact.full_name?.split(" ")[0] ?? "there";
      const phone = contact.phone;

      // Remove onboarding form tag
      const currentTags: string[] = Array.isArray(contact.tags) ? contact.tags : [];
      const updatedTags = currentTags.filter((t: string) => t !== "Needs to Fill Out Onboarding Form");

      await supabase
        .from("contacts")
        .update({ tags: updatedTags, stage: "Form Submitted" })
        .eq("id", contact.id);

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
        });
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
        });
      }

      await supabase.from("automation_logs").insert({
        contact_id: contact.id,
        business_id: bid,
        flow: "flow-ob-form-submitted",
        status: "completed",
        ran_at: new Date().toISOString(),
      });
    } else {
      // Unmatched submission — notify Kornel (uses global/default settings since we don't have a business).
      const settings = await getSettings(supabase, null).catch(() => ({ my_phone: "" } as any));
      const myPhone = settings?.my_phone || "";
      if (myPhone) {
        await supabase.from("message_queue").insert({
          contact_id: null,
          business_id: null,
          message_type: "sms",
          message_content: `New onboarding form submission (unmatched). Name: ${formData.full_name ?? "?"}. Business: ${formData.business_name ?? "?"}. Email: ${formData.email ?? "?"}. Review in admin.`,
          scheduled_at: new Date(Date.now() + 30 * 1000).toISOString(),
          status: "pending",
          metadata: { to: myPhone },
        });
      }

      await supabase.from("automation_logs").insert({
        contact_id: null,
        business_id: null,
        flow: "flow-ob-form-submitted",
        status: "completed_unmatched",
        ran_at: new Date().toISOString(),
      });
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
