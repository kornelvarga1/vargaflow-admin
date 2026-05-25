import { describe, it, expect } from "vitest";
import {
  matchesNegativeKeyword,
  isWithinSendWindow,
  isAllowedDay,
  startOfDayInTz,
  computeOutreachBudget,
} from "../../supabase/functions/_shared/outreach";

describe("matchesNegativeKeyword", () => {
  it.each<[string, boolean]>([
    // Positive: spec keywords
    ["STOP", true],
    ["stop", true],
    ["stop texting me", true],
    ["no thanks", true],
    ["No Thanks!", true],
    ["BYEBYE", true],
    ["byebye", true],
    ["bye bye", true],
    ["bye   bye", true],
    ["don't text", true],
    ["don't text me again", true],
    ["do not text me", true],
    ["unsubscribe", true],
    ["Unsubscribe please", true],
    ["remove me from your list", true],
    ["wrong number", true],
    ["lose my number", true],
    ["DNC", true],
    ["not interested", true],
    ["fuck off", true],
    ["fuck you", true],
    ["f off", true],
    // Negative: false-positive traps
    ["know thanks for the offer", false],
    ["stopping by tomorrow", false],
    ["stopped in earlier", false],
    ["unsubscribed from another list", false], // word-boundary means "-d" suffix doesn't match
    ["sounds good", false],
    ["yeah sure send it over", false],
    ["fucking awesome offer", false],
    ["nope remover", false],
    ["", false],
  ])("matches(%j) => %s", (input, expected) => {
    expect(matchesNegativeKeyword(input)).toBe(expected);
  });
});

describe("isWithinSendWindow", () => {
  const settings = { send_window_start: 9, send_window_end: 19 };
  const tz = "America/Phoenix"; // MST, no DST

  it("includes start hour", () => {
    expect(isWithinSendWindow(settings, new Date("2026-04-15T16:00:00Z"), tz)).toBe(true); // 9am MST
  });

  it("includes mid-day", () => {
    expect(isWithinSendWindow(settings, new Date("2026-04-15T21:30:00Z"), tz)).toBe(true); // 2:30pm MST
  });

  it("excludes end hour", () => {
    expect(isWithinSendWindow(settings, new Date("2026-04-16T02:00:00Z"), tz)).toBe(false); // 7pm MST
  });

  it("excludes early morning", () => {
    expect(isWithinSendWindow(settings, new Date("2026-04-15T13:00:00Z"), tz)).toBe(false); // 6am MST
  });

  it("excludes late night", () => {
    expect(isWithinSendWindow(settings, new Date("2026-04-16T05:00:00Z"), tz)).toBe(false); // 10pm MST
  });
});

describe("isAllowedDay", () => {
  const tz = "America/Chicago";
  // 2026-05-25 is a Monday (verifiable via JS Date).
  const monNoonUtc = new Date("2026-05-25T17:00:00Z"); // noon CT
  const satNoonUtc = new Date("2026-05-30T17:00:00Z"); // Saturday noon CT
  const sunNoonUtc = new Date("2026-05-31T17:00:00Z"); // Sunday noon CT

  it("allows Monday when Mon-Fri configured", () => {
    expect(isAllowedDay([1, 2, 3, 4, 5], monNoonUtc, tz)).toBe(true);
  });

  it("blocks Saturday when Mon-Fri configured", () => {
    expect(isAllowedDay([1, 2, 3, 4, 5], satNoonUtc, tz)).toBe(false);
  });

  it("blocks Sunday when Mon-Fri configured", () => {
    expect(isAllowedDay([1, 2, 3, 4, 5], sunNoonUtc, tz)).toBe(false);
  });

  it("allows Sunday when 0 included", () => {
    expect(isAllowedDay([0, 6], sunNoonUtc, tz)).toBe(true);
  });

  it("fail-closed on empty list", () => {
    expect(isAllowedDay([], monNoonUtc, tz)).toBe(false);
  });

  it("fail-closed on null", () => {
    expect(isAllowedDay(null, monNoonUtc, tz)).toBe(false);
  });

  it("TZ rollover: late Sunday UTC is Monday in Asia/Tokyo", () => {
    // 2026-05-24 20:00 UTC = 2026-05-25 05:00 Tokyo = Monday
    const lateSunUtc = new Date("2026-05-24T20:00:00Z");
    expect(isAllowedDay([1], lateSunUtc, "Asia/Tokyo")).toBe(true);
    expect(isAllowedDay([1], lateSunUtc, "America/Chicago")).toBe(false); // still Sunday in CT
  });
});

