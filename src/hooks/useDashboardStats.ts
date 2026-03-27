import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface DashboardStats {
  totalContacts: number;
  salesByStage: Record<string, number>;
  onboardingByStage: Record<string, number>;
  pendingMessages: number;
  sentMessages: number;
  activeSequences: number;
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ["dashboard_stats"],
    queryFn: async () => {
      const [contactsRes, messagesRes] = await Promise.all([
        supabase.from("contacts").select("id, pipeline, stage").is("business_id", null),
        supabase.from("message_queue").select("status").is("business_id", null),
      ]);

      const contacts = contactsRes.data || [];
      const messages = messagesRes.data || [];
      const contactIds = contacts.map((c) => c.id);

      const activeEnrollmentsRes = contactIds.length > 0
        ? await supabase
            .from("contact_sequences")
            .select("id", { count: "exact", head: true })
            .eq("status", "active")
            .in("contact_id", contactIds)
        : { count: 0 };

      const salesByStage: Record<string, number> = {};
      const onboardingByStage: Record<string, number> = {};

      for (const c of contacts) {
        if (c.pipeline === "Sales") {
          salesByStage[c.stage] = (salesByStage[c.stage] || 0) + 1;
        } else if (c.pipeline === "Onboarding") {
          onboardingByStage[c.stage] = (onboardingByStage[c.stage] || 0) + 1;
        }
      }

      return {
        totalContacts: contacts.length,
        salesByStage,
        onboardingByStage,
        pendingMessages: messages.filter((m) => m.status === "pending").length,
        sentMessages: messages.filter((m) => m.status === "sent").length,
        activeSequences: activeEnrollmentsRes.count ?? 0,
      } as DashboardStats;
    },
    refetchInterval: 30000, // refresh every 30s
  });
}
