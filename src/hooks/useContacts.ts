import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";

export type Contact = Tables<"contacts">;
export type ContactInsert = TablesInsert<"contacts">;
export type ContactUpdate = TablesUpdate<"contacts">;

export const SALES_STAGES = [
  { key: "lead_in", label: "Lead In" },
  { key: "contacted", label: "Contacted" },
  { key: "discovery_call", label: "Discovery Call" },
  { key: "proposal_sent", label: "Proposal Sent" },
  { key: "closed_won", label: "Closed / Won" },
  { key: "closed_lost", label: "Closed / Lost" },
] as const;

export const LEAD_SOURCES = [
  "Facebook Ads",
  "Google Ads",
  "Referral",
  "Cold Outreach",
  "Website",
  "Other",
] as const;

export function useContacts(pipeline?: string) {
  return useQuery({
    queryKey: ["contacts", pipeline],
    queryFn: async () => {
      let query = supabase.from("contacts").select("*").order("created_at", { ascending: false });
      if (pipeline) query = query.eq("pipeline", pipeline);
      const { data, error } = await query;
      if (error) throw error;
      return data as Contact[];
    },
  });
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contact: ContactInsert) => {
      const { data, error } = await supabase.from("contacts").insert(contact).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }),
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: ContactUpdate & { id: string }) => {
      const { error } = await supabase.from("contacts").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("contacts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }),
  });
}
