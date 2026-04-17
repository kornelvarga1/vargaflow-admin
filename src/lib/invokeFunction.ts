import { supabase } from "@/lib/supabase";

const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export function invokeFunction<T = unknown>(name: string, body?: unknown) {
  return supabase.functions.invoke<T>(name, {
    body,
    headers: { Authorization: `Bearer ${ANON_KEY}` },
  });
}
