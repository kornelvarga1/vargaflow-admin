import { describe, it, expect } from "vitest";
import {
  matchesNegativeKeyword,
  isWithinSendWindow,
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
