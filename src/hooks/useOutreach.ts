import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export type OutreachWorkflow = "free_website" | "leads_incentive";

export const OUTREACH_WORKFLOWS: { value: OutreachWorkflow; label: string; description: string }[] = [
  {
    value: "free_website",
    label: "Free Website Incentive",
    description: "Lead with a pre-built website offer.",
  },
  {
    value: "leads_incentive",
    label: "Leads Incentive",
    description: "Lead with 5–15 extra jobs in 8 weeks.",
  },
];

export interface EnrollResult {
  enrolled: { id: string; name: string }[];
  skipped: { id: string; name: string; reason: string }[];
}

export function useEnrollOutreach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contact_ids: string[]; workflow: OutreachWorkflow }) => {
      const { data, error } = await supabase.functions.invoke<EnrollResult>("enroll-outreach", {
        body: input,
      });
      if (error) throw error;
      if (!data) throw new Error("empty response from enroll-outreach");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact_sequences"] });
    },
  });
}
