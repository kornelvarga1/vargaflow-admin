// SMS cold-outreach helpers. No URL imports so Vitest can import this directly.
// The supabase client is typed as `any` — runtime contract is all we need.

export const OUTREACH_PIPELINE = "outreach";

export type OutreachAngle = "free_website" | "leads_incentive";

export const OUTREACH_SEQUENCE_BY_ANGLE: Record<OutreachAngle, string> = {
  free_website: "Outreach — Free Website Incentive",
  leads_incentive: "Outreach — Leads Incentive",
};

export const OUTREACH_ANGLE_LABEL: Record<OutreachAngle, string> = {
  free_website: "Free Website",
  leads_incentive: "Leads Incentive",
};

export const NEGATIVE_KEYWORDS = [
  "byebye",
  "bye bye",
  "stop",
  "not interested",
  "no thanks",
  "fuck off",
  "f off",
  "fuck you",
  "remove",
  "unsubscribe",
  "dnc",
  "wrong number",
  "lose my number",
  "don't text",
  "do not text",
];

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const NEGATIVE_PATTERNS = NEGATIVE_KEYWORDS.map((kw) => {
  const parts = kw.trim().split(/\s+/).map((w) => w.replace(REGEX_SPECIALS, "\\$&"));
  return new RegExp(`\\b${parts.join("\\s+")}\\b`, "i");
});

export function matchesNegativeKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  return NEGATIVE_PATTERNS.some((re) => re.test(text));
}

export interface SendWindow {
  send_window_start: number;
  send_window_end: number;
}

export function isWithinSendWindow(
  settings: SendWindow,
  now: Date,
  timeZone: string = "America/New_York",
): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone,
    }).format(now),
  );
  return hour >= settings.send_window_start && hour < settings.send_window_end;
}

// Fail-closed: on lookup error, treat as DNC. Better to halt sends than to leak a re-text.
export async function isDNC(supabase: any, phone: string): Promise<boolean> {
  if (!phone) return false;
  const { data, error } = await supabase
    .from("dnc_list")
    .select("id")
    .eq("phone", phone)
    .maybeSingle();
  if (error) {
    console.error(`[dnc] lookup error for ${phone}:`, error.message);
    return true;
  }
  return !!data;
}

export async function addToDNC(
  supabase: any,
  phone: string,
  reason: string,
  sourceWorkflow: string | null,
  businessId: string | null,
): Promise<void> {
  if (!phone) return;
  const { error } = await supabase.from("dnc_list").insert({
    phone,
    reason,
    source_workflow: sourceWorkflow,
    business_id: businessId,
  });
  if (error && !/duplicate|unique/i.test(error.message)) {
    console.error(`[dnc] insert error for ${phone}:`, error.message);
  }
}
