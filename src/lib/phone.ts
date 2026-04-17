// Normalize phone to E.164 — mirrors logic in
// supabase/functions/_shared/utils.ts and the dedup migration so
// every write to contacts.phone ends up in the same canonical format.
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length >= 11) return "+" + digits;
  return null;
}
