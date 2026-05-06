/**
 * Wave-10 reviewer P1 regression: parsePeriodShortcut must compute
 * day-boundary periods in the operator's local timezone, not UTC.
 *
 * # Why this exists
 *
 * Previously the function anchored "today" / "yesterday" / etc at UTC
 * midnight. A Bangkok operator (UTC+7) at 02:00 local time asking
 * "yesterday" got UTC-yesterday — which is ~17 hours earlier than
 * local-yesterday. Operator scenarios like "what did we work on
 * yesterday?" must mean LOCAL yesterday.
 *
 * # What's tested
 *
 * The test fixes `nowMs` to a known instant where local-day and
 * UTC-day differ for both target timezones, and verifies the
 * returned (since, before) bounds are correct in the local frame.
 */

import { describe, expect, it } from "vitest";
import { parsePeriodShortcut } from "../src/tools/lcm-synthesize-around-tool.js";

describe("parsePeriodShortcut — local-timezone day boundaries (Wave-10 reviewer P1)", () => {
  // Anchor: 2026-05-07T02:00:00 in Bangkok = 2026-05-06T19:00:00 UTC.
  // At this moment:
  //   Bangkok local "today"     = 2026-05-07
  //   Bangkok local "yesterday" = 2026-05-06
  //   UTC          "today"     = 2026-05-06
  //   UTC          "yesterday" = 2026-05-05
  // So a Bangkok operator's "yesterday" must NOT be UTC's 2026-05-05.
  const bangkokNowUtcMs = Date.UTC(2026, 4, 6, 19, 0, 0);

  // Anchor: 2026-05-07T01:00:00 in Los Angeles (UTC-7 PDT) = 2026-05-07T08:00:00 UTC.
  // At this moment:
  //   LA local "today"     = 2026-05-07
  //   LA local "yesterday" = 2026-05-06
  //   UTC      "today"     = 2026-05-07 (matches LA today by coincidence)
  //   UTC      "yesterday" = 2026-05-06
  // We pick a different LA anchor: 23:00 PDT (LA's late evening, UTC's
  // already next day) so the LA-vs-UTC day differ.
  // 2026-05-07T23:00:00 in LA (UTC-7 PDT) = 2026-05-08T06:00:00 UTC.
  // Here:
  //   LA local "today"     = 2026-05-07
  //   LA local "yesterday" = 2026-05-06
  //   UTC      "today"     = 2026-05-08
  //   UTC      "yesterday" = 2026-05-07
  const laNowUtcMs = Date.UTC(2026, 4, 8, 6, 0, 0);

  // Helper: assert ISO date matches expected y/m/d (ignoring time-of-day).
  function assertIsoDate(date: Date, expectedYmd: string) {
    const iso = date.toISOString();
    expect(iso.startsWith(expectedYmd)).toBe(true);
  }

  it("Bangkok 'yesterday' returns local-yesterday (2026-05-06), NOT UTC-yesterday (2026-05-05)", () => {
    const r = parsePeriodShortcut("yesterday", {
      nowMs: bangkokNowUtcMs,
      timezone: "Asia/Bangkok",
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    // Bangkok local-yesterday = 2026-05-06 in Bangkok.
    // Bangkok 2026-05-06 00:00 = 2026-05-05T17:00:00 UTC.
    // Bangkok 2026-05-07 00:00 = 2026-05-06T17:00:00 UTC.
    expect(r.since.toISOString()).toBe("2026-05-05T17:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-06T17:00:00.000Z");
    expect(r.label).toBe("yesterday");
  });

  it("Bangkok 'today' returns local-today (2026-05-07)", () => {
    const r = parsePeriodShortcut("today", {
      nowMs: bangkokNowUtcMs,
      timezone: "Asia/Bangkok",
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.since.toISOString()).toBe("2026-05-06T17:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-07T17:00:00.000Z");
  });

  it("Los Angeles 'yesterday' (PDT, UTC-7) at 23:00 local returns LA-yesterday (2026-05-06), NOT UTC-yesterday (2026-05-07)", () => {
    const r = parsePeriodShortcut("yesterday", {
      nowMs: laNowUtcMs,
      timezone: "America/Los_Angeles",
    });
    if ("error" in r) throw new Error(r.error);
    // LA 2026-05-06 00:00 PDT = 2026-05-06T07:00:00 UTC.
    // LA 2026-05-07 00:00 PDT = 2026-05-07T07:00:00 UTC.
    expect(r.since.toISOString()).toBe("2026-05-06T07:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-07T07:00:00.000Z");
    expect(r.label).toBe("yesterday");
  });

  it("UTC 'yesterday' returns UTC-yesterday (control case)", () => {
    const r = parsePeriodShortcut("yesterday", {
      nowMs: bangkokNowUtcMs,
      timezone: "UTC",
    });
    if ("error" in r) throw new Error(r.error);
    // UTC 2026-05-05 00:00 = 2026-05-05T00:00:00 UTC.
    expect(r.since.toISOString()).toBe("2026-05-05T00:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-06T00:00:00.000Z");
  });

  it("'last-7-days' is timezone-independent (now-anchored, not day-anchored)", () => {
    const rUtc = parsePeriodShortcut("last-7-days", {
      nowMs: bangkokNowUtcMs,
      timezone: "UTC",
    });
    const rBkk = parsePeriodShortcut("last-7-days", {
      nowMs: bangkokNowUtcMs,
      timezone: "Asia/Bangkok",
    });
    if ("error" in rUtc) throw new Error(rUtc.error);
    if ("error" in rBkk) throw new Error(rBkk.error);
    expect(rUtc.since.toISOString()).toBe(rBkk.since.toISOString());
    expect(rUtc.before.toISOString()).toBe(rBkk.before.toISOString());
  });

  it("'last-12h' is timezone-independent (now-anchored)", () => {
    const r = parsePeriodShortcut("last-12h", {
      nowMs: bangkokNowUtcMs,
      timezone: "Asia/Bangkok",
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.before.toISOString()).toBe("2026-05-06T19:00:00.000Z");
    expect(r.since.toISOString()).toBe("2026-05-06T07:00:00.000Z");
  });

  it("'this-month' uses local-month boundaries (Bangkok at month start)", () => {
    // Bangkok 2026-05-01 00:01:00 BKK = 2026-04-30T17:01:00 UTC.
    const justAfterMonthStartBkk = Date.UTC(2026, 3, 30, 17, 1, 0);
    const r = parsePeriodShortcut("this-month", {
      nowMs: justAfterMonthStartBkk,
      timezone: "Asia/Bangkok",
    });
    if ("error" in r) throw new Error(r.error);
    // Bangkok May 2026 starts at Bangkok 2026-05-01 00:00 = 2026-04-30T17:00 UTC.
    expect(r.since.toISOString()).toBe("2026-04-30T17:00:00.000Z");
    // Bangkok June 2026 starts at Bangkok 2026-06-01 00:00 = 2026-05-31T17:00 UTC.
    expect(r.before.toISOString()).toBe("2026-05-31T17:00:00.000Z");
  });

  it("Invalid timezone falls back to UTC gracefully (no crash)", () => {
    const r = parsePeriodShortcut("yesterday", {
      nowMs: bangkokNowUtcMs,
      timezone: "Not/A/Timezone",
    });
    if ("error" in r) throw new Error(r.error);
    // Should fall back to UTC behavior.
    expect(r.since.toISOString()).toBe("2026-05-05T00:00:00.000Z");
    expect(r.before.toISOString()).toBe("2026-05-06T00:00:00.000Z");
  });
});
