import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import { formatTimestamp } from "../compaction.js";
import type { LcmContextEngine } from "../engine.js";
import type { RollupStore } from "../store/rollup-store.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import {
  parseIsoTimestampParam,
  resolveLcmConversationScope,
} from "./lcm-conversation-scope.js";

const LcmRecentSchema = Type.Object({
  period: Type.String({
    description:
      'Time period: "today", "yesterday", "7d", "week", "month", "30d", "date:YYYY-MM-DD", or a deterministic local-time window such as "yesterday 4-8pm", "today morning", "date:2026-04-27 14:00-16:30", "last 3h", or "last 90m"',
  }),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to current session.",
    })
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description: "Search all conversations.",
    })
  ),
  includeSources: Type.Optional(
    Type.Boolean({
      description: "Include source summary IDs.",
    })
  ),
});

const MULTI_DAY_ROLLUP_TARGET_TOKENS = 20_000;

type RollupStatus = "building" | "ready" | "stale" | "failed";
type RollupPeriodKind = "day" | "week" | "month";

type RollupRecord = {
  rollupId: string;
  conversationId: number;
  periodKind: RollupPeriodKind;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
  content: string;
  tokenCount: number;
  sourceSummaryIds: string[];
  sourceMessageCount: number;
  sourceTokenCount: number;
  status: RollupStatus;
  coverageStart: Date | null;
  coverageEnd: Date | null;
  summarizerModel: string | null;
  sourceFingerprint: string | null;
  builtAt: Date;
  invalidatedAt: Date | null;
  errorText: string | null;
};

type RecentSummaryFallbackRow = {
  summary_id: string;
  kind: string;
  content: string;
  token_count: number;
  created_at: string;
  effective_time: string;
};

type PeriodResolution = {
  label: string;
  kind?: RollupPeriodKind;
  periodKey?: string;
  start: Date;
  end: Date;
  window?: {
    day?: string;
    name?: string;
    startMinutes?: number;
    endMinutes?: number;
    relative?: boolean;
  };
};

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function formatDisplayTime(
  value: Date | string | number | null | undefined,
  timezone: string
): string {
  if (value == null) {
    return "-";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return formatTimestamp(date, timezone);
}

function getLcmRollupStore(
  lcm: LcmContextEngine,
  inputStore?: RollupStore
): RollupStore {
  const store = inputStore ?? lcm.getRollupStore?.();
  if (store?.db) {
    return store;
  }
  throw new Error("LCM rollup database is unavailable.");
}

function getPartsInTimezone(
  date: Date,
  timezone: string
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return { year, month, day };
}

function getZonedDayString(date: Date, timezone: string): string {
  const { year, month, day } = getPartsInTimezone(date, timezone);
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function getUtcDateForZonedMidnight(dayString: string, timezone: string): Date {
  try {
    return localDateTimeToUtc(dayString, "00:00:00", timezone);
  } catch (error) {
    for (let minuteOfDay = 1; minuteOfDay < 24 * 60; minuteOfDay += 1) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
      try {
        return localDateTimeToUtc(dayString, time, timezone);
      } catch {
        // Day boundaries use the first representable instant on DST-skipped-midnight days.
      }
    }
    throw error;
  }
}

function addDays(dayString: string, delta: number): string {
  assertValidDateKey(dayString, 'period date');
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day + delta, 0, 0, 0, 0));
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${String(
    date.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function startOfWeekDayString(dayString: string): string {
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const weekday = date.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(dayString, mondayOffset);
}

function startOfMonthDayString(dayString: string): string {
  const [year, month] = dayString.split("-");
  return `${year}-${month}-01`;
}

function assertValidDateKey(dateKey: string, label = 'date'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error(`${label} must be in the form "date:YYYY-MM-DD".`);
  }
  const probe = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== dateKey) {
    throw new Error(`${label} must be a real calendar date.`);
  }
}

function parseTimeParts(time: string): { hour: number; minute: number; second: number } {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new Error(`Invalid time: ${time}`);
  }
  const hour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  const second = Number.parseInt(match[3]!, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new Error(`Invalid time: ${time}`);
  }
  return { hour, minute, second };
}

