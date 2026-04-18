import { supabase } from "@/lib/supabase";

const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Authorization header = HS256 anon JWT (the Supabase gateway is configured to
// only accept HS256; user session JWTs are ES256 and get rejected there).
// X-User-Auth = the current user's session JWT, so admin-only edge functions
// can validate the caller's role via requireAdmin() inside the function.
export async function invokeFunction<T = unknown>(name: string, body?: unknown) {
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = { Authorization: `Bearer ${ANON_KEY}` };
  if (session?.access_token) {
    headers["X-User-Auth"] = `Bearer ${session.access_token}`;
  }
  return supabase.functions.invoke<T>(name, { body, headers });
}