describe("startOfDayInTz", () => {
  it("returns local midnight as UTC for Central time", () => {
    // 2026-05-25 noon CT → start of day = 2026-05-25 00:00 CT = 2026-05-25 05:00 UTC
    const noonCt = new Date("2026-05-25T17:00:00Z");
    const sod = startOfDayInTz(noonCt, "America/Chicago");
    expect(sod.toISOString()).toBe("2026-05-25T05:00:00.000Z");
  });

  it("handles UTC tz", () => {
    const t = new Date("2026-05-25T17:00:00Z");
    const sod = startOfDayInTz(t, "UTC");
    expect(sod.toISOString()).toBe("2026-05-25T00:00:00.000Z");
  });

  it("rolls into next local day for late UTC + ahead TZ", () => {
    // 2026-05-25 16:00 UTC = 2026-05-26 01:00 Tokyo → start of day = 2026-05-26 00:00 Tokyo = 2026-05-25 15:00 UTC
    const t = new Date("2026-05-25T16:00:00Z");
    const sod = startOfDayInTz(t, "Asia/Tokyo");
    expect(sod.toISOString()).toBe("2026-05-25T15:00:00.000Z");
  });
});

describe("computeOutreachBudget", () => {
  const baseCfg = { dailyCap: 20, windowSeconds: 9 * 3600, hourlyThrottle: null };
  // 9hr / 20 = 1620s = 27min pacing interval

  it("allows first send of the day", () => {
    const d = computeOutreachBudget(baseCfg, {
      sentToday: 0,
      sentLastHour: 0,
      secondsSinceLastSendToday: null,
    });
    expect(d.allowed).toBe(1);
    expect(d.reason).toBe("ok");
    expect(d.paceIntervalSeconds).toBe(1620);
  });

  it("blocks when pacing interval not yet elapsed", () => {
    const d = computeOutreachBudget(baseCfg, {
      sentToday: 3,
      sentLastHour: 1,
      secondsSinceLastSendToday: 600, // 10min < 27min
    });
    expect(d.allowed).toBe(0);
    expect(d.reason).toMatch(/pacing/);
  });

  it("allows when pacing interval elapsed", () => {
    const d = computeOutreachBudget(baseCfg, {
      sentToday: 3,
      sentLastHour: 1,
      secondsSinceLastSendToday: 2000, // > 1620s
    });
    expect(d.allowed).toBe(1);
  });

  it("blocks when daily cap reached", () => {
    const d = computeOutreachBudget(baseCfg, {
      sentToday: 20,
      sentLastHour: 0,
      secondsSinceLastSendToday: 99999,
    });
    expect(d.allowed).toBe(0);
    expect(d.reason).toBe("daily_cap_hit");
  });

  it("blocks when daily cap is 0", () => {
    const d = computeOutreachBudget(
      { ...baseCfg, dailyCap: 0 },
      { sentToday: 0, sentLastHour: 0, secondsSinceLastSendToday: null },
    );
    expect(d.allowed).toBe(0);
    expect(d.reason).toBe("daily_cap_zero");
  });

  it("hourly throttle blocks when cap hit", () => {
    const d = computeOutreachBudget(
      { ...baseCfg, hourlyThrottle: 5 },
      { sentToday: 5, sentLastHour: 5, secondsSinceLastSendToday: 99999 },
    );
    expect(d.allowed).toBe(0);
    expect(d.reason).toBe("hourly_throttle_hit");
  });

  it("hourly throttle ignored when null", () => {
    const d = computeOutreachBudget(baseCfg, {
      sentToday: 1,
      sentLastHour: 99,
      secondsSinceLastSendToday: 99999,
    });
    expect(d.allowed).toBe(1);
  });
});
