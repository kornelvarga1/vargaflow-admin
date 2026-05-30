import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { normalizePhone } from "@/lib/phone";
import { logActivity } from "@/hooks/useActivityLog";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";

export type Contact = Tables<"contacts">;
export type ContactInsert = TablesInsert<"contacts">;
export type ContactUpdate = TablesUpdate<"contacts">;

export const SALES_STAGES = [
  { key: "Lead In", label: "Lead In" },
  { key: "No Contact x1 Text", label: "🤖 No Contact x1 Text" },
  { key: "No Contact 2x Text", label: "🤖 No Contact 2x Text" },
  { key: "No Contact 3x Text", label: "🤖 No Contact 3x Text" },
  { key: "No Contact → Long Term Nurture", label: "🤖 No Contact → Long Term Nurture" },
  { key: "Ready to Close", label: "Ready to Close" },
  { key: "Zoom Call Booked", label: "Zoom Call Booked" },
  { key: "Zoom Call Finished", label: "Zoom Call Finished (Follow Up?)" },
  { key: "Cancelled/Rescheduled", label: "🤖 Cancelled/Rescheduled" },
  { key: "No Showed to Zoom", label: "🤖 No Showed to Zoom" },
  { key: "Client Closed", label: "🤖 Client Closed" },
] as const;

export const ONBOARDING_STAGES = [
  { key: "New Client Waiting for Onboarding Form", label: "🤖 New Client Waiting for Onboarding Form" },
  { key: "Form Submitted", label: "Form Submitted" },
  { key: "Project Ready to Start", label: "🤖 Project Ready to Start" },
  { key: "Launch Call Booked", label: "Launch Call Booked" },
  { key: "GMB Issue", label: "GMB Issue / Phone Verification Issue" },
  { key: "Approved Retainer", label: "Approved - Client on Retainer" },
  { key: "Credit Card Declined", label: "Credit Card Declined" },
  { key: "Client Churned", label: "Client Churned" },
] as const;

export const OUTREACH_STAGES = [
  { key: "Cold List", label: "Cold List" },
  { key: "Sequence Active", label: "Sequence Active" },
  { key: "Replied", label: "Replied" },
  { key: "Interested – Positive Reply", label: "Interested" },
  { key: "Follow-up", label: "Follow-up" },
  { key: "Not Interested", label: "Not Interested" },
  { key: "Appt Set", label: "Appt Set" },
  { key: "Stale", label: "Stale" },
] as const;

export const LEAD_SOURCES = [
  "Facebook Ads",
  "Google Ads",
  "Referral",
  "Cold Outreach",
  "Outreach — Free Website",
  "Outreach — Leads",
  "Website",
  "Other",
] as const;

export function useContacts(pipeline?: string) {
  return useQuery({
    queryKey: ["contacts", pipeline],
    queryFn: async () => {
      let query = supabase.from("contacts").select("*").is("business_id", null).order("created_at", { ascending: false });
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
      const normalized = { ...contact, phone: normalizePhone(contact.phone) };
      const { data, error } = await supabase.from("contacts").insert(normalized).select().single();
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
      const normalized = updates.phone !== undefined
        ? { ...updates, phone: normalizePhone(updates.phone) }
        : updates;
      const { error } = await supabase.from("contacts").update(normalized).eq("id", id);
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
