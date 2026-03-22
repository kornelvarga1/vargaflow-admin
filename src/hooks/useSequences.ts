import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

export type Sequence = Tables<"sequences">;
export type SequenceStep = Tables<"sequence_steps">;
export type ContactSequence = Tables<"contact_sequences">;
export type MessageQueue = Tables<"message_queue">;

export function useSequences() {
  return useQuery({
    queryKey: ["sequences"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sequences")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Sequence[];
    },
  });
}

export function useSequenceSteps(sequenceId: string | null) {
  return useQuery({
    queryKey: ["sequence_steps", sequenceId],
    enabled: !!sequenceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sequence_steps")
        .select("*")
        .eq("sequence_id", sequenceId!)
        .order("step_order");
      if (error) throw error;
      return data as SequenceStep[];
    },
  });
}

export function useCreateSequence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (seq: TablesInsert<"sequences">) => {
      const { data, error } = await supabase.from("sequences").insert(seq).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }),
  });
}

export function useUpdateSequence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Sequence> & { id: string }) => {
      const { error } = await supabase.from("sequences").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }),
  });
}

export function useDeleteSequence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Delete steps first, then sequence
      await supabase.from("sequence_steps").delete().eq("sequence_id", id);
      const { error } = await supabase.from("sequences").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }),
  });
}

export function useCreateStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (step: TablesInsert<"sequence_steps">) => {
      const { data, error } = await supabase.from("sequence_steps").insert(step).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["sequence_steps", vars.sequence_id] }),
  });
}

export function useUpdateStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, sequence_id, ...updates }: Partial<SequenceStep> & { id: string; sequence_id: string }) => {
      const { error } = await supabase.from("sequence_steps").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["sequence_steps", vars.sequence_id] }),
  });
}

export function useDeleteStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, sequence_id }: { id: string; sequence_id: string }) => {
      const { error } = await supabase.from("sequence_steps").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["sequence_steps", vars.sequence_id] }),
  });
}

// --- Contact Sequences & Message Queue ---

export function useEnrollContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      contactId,
      sequenceId,
    }: {
      contactId: string;
      sequenceId: string;
    }) => {
      // Check if already enrolled
      const { data: existing } = await supabase
        .from("contact_sequences")
        .select("id")
        .eq("contact_id", contactId)
        .eq("sequence_id", sequenceId)
        .eq("status", "active")
        .maybeSingle();

      if (existing) return existing;

      const { data, error } = await supabase
        .from("contact_sequences")
        .insert({
          contact_id: contactId,
          sequence_id: sequenceId,
          status: "active",
          current_step: 0,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact_sequences"] });
    },
  });
}

export function useStopContactSequences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) => {
      const { error } = await supabase
        .from("contact_sequences")
        .update({ status: "stopped" })
        .eq("contact_id", contactId)
        .eq("status", "active");
      if (error) throw error;
      // Also cancel pending messages
      const { error: msgError } = await supabase
        .from("message_queue")
        .update({ status: "cancelled" })
        .eq("contact_id", contactId)
        .eq("status", "pending");
      if (msgError) throw msgError;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact_sequences"] });
      qc.invalidateQueries({ queryKey: ["message_queue"] });
    },
  });
}

export function useMessageQueue(status?: string) {
  return useQuery({
    queryKey: ["message_queue", status],
    queryFn: async () => {
      let query = supabase
        .from("message_queue")
        .select("*, contacts(full_name, email, phone)")
        .order("scheduled_at", { ascending: true });
      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });
}

export function useMarkMessageSent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("message_queue")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["message_queue"] }),
  });
}

export function useCreateMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (msg: TablesInsert<"message_queue">) => {
      const { data, error } = await supabase.from("message_queue").insert(msg).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["message_queue"] }),
  });
}

/** Generate messages for a contact when enrolled in a sequence */
export async function generateSequenceMessages(
  contactId: string,
  sequenceId: string,
  contactSequenceId: string
) {
  const { data: steps } = await supabase
    .from("sequence_steps")
    .select("*")
    .eq("sequence_id", sequenceId)
    .order("step_order");

  if (!steps || steps.length === 0) return;

  const { data: contact } = await supabase
    .from("contacts")
    .select("phone, full_name, business_id")
    .eq("id", contactId)
    .single();

  const { data: settings } = await supabase
    .from("settings")
    .select("my_name, company_name, my_email, my_phone, website_url, onboarding_form_link, demo_calendar_link, launch_call_calendar_link")
    .limit(1)
    .single();

  const now = new Date();
  const messages = steps.map((step) => {
    const scheduledAt = new Date(now);
    scheduledAt.setHours(scheduledAt.getHours() + step.delay_hours);
    scheduledAt.setMinutes(scheduledAt.getMinutes() + step.delay_minutes);

    const content = step.message_template
      .replace(/\{\{contact_name\}\}/g, contact?.full_name?.split(' ')[0] || 'there')
      .replace(/\{\{contact_first_name\}\}/g, contact?.full_name?.split(' ')[0] || 'there')
      .replace(/\{\{my_name\}\}/g, settings?.my_name || '')
      .replace(/\{\{company_name\}\}/g, settings?.company_name || '')
      .replace(/\{\{onboarding_form_link\}\}/g, settings?.onboarding_form_link || '')
      .replace(/\{\{my_email\}\}/g, settings?.my_email || '')
      .replace(/\{\{my_phone\}\}/g, settings?.my_phone || '')
      .replace(/\{\{website_url\}\}/g, settings?.website_url || '')
      .replace(/\{\{demo_calendar_link\}\}/g, settings?.demo_calendar_link || '')
      .replace(/\{\{launch_call_calendar_link\}\}/g, settings?.launch_call_calendar_link || '');

    return {
      contact_id: contactId,
      contact_sequence_id: contactSequenceId,
      message_content: content,
      message_type: step.message_type,
      scheduled_at: scheduledAt.toISOString(),
      status: "pending" as const,
      to_phone: contact?.phone ?? null,
      business_id: contact?.business_id ?? null,
    };
  });

  const { error } = await supabase.from("message_queue").insert(messages);
  if (error) throw error;
}
