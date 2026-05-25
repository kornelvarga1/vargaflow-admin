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

// Day-of-week filter. allowedDays uses 0=Sun…6=Sat to match JS Date.getDay() conventions.
// Empty/missing list → no day is allowed (fail-closed: easier to debug than silent "all days").
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function isAllowedDay(
  allowedDays: number[] | null | undefined,
  now: Date,
  timeZone: string,
): boolean {
  if (!allowedDays || allowedDays.length === 0) return false;
  const weekdayShort = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone,
  }).format(now);
  const day = WEEKDAY_INDEX[weekdayShort];
  return day !== undefined && allowedDays.includes(day);
}

// Returns the UTC Date corresponding to YYYY-MM-DD (today in the given TZ) at the given local hour.
// Used to count "sends today" with a clean midnight cutoff that respects the user's timezone.
export function dateAtHourInTz(now: Date, hour: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const datePart = `${get("year")}-${get("month")}-${get("day")}`;
  // Treat as UTC, then correct by the offset between UTC and the target TZ at that instant.
  const naive = new Date(`${datePart}T${String(hour).padStart(2, "0")}:00:00Z`);
  const seenHour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(naive),
  );
  let delta = seenHour - hour;
  if (delta > 12) delta -= 24;
  if (delta < -12) delta += 24;
  return new Date(naive.getTime() - delta * 3600_000);
}

export function startOfDayInTz(now: Date, timeZone: string): Date {
  return dateAtHourInTz(now, 0, timeZone);
}

// Per-tick pacing decision. Pure function: cron gathers state, calls this, applies result.
// Returns how many outreach SMS this tick is allowed to send (0 or 1) and a reason for logging.
export interface PacingConfig {
  dailyCap: number;
  windowSeconds: number;          // (end_hour - start_hour) * 3600
  hourlyThrottle: number | null;  // null → distribution-only
}

export interface PacingState {
  sentToday: number;
  sentLastHour: number;
  secondsSinceLastSendToday: number | null;  // null = no sends today yet
}

export interface PacingDecision {
  allowed: 0 | 1;
  reason: string;
  paceIntervalSeconds: number;
}

export function computeOutreachBudget(
  cfg: PacingConfig,
  st: PacingState,
): PacingDecision {
  const paceIntervalSeconds =
    cfg.dailyCap > 0 ? Math.max(1, Math.floor(cfg.windowSeconds / cfg.dailyCap)) : 0;

  if (cfg.dailyCap <= 0) return { allowed: 0, reason: "daily_cap_zero", paceIntervalSeconds };
  if (st.sentToday >= cfg.dailyCap) return { allowed: 0, reason: "daily_cap_hit", paceIntervalSeconds };

  if (st.secondsSinceLastSendToday !== null && st.secondsSinceLastSendToday < paceIntervalSeconds) {
    return {
      allowed: 0,
      reason: `pacing(${st.secondsSinceLastSendToday}s<${paceIntervalSeconds}s)`,
      paceIntervalSeconds,
    };
  }

  if (cfg.hourlyThrottle !== null && cfg.hourlyThrottle > 0 && st.sentLastHour >= cfg.hourlyThrottle) {
    return { allowed: 0, reason: "hourly_throttle_hit", paceIntervalSeconds };
  }

  return { allowed: 1, reason: "ok", paceIntervalSeconds };
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
