import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface DashboardStats {
  totalContacts: number;
  salesByStage: Record<string, number>;
  onboardingByStage: Record<string, number>;
  sentMessages: number;        // unique contacts first-touched in period
  callsBooked: number;
  clientsClosed: number;
  outreachByStage: Record<string, number>;
  outreachEnrolled: number;    // = sentMessages (same set, used for campaign header + rates)
  outreachReplyRate: number;
  outreachPositiveRate: number;
}

export function useDashboardStats(days = 30) {
  return useQuery({
    queryKey: ["dashboard_stats", days],
    queryFn: async () => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffISO = cutoff.toISOString();

      const OUTREACH_REPLIED_STAGES = new Set([
        "Replied",
        "Interested – Positive Reply",
        "Follow-up 1",
        "Follow-up 2",
        "Follow-up 3",
        "Appt Set",
      ]);

      const [contactsRes, firstTouchedRes, activityRes] = await Promise.all([
        // All contacts — for stage breakdowns (current snapshot, not time-filtered)
        supabase.from("contacts").select("id, pipeline, stage").is("business_id", null),
        // Unique contacts first-touched in period (step-1 Outreach sends)
        supabase
          .from("message_queue")
          .select("contact_id, contact:contacts!inner(pipeline)")
          .eq("status", "sent")
          .eq("metadata->>step_order", "1")
          .eq("contact.pipeline", "Outreach")
          .gte("sent_at", cutoffISO),
        // Stage changes in period — for calls booked + clients closed
        supabase
          .from("activity_log")
          .select("description")
          .eq("activity_type", "stage_changed")
          .gte("created_at", cutoffISO),
      ]);

      const contacts = contactsRes.data || [];

      // Unique contact IDs first-touched in period
      const firstTouchedIds = new Set(
        (firstTouchedRes.data ?? []).map((r: any) => r.contact_id).filter(Boolean)
      );

      // Stage lookup for reply rate calculation
      const stageById = new Map(contacts.map((c) => [c.id, c.stage]));

      // Stage breakdowns (current state, all-time)
      const salesByStage: Record<string, number> = {};
      const onboardingByStage: Record<string, number> = {};
      const outreachByStage: Record<string, number> = {};
      for (const c of contacts) {
        if (c.pipeline === "Sales") {
          salesByStage[c.stage] = (salesByStage[c.stage] || 0) + 1;
        } else if (c.pipeline === "Onboarding") {
          onboardingByStage[c.stage] = (onboardingByStage[c.stage] || 0) + 1;
        } else if (c.pipeline === "Outreach") {
          outreachByStage[c.stage] = (outreachByStage[c.stage] || 0) + 1;
        }
      }

      // Campaign performance: rates based on contacts first-touched in period
      let outreachEnrolled = 0;
      let outreachReplied = 0;
      let outreachPositive = 0;
      for (const id of firstTouchedIds) {
        const stage = stageById.get(id);
        if (!stage) continue;
        outreachEnrolled++;
        if (OUTREACH_REPLIED_STAGES.has(stage) || stage === "Not Interested") outreachReplied++;
        if (OUTREACH_REPLIED_STAGES.has(stage)) outreachPositive++;
      }

      const outreachReplyRate = outreachEnrolled > 0
        ? Math.round((outreachReplied / outreachEnrolled) * 1000) / 10
        : 0;
      const outreachPositiveRate = outreachEnrolled > 0
        ? Math.round((outreachPositive / outreachEnrolled) * 1000) / 10
        : 0;

      // Calls booked + clients closed in period
      let callsBooked = 0;
      let clientsClosed = 0;
      for (const a of activityRes.data || []) {
        if (a.description?.includes("Zoom Call Booked")) callsBooked++;
        if (a.description?.includes("Client Closed")) clientsClosed++;
      }

      return {
        totalContacts: contacts.length,
        salesByStage,
        onboardingByStage,
        sentMessages: firstTouchedIds.size,
        callsBooked,
        clientsClosed,
        outreachByStage,
        outreachEnrolled,
        outreachReplyRate,
        outreachPositiveRate,
      } as DashboardStats;
    },
    refetchInterval: 30000,
  });
}
