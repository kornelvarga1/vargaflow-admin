import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { ADMIN_BUSINESS_ID } from "@/lib/constants";
import { addDays, startOfDay } from "date-fns";

export interface OutreachRunway {
  backlog: number;
  dailyCap: number;
  sendingDaysLeft: number;
  dryDate: Date | null;
  status: "ok" | "amber" | "red" | "empty" | "paused";
}

function computeRunway(
  backlog: number,
  sentToday: number,
  dailyCap: number,
  sendDays: number[],
): Pick<OutreachRunway, "sendingDaysLeft" | "dryDate"> {
  if (backlog === 0 || dailyCap === 0) return { sendingDaysLeft: 0, dryDate: null };

  const today = startOfDay(new Date());
  const isTodaySendDay = sendDays.includes(today.getDay());
  const capRemainingToday = isTodaySendDay ? Math.max(0, dailyCap - sentToday) : 0;

  let remaining = backlog - Math.min(backlog, capRemainingToday);
  if (remaining <= 0) return { sendingDaysLeft: 0, dryDate: today };

  let sendingDaysLeft = 0;
  let d = addDays(today, 1);
  for (let i = 0; i < 365 && remaining > 0; i++) {
    if (sendDays.includes(d.getDay())) {
      remaining -= dailyCap;
      sendingDaysLeft++;
    }
    if (remaining > 0) d = addDays(d, 1);
  }

  return { sendingDaysLeft, dryDate: d };
}

function useOutreachSettings() {
  return useQuery({
    queryKey: ["my_settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("*")
        .eq("business_id", ADMIN_BUSINESS_ID)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data as Record<string, any> | null;
    },
  });
}

export function useOutreachRunway() {
  const { data: settings, isLoading: settingsLoading } = useOutreachSettings();

  const dailyCap: number = settings?.daily_send_cap ?? 20;
  const sendDays: number[] = Array.isArray(settings?.send_days_of_week)
    ? settings.send_days_of_week
    : [1, 2, 3, 4, 5];

  return useQuery<OutreachRunway>({
    queryKey: ["outreach_runway", dailyCap, sendDays.join(",")],
    enabled: !settingsLoading,
    queryFn: async () => {
      const todayStartIso = startOfDay(new Date()).toISOString();

      const [backlogRes, sentTodayRes] = await Promise.all([
        supabase
          .from("message_queue")
          .select("id, contact:contacts!inner(pipeline)", { count: "exact", head: true })
          .eq("status", "pending")
          .eq("metadata->>step_order", "1")
          .eq("contact.pipeline", "Outreach"),
        supabase
          .from("message_queue")
          .select("id, contact:contacts!inner(pipeline)", { count: "exact", head: true })
          .eq("status", "sent")
          .eq("metadata->>step_order", "1")
          .eq("contact.pipeline", "Outreach")
          .gte("sent_at", todayStartIso),
      ]);

      const backlog = backlogRes.count ?? 0;
      const sentToday = sentTodayRes.count ?? 0;

      const { sendingDaysLeft, dryDate } = computeRunway(backlog, sentToday, dailyCap, sendDays);

      let status: OutreachRunway["status"] = "ok";
      if (dailyCap === 0) status = "paused";
      else if (backlog === 0) status = "empty";
      else if (sendingDaysLeft <= 1) status = "red";
      else if (sendingDaysLeft <= 3) status = "amber";

      return { backlog, dailyCap, sendingDaysLeft, dryDate, status };
    },
    refetchInterval: 30000,
  });
}