function normalizeZonedParts(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  if (parts.hour != 24) {
    return parts;
  }
  const rolled = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, parts.minute, parts.second));
  rolled.setUTCDate(rolled.getUTCDate() + 1);
  return {
    year: rolled.getUTCFullYear(),
    month: rolled.getUTCMonth() + 1,
    day: rolled.getUTCDate(),
    hour: 0,
    minute: rolled.getUTCMinutes(),
    second: rolled.getUTCSeconds(),
  };
}

function getUtcDateForZonedLocalTime(
  dayString: string,
  timezone: string,
  minutesAfterMidnight: number
): Date {
  if (
    !Number.isInteger(minutesAfterMidnight) ||
    minutesAfterMidnight < 0 ||
    minutesAfterMidnight > 24 * 60
  ) {
    throw new Error("Window bounds must be within the local day.");
  }
  if (minutesAfterMidnight === 24 * 60) {
    return getUtcDateForZonedMidnight(addDays(dayString, 1), timezone);
  }
  const hour = Math.floor(minutesAfterMidnight / 60);
  const minute = minutesAfterMidnight % 60;
  return localDateTimeToUtc(
    dayString,
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    timezone
  );
}

function localDateTimeToUtc(
  dateKey: string,
  time: string,
  timezone: string
): Date {
  assertValidDateKey(dateKey, 'period date');
  const [year, month, day] = dateKey
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const { hour, minute, second } = parseTimeParts(time);
  let candidate = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, 0)
  );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getZonedDateTimeParts(candidate, timezone);
    const deltaMs =
      Date.UTC(year, month - 1, day, hour, minute, second, 0) -
      Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        0
      );
    if (deltaMs === 0) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + deltaMs);
  }

  throw new Error(
    `Nonexistent local time ${dateKey} ${time} in timezone ${timezone}`
  );
}

function getZonedDateTimeParts(
  date: Date,
  timezone: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return normalizeZonedParts({
    year: Number.parseInt(lookup.get("year") ?? "0", 10),
    month: Number.parseInt(lookup.get("month") ?? "1", 10),
    day: Number.parseInt(lookup.get("day") ?? "1", 10),
    hour: Number.parseInt(lookup.get("hour") ?? "0", 10),
    minute: Number.parseInt(lookup.get("minute") ?? "0", 10),
    second: Number.parseInt(lookup.get("second") ?? "0", 10),
  });
}

function isEndOfDayClockToken(raw: string): boolean {
  return /^24(?::00)?$/.test(raw.trim().toLowerCase().replace(/\s+/g, ""));
}

