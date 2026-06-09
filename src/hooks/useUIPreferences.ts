import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ADMIN_BUSINESS_ID } from "@/lib/constants";

type UIPrefs = Record<string, unknown>;

const QK = ["ui_preferences"] as const;

export function useUIPreferences() {
  const qc = useQueryClient();
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: prefs = {}, isLoading } = useQuery<UIPrefs>({
    queryKey: QK,
    queryFn: async () => {
      const { data } = await supabase
        .from("settings")
        .select("ui_preferences")
        .eq("business_id", ADMIN_BUSINESS_ID)
        .single();
      return ((data as any)?.ui_preferences as UIPrefs) ?? {};
    },
    staleTime: Infinity,
  });

  const setPref = useCallback(
    (key: string, value: unknown, debounceMs = 0) => {
      // Optimistic update
      qc.setQueryData<UIPrefs>(QK, (old = {}) => ({ ...old, [key]: value }));

      const flush = async () => {
        const latest = qc.getQueryData<UIPrefs>(QK) ?? {};
        await supabase
          .from("settings")
          .update({ ui_preferences: latest } as any)
          .eq("business_id", ADMIN_BUSINESS_ID);
      };

      if (debounceMs > 0) {
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(flush, debounceMs);
      } else {
        flush();
      }
    },
    [qc],
  );

  return { prefs, setPref, isLoading };
}
