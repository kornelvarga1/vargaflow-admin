import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { invokeFunction } from "@/lib/invokeFunction";

export type OutreachWorkflow = "free_website" | "leads_incentive" | "free_trial_incentive";

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
  {
    value: "free_trial_incentive",
    label: "Free Trial Incentive",
    description: "Placeholder copy — messages not written yet.",
  },
];

export interface EnrollResult {
  enrolled: { id: string; name: string }[];
  skipped: { id: string; name: string; reason: string }[];
}

const ENROLL_BATCH_SIZE = 50;

export function useEnrollOutreach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contact_ids: string[]; workflow: OutreachWorkflow }) => {
      const result: EnrollResult = { enrolled: [], skipped: [] };
      for (let i = 0; i < input.contact_ids.length; i += ENROLL_BATCH_SIZE) {
        const batch = input.contact_ids.slice(i, i + ENROLL_BATCH_SIZE);
        const { data, error } = await invokeFunction<EnrollResult>("enroll-outreach", { contact_ids: batch, workflow: input.workflow });
        if (error) throw error;
        if (!data) throw new Error("empty response from enroll-outreach");
        result.enrolled.push(...data.enrolled);
        result.skipped.push(...data.skipped);
      }
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact_sequences"] });
    },
  });
}
