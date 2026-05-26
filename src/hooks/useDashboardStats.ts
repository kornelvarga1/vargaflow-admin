import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface DashboardStats {
  totalContacts: number;
  salesByStage: Record<string, number>;
  onboardingByStage: Record<string, number>;
  pendingMessages: number;
  sentMessagesThisMonth: number;
  activeSequences: number;
  callsBookedThisMonth: number;
  clientsClosedThisMonth: number;
  outreachByStage: Record<string, number>;
  outreachEnrolled: number;
  outreachReplyRate: number;
  outreachPositiveRate: number;
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ["dashboard_stats"],
    queryFn: async () => {
      const monthAgo = new Date();
      monthAgo.setDate(monthAgo.getDate() - 30);
      const monthAgoISO = monthAgo.toISOString();

      const [contactsRes, pendingRes, sentRes, activityRes] = await Promise.all([
        supabase.from("contacts").select("id, pipeline, stage").is("business_id", null),
        supabase
          .from("message_queue")
          .select("id", { count: "exact", head: true })
          .is("business_id", null)
          .eq("status", "pending"),
        supabase
          .from("message_queue")
          .select("id", { count: "exact", head: true })
          .is("business_id", null)
          .eq("status", "sent")
          .gte("sent_at", monthAgoISO),
        supabase
          .from("activity_log")
          .select("activity_type, description, created_at")
          .eq("activity_type", "stage_changed")
          .gte("created_at", monthAgoISO),
      ]);

      const contacts = contactsRes.data || [];
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
      const outreachByStage: Record<string, number> = {};
      let outreachEnrolled = 0;
      let outreachReplied = 0;
      let outreachPositive = 0;

      const OUTREACH_REPLIED_STAGES = new Set([
        "Replied",
        "Interested – Positive Reply",
        "Follow-up",
        "Appt Set",
      ]);

      for (const c of contacts) {
        if (c.pipeline === "Sales") {
          salesByStage[c.stage] = (salesByStage[c.stage] || 0) + 1;
        } else if (c.pipeline === "Onboarding") {
          onboardingByStage[c.stage] = (onboardingByStage[c.stage] || 0) + 1;
        } else if (c.pipeline === "Outreach") {
          outreachByStage[c.stage] = (outreachByStage[c.stage] || 0) + 1;
          // Cold List = imported but not yet enrolled; exclude from rates
          if (c.stage !== "Cold List") {
            outreachEnrolled++;
            if (OUTREACH_REPLIED_STAGES.has(c.stage) || c.stage === "Not Interested") {
              outreachReplied++;
            }
            if (OUTREACH_REPLIED_STAGES.has(c.stage)) {
              outreachPositive++;
            }
          }
        }
      }

      // Count calls booked and clients closed this month from activity log
      const stageActivities = activityRes.data || [];
      let callsBooked = 0;
      let clientsClosed = 0;
      for (const a of stageActivities) {
        if (a.description?.includes("Zoom Call Booked")) callsBooked++;
        if (a.description?.includes("Client Closed")) clientsClosed++;
      }

      const outreachReplyRate = outreachEnrolled > 0
        ? Math.round((outreachReplied / outreachEnrolled) * 1000) / 10
        : 0;
      const outreachPositiveRate = outreachEnrolled > 0
        ? Math.round((outreachPositive / outreachEnrolled) * 1000) / 10
        : 0;

      return {
        totalContacts: contacts.length,
        salesByStage,
        onboardingByStage,
        pendingMessages: pendingRes.count ?? 0,
        sentMessagesThisMonth: sentRes.count ?? 0,
        activeSequences: activeEnrollmentsRes.count ?? 0,
        callsBookedThisMonth: callsBooked,
        clientsClosedThisMonth: clientsClosed,
        outreachByStage,
        outreachEnrolled,
        outreachReplyRate,
        outreachPositiveRate,
      } as DashboardStats;
    },
    refetchInterval: 30000,
  });
}
