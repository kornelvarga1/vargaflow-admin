import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface CustomValue {
  id: string;
  key: string;
  label: string;
  value: string;
  category: string;
  sort_order: number;
}

export function useCustomValues() {
  return useQuery({
    queryKey: ["custom_values"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_values")
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return data as CustomValue[];
    },
  });
}

export function useUpdateCustomValue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, value }: { id: string; value: string }) => {
      const { error } = await supabase
        .from("custom_values")
        .update({ value })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom_values"] });
    },
  });
}

/** Replace {{variable_name}} in a template string with actual values */
export function replaceCustomValues(
  template: string,
  values: CustomValue[]
): string {
  let result = template;
  for (const v of values) {
    const pattern = new RegExp(`\\{\\{${v.key}\\}\\}`, "g");
    result = result.replace(pattern, v.value || `{{${v.key}}}`);
  }
  return result;
}