function parseClockToken(
  raw: string,
  options: { allowEndOfDay?: boolean } = {}
): number | null {
  const token = raw.trim().toLowerCase().replace(/\s+/g, "");
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(token);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = match[2] == null ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minute < 0 || minute > 59) {
    return null;
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    if (meridiem === "am") {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  } else if (hour === 24 && minute === 0 && options.allowEndOfDay) {
    return 24 * 60;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return hour * 60 + minute;
}

function inferWindowMeridiems(
  startRaw: string,
  endRaw: string
): { start: string; end: string } {
  const start = startRaw.trim().toLowerCase();
  const end = endRaw.trim().toLowerCase();
  const startMeridiem = /(am|pm)\b/.exec(start)?.[1];
  const endMeridiem = /(am|pm)\b/.exec(end)?.[1];
  if (startMeridiem && !endMeridiem && !isEndOfDayClockToken(end)) {
    return { start, end: `${end}${startMeridiem}` };
  }
  if (!startMeridiem && endMeridiem) {
    return { start: `${start}${endMeridiem}`, end };
  }
  return { start, end };
}

function parseNamedWindow(
  name: string
): { startMinutes: number; endMinutes: number; name: string } | null {
  switch (name.trim().toLowerCase()) {
    case "morning":
      return { name: "morning", startMinutes: 6 * 60, endMinutes: 12 * 60 };
    case "afternoon":
      return { name: "afternoon", startMinutes: 12 * 60, endMinutes: 17 * 60 };
    case "evening":
      return { name: "evening", startMinutes: 17 * 60, endMinutes: 22 * 60 };
    case "night":
      return { name: "night", startMinutes: 22 * 60, endMinutes: 24 * 60 };
    default:
      return null;
  }
}

function parseExplicitWindow(
  windowText: string
): { startMinutes: number; endMinutes: number; label: string } | null {
  const match = /^(.+?)\s*(?:-|–|—|to)\s*(.+)$/.exec(
    windowText.trim().toLowerCase()
  );
  if (!match) {
    return null;
  }

  const displayStartRaw = match[1].trim();
  const displayEndRaw = match[2].trim();
  const { start: startRaw, end: endRaw } = inferWindowMeridiems(
    displayStartRaw,
    displayEndRaw
  );
  const startMinutes = parseClockToken(startRaw);
  const endMinutes = parseClockToken(endRaw, { allowEndOfDay: true });
  if (
    startMinutes == null ||
    endMinutes == null ||
    endMinutes <= startMinutes
  ) {
    return null;
  }

  return {
    startMinutes,
    endMinutes,
    label: `${displayStartRaw}-${displayEndRaw}`,
  };
}

function parseBaseDay(
  baseText: string,
  today: string
): { day: string; label: string } | null {
  const base = baseText.trim().toLowerCase();
  if (base === "today") {
    return { day: today, label: "today" };
  }
  if (base === "yesterday") {
    return { day: addDays(today, -1), label: "yesterday" };
  }
  if (base.startsWith("date:")) {
    const day = base.slice(5).trim();
    try {
      assertValidDateKey(day, 'period date');
    } catch {
      return null;
    }
    return { day, label: day };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(base)) {
    try {
      assertValidDateKey(base, 'period date');
    } catch {
      return null;
    }
    return { day: base, label: base };
  }
  return null;
}

function resolveWindowPeriod(
  normalized: string,
  timezone: string,
  today: string
): PeriodResolution | null {
  const relative =
    /^last\s+(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/.exec(
      normalized
    );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const minutes = unit.startsWith("h") ? amount * 60 : amount;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return null;
    }
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60_000);
    return {
      label: `last ${amount}${unit.startsWith("h") ? "h" : "m"}`,
      start,
      end,
      window: { relative: true },
    };
  }

  const windowMatch =
    /^(today|yesterday|date:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(
      normalized
    );
  if (!windowMatch) {
    return null;
  }

  const base = parseBaseDay(windowMatch[1], today);
  if (!base) {
    return null;
  }

  const windowText = windowMatch[2].trim();
  const named = parseNamedWindow(windowText);
  const explicit = named ?? parseExplicitWindow(windowText);
  if (!explicit) {
    return null;
  }

  const start = getUtcDateForZonedLocalTime(
    base.day,
    timezone,
    explicit.startMinutes
  );
  const end = getUtcDateForZonedLocalTime(
    base.day,
    timezone,
    explicit.endMinutes
  );
  return {
    label: `${base.label} ${explicit.name ?? explicit.label}`,
    kind: "day",
    periodKey: base.day,
    start,
    end,
    window: {
      day: base.day,
      name: explicit.name ?? explicit.label,
      startMinutes: explicit.startMinutes,
      endMinutes: explicit.endMinutes,
    },
  };
}

