import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { invokeFunction } from "@/lib/invokeFunction";

export type OutreachWorkflow = "free_website" | "leads_incentive" | "free_trial_incentive" | "ai_receptionist";

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
    description: "Lead with a free first month, no strings.",
  },
  {
    value: "ai_receptionist",
    label: "AI Receptionist",
    description: "Point them at the live demo number, let it sell itself.",
  },
];

export interface EnrollResult {
  enrolled: { id: string; name: string }[];
  skipped: { id: string; name: string; reason: string }[];
}

const ENROLL_BATCH_SIZE = 50;

export interface EnrollBatchResult extends EnrollResult {
  failedBatches: number;
}

export function useEnrollOutreach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contact_ids: string[]; workflow: OutreachWorkflow }) => {
      const result: EnrollBatchResult = { enrolled: [], skipped: [], failedBatches: 0 };
      // One bad/slow batch used to throw and abandon every remaining batch,
      // silently losing progress on large lists (~1750+ contacts). Continue
      // through failures instead — a contact that didn't get processed just
      // stays in Cold List (outreach_angle still null), so re-running the
      // enroll later picks up exactly what's left, nothing is lost either way.
      for (let i = 0; i < input.contact_ids.length; i += ENROLL_BATCH_SIZE) {
        const batch = input.contact_ids.slice(i, i + ENROLL_BATCH_SIZE);
        try {
          const { data, error } = await invokeFunction<EnrollResult>("enroll-outreach", { contact_ids: batch, workflow: input.workflow });
          if (error) throw error;
          if (!data) throw new Error("empty response from enroll-outreach");
          result.enrolled.push(...data.enrolled);
          result.skipped.push(...data.skipped);
        } catch (err) {
          console.error(`[useEnrollOutreach] batch ${i}-${i + batch.length} failed:`, err);
          result.failedBatches += 1;
        }
      }
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact_sequences"] });
    },
  });
}
