import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function getSettings(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("settings")
    .select("*")
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
    contact_company: contact.company_name ?? "",
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
  settings: Record<string, any>
) {
  if (steps.length === 0) return;

  const now = new Date();

  const rows = steps.map((step) => {
    const sendAt = new Date(now);
    sendAt.setHours(sendAt.getHours() + (step.delay_hours ?? 0));
    sendAt.setMinutes(sendAt.getMinutes() + (step.delay_minutes ?? 0));

    return {
      contact_id: contactId,
      message_type: step.message_type,
      message_content: resolveTemplate(step.message_template, contact, settings),
      scheduled_at: sendAt.toISOString(),
      status: "pending",
    };
  });

  const { error } = await supabase.from("message_queue").insert(rows);
  if (error) throw new Error(`Queue insert error: ${error.message}`);
}