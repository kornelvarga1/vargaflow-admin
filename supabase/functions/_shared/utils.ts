import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function getSettings(supabase: SupabaseClient, businessId: string) {
  const { data, error } = await supabase
    .from("settings")
    .select("*")
    .eq("business_id", businessId)
    .single();
  if (error) throw new Error(`Settings fetch error: ${error.message}`);
  return data;
}

export async function getSequenceSteps(supabase: SupabaseClient, sequenceName: string) {
  const { data: sequence, error: seqError } = await supabase
    .from("sequences")
    .select("id, is_active")
    .eq("name", sequenceName)
    .single();

  if (seqError) throw new Error(`Sequence fetch error: ${seqError.message}`);
  if (!sequence.is_active) return [];

  const { data: steps, error: stepsError } = await supabase
    .from("sequence_steps")
    .select("*")
    .eq("sequence_id", sequence.id)
    .order("step_order");

  if (stepsError) throw new Error(`Steps fetch error: ${stepsError.message}`);
  return steps;
}

export function resolveTemplate(
  template: string,
  contact: Record<string, any>,
  settings: Record<string, any>
): string {
  const vars: Record<string, string> = {
    contact_first_name: contact.full_name?.split(" ")[0] ?? "",
    contact_name: contact.full_name ?? "",
    contact_phone: contact.phone ?? "",
    contact_email: contact.email ?? "",
    contact_company: settings.company_name ?? "",
    my_name: settings.my_name ?? "",
    my_phone: settings.my_phone ?? "",
    my_email: settings.my_email ?? "",
    company_name: settings.company_name ?? "",
    website_url: settings.website_url ?? "",
    software_explanation_video: settings.software_explanation_video ?? "",
    testimonials_link: settings.testimonials_link ?? "",
    case_study_link: settings.case_study_link ?? "",
    demo_calendar_link: settings.demo_calendar_link ?? "",
    launch_call_calendar_link: settings.launch_call_calendar_link ?? "",
    onboarding_form_link: settings.onboarding_form_link ?? "",
    instagram_url: settings.instagram_url ?? "",
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export async function queueSteps(
  supabase: SupabaseClient,
  contactId: string,
  steps: any[],
  contact: Record<string, any>,
  settings: Record<string, any>,
  businessId: string
) {
  if (steps.length === 0) return;

  const now = new Date();

  const rows = steps.map((step) => {
    const sendAt = new Date(now);
    sendAt.setHours(sendAt.getHours() + (step.delay_hours ?? 0));
    sendAt.setMinutes(sendAt.getMinutes() + (step.delay_minutes ?? 0));

    const to = step.message_type === "email" ? contact.email : contact.phone;

    return {
      contact_id: contactId,
      business_id: businessId,
      message_type: step.message_type,
      message_content: resolveTemplate(step.message_template, contact, settings),
      scheduled_at: sendAt.toISOString(),
      status: "pending",
      metadata: step.message_type === "email"
        ? { to, subject: `Message from ${settings.company_name ?? "your contractor"}` }
        : { to },
    };
  });

  const { error } = await supabase.from("message_queue").insert(rows);
  if (error) throw new Error(`Queue insert error: ${error.message}`);
}

export async function cancelPendingMessages(
  supabase: SupabaseClient,
  contactId: string
): Promise<number> {
  const { data, error } = await supabase
    .from("message_queue")
    .update({ status: "cancelled" })
    .eq("contact_id", contactId)
    .eq("status", "pending")
    .select("id");

  if (error) console.error(`Cancel pending messages error: ${error.message}`);
  return data?.length ?? 0;
}

export async function hasPendingMessages(
  supabase: SupabaseClient,
  contactId: string
): Promise<boolean> {
  const { count, error } = await supabase
    .from("message_queue")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .eq("status", "pending");

  if (error) console.error(`Check pending messages error: ${error.message}`);
  return (count ?? 0) > 0;
}