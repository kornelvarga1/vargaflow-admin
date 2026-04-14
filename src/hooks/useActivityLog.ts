import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";
import type { Json } from "@/integrations/supabase/types";

export type ActivityLog = Tables<"activity_log"> & {
  contacts?: { full_name: string } | null;
};

export function useActivityLog(limit = 20) {
  return useQuery({
    queryKey: ["activity_log", limit],
    queryFn: async () => {
      // activity_log has no business_id column — filter via internal contact IDs
      const { data: internalContacts } = await supabase
        .from("contacts")
        .select("id")
        .is("business_id", null);

      const internalIds = (internalContacts || []).map((c) => c.id);
      if (internalIds.length === 0) return [] as ActivityLog[];

      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("activity_log")
        .select("*, contacts(full_name)")
        .in("contact_id", internalIds)
        .gte("created_at", oneWeekAgo)
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
  const row: TablesInsert<"activity_log"> = {
    activity_type: activityType,
    description,
    contact_id: contactId || null,
    metadata: (metadata || {}) as Json,
  };
  const { error } = await supabase.from("activity_log").insert([row]);
  if (error) console.error("Failed to log activity:", error);
}
