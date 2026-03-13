import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { logActivity } from "@/hooks/useActivityLog";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";

export type Contact = Tables<"contacts">;
export type ContactInsert = TablesInsert<"contacts">;
export type ContactUpdate = TablesUpdate<"contacts">;

export const SALES_STAGES = [
  { key: "lead_in", label: "Lead In" },
  { key: "no_contact_1x", label: "No Contact x1 Text" },
  { key: "no_contact_2x", label: "No Contact 2x Text" },
  { key: "no_contact_3x", label: "No Contact 3x Text" },
  { key: "long_term_nurture", label: "No Contact → Long Term Nurture" },
  { key: "ready_to_close", label: "Ready to Close 🔥" },
  { key: "zoom_booked", label: "Zoom Call Booked" },
  { key: "zoom_finished", label: "Zoom Call Finished (Follow Up?)" },
  { key: "cancelled_reschedule", label: "Cancelled/Reschedule" },
  { key: "no_showed_zoom", label: "No Showed to Zoom" },
  { key: "client_closed", label: "Client Closed" },
] as const;

export const ONBOARDING_STAGES = [
  { key: "waiting_onboarding_form", label: "New Client Waiting for Onboarding Form" },
  { key: "form_submitted", label: "Form Submitted" },
  { key: "project_ready", label: "Project Ready to Start" },
  { key: "launch_call_booked", label: "Launch Call Booked 🚀" },
  { key: "gmb_issue", label: "GMB Issue / Phone Verification Issue 🚨" },
  { key: "approved_retainer", label: "Approved - Client on Retainer" },
  { key: "cc_declined", label: "Credit Card Declined" },
  { key: "client_churned", label: "Client Churned" },
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
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      if (data) logActivity("contact_created", "was added as a new contact", data.id);
    },
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
