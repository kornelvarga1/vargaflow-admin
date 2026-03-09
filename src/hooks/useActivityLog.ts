import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Tables } from "@/integrations/supabase/types";

export type ActivityLog = Tables<"activity_log"> & {
  contacts?: { full_name: string } | null;
};

export function useActivityLog(limit = 20) {
  return useQuery({
    queryKey: ["activity_log", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activity_log")
        .select("*, contacts(full_name)")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as ActivityLog[];
    },
  });
}

export async function logActivity(
  activityType: string,
  description: string,
  contactId?: string,
  metadata?: Record<string, unknown>
) {
  const { error } = await supabase.from("activity_log").insert([{
    activity_type: activityType,
    description,
    contact_id: contactId || null,
    metadata: (metadata || {}) as Record<string, unknown>,
  }]);
  if (error) console.error("Failed to log activity:", error);
}