function resolvePeriod(period: string, timezone: string): PeriodResolution {
  const normalized = period.trim().toLowerCase().replace(/\s+/g, " ");
  const now = new Date();
  const today = getZonedDayString(now, timezone);
  const windowPeriod = resolveWindowPeriod(normalized, timezone, today);
  if (windowPeriod) {
    return windowPeriod;
  }

  if (normalized === "today") {
    const start = getUtcDateForZonedMidnight(today, timezone);
    const end = getUtcDateForZonedMidnight(addDays(today, 1), timezone);
    return { label: "today", kind: "day", periodKey: today, start, end };
  }

  if (normalized === "yesterday") {
    const day = addDays(today, -1);
    const start = getUtcDateForZonedMidnight(day, timezone);
    const end = getUtcDateForZonedMidnight(today, timezone);
    return { label: "yesterday", kind: "day", periodKey: day, start, end };
  }

  if (normalized.startsWith("date:")) {
    const day = normalized.slice(5);
    assertValidDateKey(day, 'period date');
    const start = getUtcDateForZonedMidnight(day, timezone);
    const end = getUtcDateForZonedMidnight(addDays(day, 1), timezone);
    return { label: day, kind: "day", periodKey: day, start, end };
  }

  if (normalized === "7d") {
    const startDay = addDays(today, -6);
    return {
      label: "last 7 days",
      kind: "day",
      start: getUtcDateForZonedMidnight(startDay, timezone),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  if (normalized === "30d") {
    const startDay = addDays(today, -29);
    return {
      label: "last 30 days",
      kind: "day",
      start: getUtcDateForZonedMidnight(startDay, timezone),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  if (normalized === "week") {
    const weekStartDay = startOfWeekDayString(today);
    const start = getUtcDateForZonedMidnight(weekStartDay, timezone);
    const end = getUtcDateForZonedMidnight(addDays(weekStartDay, 7), timezone);
    return {
      label: `week of ${weekStartDay}`,
      kind: "week",
      periodKey: weekStartDay,
      start,
      end,
    };
  }

  if (normalized === "month") {
    const monthStartDay = startOfMonthDayString(today);
    const [year, month] = monthStartDay.split("-").map((part) => Number(part));
    const nextMonthStartDay = `${month === 12 ? year + 1 : year}-${String(
      month === 12 ? 1 : month + 1
    ).padStart(2, "0")}-01`;
    return {
      label: `${monthStartDay.slice(0, 7)}`,
      kind: "month",
      periodKey: monthStartDay.slice(0, 7),
      start: getUtcDateForZonedMidnight(monthStartDay, timezone),
      end: getUtcDateForZonedMidnight(nextMonthStartDay, timezone),
    };
  }

  throw new Error(
    'period must be one of "today", "yesterday", "7d", "week", "month", "30d", "date:YYYY-MM-DD", "today morning", "yesterday 4-8pm", "date:YYYY-MM-DD 14:00-16:30", "last Nh", or "last Nm".'
  );
}

function formatSourcesLine(
  summaryIds: string[],
  includeSources: boolean
): string {
  if (!includeSources || summaryIds.length === 0) {
    return "*Sources: omitted*";
  }
  return `*Sources: ${summaryIds.join(", ")}*`;
}

function formatDrilldownHint(includeSources: boolean): string {
  return includeSources
    ? "*Drill down: Use lcm_expand_query with these summaryIds for deeper recall*"
    : "*Drill down: Re-run with includeSources=true to reveal summaryIds for expansion*";
}

function combineRollups(rollups: RollupRecord[]): {
  content: string;
  tokenCount: number;
  status: "ready" | "stale";
  sourceSummaryIds: string[];
} {
  const retained = [...rollups];
  let tokenCount = retained.reduce(
    (sum, rollup) => sum + rollup.tokenCount,
    0
  );

  while (
    retained.length > 1 &&
    tokenCount > MULTI_DAY_ROLLUP_TARGET_TOKENS
  ) {
    const dropped = retained.shift();
    tokenCount -= dropped?.tokenCount ?? 0;
  }

  const omittedRollups = rollups.length - retained.length;
  const content = retained
    .map((rollup) => `### ${rollup.periodKey}\n\n${rollup.content.trim()}`)
    .join("\n\n");
  const cappedContent =
    omittedRollups > 0
      ? `(${omittedRollups} earlier rollups omitted to fit budget)\n\n${content}`
      : content;
  const sourceSummaryIds = [
    ...new Set(retained.flatMap((rollup) => rollup.sourceSummaryIds)),
  ];
  const status = retained.every((rollup) => rollup.status === "ready")
    ? "ready"
    : "stale";
  return { content: cappedContent, tokenCount, status, sourceSummaryIds };
}

function renderFallbackRollupSection(
  label: string,
  summaries: RecentSummaryFallbackRow[],
  timezone: string
): { content: string; summaryIds: string[] } {
  const lines = [`### ${label} (live fallback)`];
  if (summaries.length === 0) {
    lines.push("- No leaf summaries captured.");
  } else {
    for (const summary of summaries) {
      lines.push(
        `- [${summary.summary_id}] (${summary.kind}, ${formatDisplayTime(
          summary.effective_time,
          timezone
        )}): ${summary.content.replace(/\n/g, " ").trim()}`
      );
    }
  }
  return {
    content: lines.join("\n"),
    summaryIds: summaries.map((summary) => summary.summary_id),
  };
}

function getExpectedDayKeys(
  start: Date,
  end: Date,
  timezone: string
): string[] {
  if (end <= start) {
    return [];
  }
  const keys: string[] = [];
  let cursor = getZonedDayString(start, timezone);
  const lastKey = getZonedDayString(new Date(end.getTime() - 1), timezone);
  for (let guard = 0; guard < 370; guard += 1) {
    keys.push(cursor);
    if (cursor === lastKey) {
      return keys;
    }
    cursor = addDays(cursor, 1);
  }
  return keys;
}

function buildRecentSummaryRange(
  conversationId: number | undefined,
  start: Date,
  end: Date
): { whereClause: string; args: Array<string | number> } {
  const scopeClause = conversationId == null ? "" : "conversation_id = ? AND";
  return {
    whereClause: `${scopeClause}
         kind = 'leaf'
         AND julianday(coalesce(earliest_at, latest_at, created_at)) < julianday(?)
         AND julianday(coalesce(latest_at, earliest_at, created_at)) >= julianday(?)`,
    args:
      conversationId == null
        ? [end.toISOString(), start.toISOString()]
        : [conversationId, end.toISOString(), start.toISOString()],
  };
}

function getRecentSummaryFallback(
  db: DatabaseSync,
  conversationId: number | undefined,
  start: Date,
  end: Date
): RecentSummaryFallbackRow[] {
  const { whereClause, args } = buildRecentSummaryRange(
    conversationId,
    start,
    end
  );

  return db
    .prepare(
      `SELECT
        summary_id,
        kind,
        content,
        token_count,
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS created_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(latest_at, earliest_at, created_at)) AS effective_time
       FROM summaries
       WHERE ${whereClause}
       ORDER BY julianday(coalesce(latest_at, earliest_at, created_at)) DESC
       LIMIT 20`
    )
    .all(...args) as unknown as RecentSummaryFallbackRow[];
}

function countRecentSummaryFallback(
  db: DatabaseSync,
  conversationId: number | undefined,
  start: Date,
  end: Date
): number {
  const { whereClause, args } = buildRecentSummaryRange(
    conversationId,
    start,
    end
  );

  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM summaries
       WHERE ${whereClause}`
    )
    .get(...args) as { count: number } | undefined;
  return row?.count ?? 0;
}

function hasLeafSummariesInRange(
  db: DatabaseSync,
  conversationId: number | undefined,
  start: Date,
  end: Date
): boolean {
  const { whereClause, args } = buildRecentSummaryRange(
    conversationId,
    start,
    end
  );

  const row = db
    .prepare(
      `SELECT 1 AS present
       FROM summaries
       WHERE ${whereClause}
       LIMIT 1`
    )
    .get(...args) as { present: 1 } | undefined;
  return row != null;
}

function dayHasLeafSummaries(
  db: DatabaseSync,
  conversationId: number | undefined,
  dayKey: string,
  timezone: string
): boolean {
  return hasLeafSummariesInRange(
    db,
    conversationId,
    getUtcDateForZonedMidnight(dayKey, timezone),
    getUtcDateForZonedMidnight(addDays(dayKey, 1), timezone)
  );
}

export const __lcmRecentTestInternals = {
  resolvePeriod,
  getUtcDateForZonedMidnight,
  getUtcDateForZonedLocalTime,
};

export function createLcmRecentTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  rollupStore?: RollupStore;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_recent",
    label: "LCM Recent",
    description:
      "Retrieve recent activity from pre-built temporal rollups or a bounded leaf-summary SQL fallback. Supports daily/exact-date summaries plus sub-day local windows and relative windows without LLM calls. Use for questions like 'what happened today?' or 'what did we do yesterday 4-8pm?'.",
    parameters: LcmRecentSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }

      const p = params as Record<string, unknown>;
      const includeSources = p.includeSources === true;
      const timezone = lcm.timezone;
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });

      if (
        !conversationScope.allConversations &&
        conversationScope.conversationId == null
      ) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      let resolution: PeriodResolution;
      try {
        resolution = resolvePeriod(String(p.period ?? ""), timezone);
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : "Invalid period.",
        });
      }

      const rollupStore = getLcmRollupStore(lcm, input.rollupStore);
      const db = rollupStore.db;

      if (conversationScope.allConversations) {
        const recentSummaries = getRecentSummaryFallback(
          db,
          undefined,
          resolution.start,
          resolution.end
        );
        const totalMatches = countRecentSummaryFallback(
          db,
          undefined,
          resolution.start,
          resolution.end
        );
        const summaryIds = recentSummaries.map((summary) => summary.summary_id);

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}`);
        lines.push(
          `**Period:** ${formatDisplayTime(
            resolution.start,
            timezone
          )} — ${formatDisplayTime(resolution.end, timezone)}`
        );
        lines.push("**Status:** fallback");
        lines.push(`**Token count:** 0`);
        lines.push("");
        if (recentSummaries.length === 0) {
          lines.push(
            "No pre-built rollup found, and no leaf summaries were captured in this period."
          );
        } else {
          lines.push(
            "No pre-built rollup available. Here's what LCM captured for this period:"
          );
          lines.push("");
          for (const summary of recentSummaries) {
            lines.push(
              `- [${summary.summary_id}] (${summary.kind}, ${formatDisplayTime(
                summary.effective_time,
                timezone
              )}): ${summary.content.replace(/\n/g, " ").trim()}`
            );
          }
          lines.push("");
        }
        lines.push("---");
        lines.push(formatSourcesLine(summaryIds, includeSources));
        lines.push(formatDrilldownHint(includeSources));

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "fallback",
            usedFallback: true,
            totalMatches,
            summaryIds: includeSources ? summaryIds : [],
          },
        };
      }

      const conversationId = conversationScope.conversationId as number;

      let rollupContent: string | null = null;
      let tokenCount = 0;
      let status: "ready" | "stale" | "fallback" = "fallback";
      let sourceSummaryIds: string[] = [];
      let usedFallback = false;

      const now = new Date();
      const currentDayKey = getZonedDayString(now, timezone);
      const includesCurrentInstant =
        resolution.start.getTime() <= now.getTime() &&
        now.getTime() < resolution.end.getTime();

      if (
        resolution.kind &&
        resolution.periodKey &&
        !resolution.window &&
        !includesCurrentInstant
      ) {
        const rollup = rollupStore.getRollup(
          conversationId,
          resolution.kind,
          resolution.periodKey,
          timezone
        );
        if (
          rollup &&
          (rollup.status === "ready" || rollup.status === "stale")
        ) {
          rollupContent = rollup.content;
          tokenCount = rollup.token_count;
          status = rollup.status === "ready" ? "ready" : "stale";
          sourceSummaryIds = parseJsonStringArray(rollup.source_summary_ids);
        }
      } else if (
        resolution.kind &&
        !resolution.window &&
        (resolution.kind === "day" || !includesCurrentInstant)
      ) {
        const rollups = rollupStore
          .listRollups(conversationId, resolution.kind, 200)
          .filter((rollup) => rollup.timezone === timezone)
          .filter(
            (rollup) =>
              new Date(rollup.period_start) >= resolution.start &&
              new Date(rollup.period_start) < resolution.end
          );
        const usableRollups = rollups
          .filter(
            (rollup) => rollup.status === "ready" || rollup.status === "stale"
          )
          .map((rollup) => ({
            rollupId: rollup.rollup_id,
            conversationId: rollup.conversation_id,
            periodKind: rollup.period_kind,
            periodKey: rollup.period_key,
            periodStart: new Date(rollup.period_start),
            periodEnd: new Date(rollup.period_end),
            timezone: rollup.timezone,
            content: rollup.content,
            tokenCount: rollup.token_count,
            sourceSummaryIds: parseJsonStringArray(rollup.source_summary_ids),
            sourceMessageCount: rollup.source_message_count,
            sourceTokenCount: rollup.source_token_count,
            status: rollup.status,
            coverageStart: rollup.coverage_start
              ? new Date(rollup.coverage_start)
              : null,
            coverageEnd: rollup.coverage_end
              ? new Date(rollup.coverage_end)
              : null,
            summarizerModel: rollup.summarizer_model,
            sourceFingerprint: rollup.source_fingerprint,
            builtAt: new Date(rollup.built_at),
            invalidatedAt: rollup.invalidated_at
              ? new Date(rollup.invalidated_at)
              : null,
            errorText: rollup.error_text,
          }));
        const expectedKeys =
          resolution.kind === "day"
            ? getExpectedDayKeys(resolution.start, resolution.end, timezone)
            : [];
        const usableKeys = new Set(
          usableRollups.map((rollup) => rollup.periodKey)
        );
        const currentDayInWindow =
          resolution.kind === "day" && expectedKeys.includes(currentDayKey);
        const requiredKeys = currentDayInWindow
          ? expectedKeys.filter((key) => key !== currentDayKey)
          : expectedKeys;
        const hasCompleteCoverage =
          resolution.kind !== "day" ||
          (expectedKeys.length > 0 &&
            requiredKeys.every(
              (key) =>
                usableKeys.has(key) ||
                !dayHasLeafSummaries(db, conversationId, key, timezone)
            ));
        const hasStoredCoverage =
          resolution.kind === "day"
            ? requiredKeys.some((key) => usableKeys.has(key))
            : usableRollups.length > 0;
        if (hasStoredCoverage && hasCompleteCoverage) {
          const orderedRollups =
            resolution.kind === "day"
              ? requiredKeys
                  .map((key) => usableRollups.find((rollup) => rollup.periodKey === key))
                  .filter((rollup): rollup is RollupRecord => rollup != null)
              : usableRollups.sort(
                  (left, right) =>
                    left.periodStart.getTime() - right.periodStart.getTime()
                );
          const combined = combineRollups(orderedRollups);
          const liveSections: string[] = [];
          const liveSummaryIds: string[] = [];
          if (currentDayInWindow) {
            const currentStart = getUtcDateForZonedMidnight(
              currentDayKey,
              timezone
            );
            const currentEnd = new Date(
              Math.min(
                resolution.end.getTime(),
                getUtcDateForZonedMidnight(
                  addDays(currentDayKey, 1),
                  timezone
                ).getTime()
              )
            );
            const live = renderFallbackRollupSection(
              currentDayKey,
              getRecentSummaryFallback(db, conversationId, currentStart, currentEnd),
              timezone
            );
            liveSections.push(live.content);
            liveSummaryIds.push(...live.summaryIds);
            usedFallback = true;
          }
          rollupContent = combined.content;
          if (liveSections.length > 0) {
            rollupContent = [rollupContent, ...liveSections]
              .filter((section) => section.trim().length > 0)
              .join("\n\n");
          }
          tokenCount = combined.tokenCount;
          status = combined.status;
          sourceSummaryIds = [...combined.sourceSummaryIds, ...liveSummaryIds];
        }
      }

      if (rollupContent == null) {
        const recentSummaries = getRecentSummaryFallback(
          db,
          conversationId,
          resolution.start,
          resolution.end
        );
        const totalMatches = countRecentSummaryFallback(
          db,
          conversationId,
          resolution.start,
          resolution.end
        );

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}`);
        lines.push(
          `**Period:** ${formatDisplayTime(
            resolution.start,
            timezone
          )} — ${formatDisplayTime(resolution.end, timezone)}`
        );
        lines.push("**Status:** fallback");
        lines.push("**Token count:** 0");
        lines.push("");
        if (recentSummaries.length === 0) {
          lines.push(
            "No pre-built rollup available, and LCM captured no leaf summaries for this period."
          );
        } else {
          lines.push(
            "No pre-built rollup available. Here's what LCM captured for this period:"
          );
          lines.push("");
          for (const summary of recentSummaries) {
            lines.push(
              `- [${summary.summary_id}] (${summary.kind}, ${formatDisplayTime(
                summary.effective_time,
                timezone
              )}): ${summary.content.replace(/\n/g, " ").trim()}`
            );
          }
          lines.push("");
          sourceSummaryIds = recentSummaries.map(
            (summary) => summary.summary_id
          );
        }
        lines.push("---");
        lines.push(formatSourcesLine(sourceSummaryIds, includeSources));
        lines.push(formatDrilldownHint(includeSources));

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "fallback",
            usedFallback: true,
            totalMatches,
            summaryIds: includeSources ? sourceSummaryIds : [],
          },
        };
      }

      const lines: string[] = [];
      lines.push(`## Recent Activity: ${resolution.label}`);
      lines.push(
        `**Period:** ${formatDisplayTime(
          resolution.start,
          timezone
        )} — ${formatDisplayTime(resolution.end, timezone)}`
      );
      lines.push(`**Status:** ${status}`);
      lines.push(`**Token count:** ${tokenCount}`);
      lines.push("");
      lines.push(rollupContent.trim());
      lines.push("");
      lines.push("---");
      lines.push(formatSourcesLine(sourceSummaryIds, includeSources));
      lines.push(formatDrilldownHint(includeSources));

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          status,
          usedFallback,
          tokenCount,
          summaryIds: includeSources ? sourceSummaryIds : [],
        },
      };
    },
  };
}
