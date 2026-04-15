import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { logActivity } from "@/hooks/useActivityLog";

export function useDNC(phone?: string) {
  return useQuery({
    queryKey: ["dnc", phone],
    enabled: !!phone,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dnc_list")
        .select("*")
        .eq("phone", phone!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

interface AddDNCInput {
  phone: string;
  reason: string;
  source_workflow?: string | null;
  contact_id?: string;
}

export function useAddToDNC() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ phone, reason, source_workflow, contact_id }: AddDNCInput) => {
      const { error } = await supabase.from("dnc_list").insert({
        phone,
        reason,
        source_workflow: source_workflow ?? null,
      });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;

      if (contact_id) {
        await supabase
          .from("contacts")
          .update({ stage: "Not Interested", stage_entered_at: new Date().toISOString() })
          .eq("id", contact_id);

        const { data: activeSeqs } = await supabase
          .from("contact_sequences")
          .select("id")
          .eq("contact_id", contact_id)
          .eq("status", "active");
        if (activeSeqs && activeSeqs.length > 0) {
          await supabase
            .from("contact_sequences")
            .update({ status: "stopped" })
            .in("id", activeSeqs.map((s) => s.id));
        }

        await supabase
          .from("message_queue")
          .update({ status: "cancelled" })
          .eq("contact_id", contact_id)
          .eq("status", "pending");

        await logActivity("dnc_added", `was DNC'd (${reason})`, contact_id);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["dnc"] });
      qc.invalidateQueries({ queryKey: ["contact_sequences"] });
    },
  });
}
