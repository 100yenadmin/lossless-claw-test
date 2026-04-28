import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import { formatTimestamp } from "../compaction.js";
import type { LcmContextEngine } from "../engine.js";
import type { RollupStore } from "../store/rollup-store.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const LcmRecentSchema = Type.Object({
  period: Type.String({
    description:
      'Time period: "today", "yesterday", "7d", "week", "month", "30d", or "date:YYYY-MM-DD"',
  }),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to current session.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description: "Search all conversations.",
    }),
  ),
  includeSources: Type.Optional(
    Type.Boolean({
      description: "Include source summary IDs.",
    }),
  ),
});

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
};

function isStrictIsoDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  const [year, month, date] = day.split("-").map((part) => Number(part));
  const candidate = new Date(Date.UTC(year, month - 1, date, 12, 0, 0, 0));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() + 1 === month &&
    candidate.getUTCDate() === date
  );
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function formatDisplayTime(
  value: Date | string | number | null | undefined,
  timezone: string,
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

function getPartsInTimezone(date: Date, timezone: string): { year: number; month: number; day: number } {
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
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function getUtcDateForZonedMidnight(dayString: string, timezone: string): Date {
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const approxUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(approxUtc);
  const zonedYear = Number(parts.find((part) => part.type === "year")?.value);
  const zonedMonth = Number(parts.find((part) => part.type === "month")?.value);
  const zonedDay = Number(parts.find((part) => part.type === "day")?.value);
  const zonedHour = Number(parts.find((part) => part.type === "hour")?.value);
  const zonedMinute = Number(parts.find((part) => part.type === "minute")?.value);
  const zonedSecond = Number(parts.find((part) => part.type === "second")?.value);
  const asUtc = Date.UTC(zonedYear, zonedMonth - 1, zonedDay, zonedHour, zonedMinute, zonedSecond);
  const desiredUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return new Date(approxUtc.getTime() - (asUtc - desiredUtc));
}

function addDays(dayString: string, delta: number): string {
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day + delta, 0, 0, 0, 0));
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
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

function resolvePeriod(period: string, timezone: string): PeriodResolution {
  const normalized = period.trim().toLowerCase();
  const now = new Date();
  const today = getZonedDayString(now, timezone);

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
    if (!isStrictIsoDay(day)) {
      throw new Error('period date must be in the form "date:YYYY-MM-DD".');
    }
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
    const nextMonthStartDay = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
    return {
      label: `${monthStartDay.slice(0, 7)}`,
      kind: "month",
      periodKey: monthStartDay.slice(0, 7),
      start: getUtcDateForZonedMidnight(monthStartDay, timezone),
      end: getUtcDateForZonedMidnight(nextMonthStartDay, timezone),
    };
  }

  throw new Error(
    'period must be one of "today", "yesterday", "7d", "week", "month", "30d", or "date:YYYY-MM-DD".',
  );
}

function formatSourcesLine(summaryIds: string[], includeSources: boolean): string {
  if (!includeSources || summaryIds.length === 0) {
    return "*Sources: omitted*";
  }
  return `*Sources: ${summaryIds.join(", ")}*`;
}

function combineRollups(rollups: RollupRecord[]): {
  content: string;
  tokenCount: number;
  status: "ready" | "stale";
  sourceSummaryIds: string[];
} {
  const content = rollups
    .map((rollup) => `### ${rollup.periodKey}\n\n${rollup.content.trim()}`)
    .join("\n\n");
  const tokenCount = rollups.reduce((sum, rollup) => sum + rollup.tokenCount, 0);
  const sourceSummaryIds = [...new Set(rollups.flatMap((rollup) => rollup.sourceSummaryIds))];
  const status = rollups.every((rollup) => rollup.status === "ready") ? "ready" : "stale";
  return { content, tokenCount, status, sourceSummaryIds };
}

function getExpectedDayKeys(start: Date, end: Date, timezone: string): string[] {
  const keys: string[] = [];
  let current = getZonedDayString(start, timezone);
  const endKey = getZonedDayString(end, timezone);
  while (current < endKey) {
    keys.push(current);
    current = addDays(current, 1);
  }
  return keys;
}

function getRecentSummaryFallback(
  db: DatabaseSync,
  conversationId: number | undefined,
  start: Date,
  end: Date,
): RecentSummaryFallbackRow[] {
  const scopeClause = conversationId == null ? "" : "conversation_id = ? AND";
  const args: Array<string | number> = conversationId == null
    ? [end.toISOString(), start.toISOString()]
    : [conversationId, end.toISOString(), start.toISOString()];

  return db
    .prepare(
      `SELECT
        summary_id,
        kind,
        content,
        token_count,
        created_at,
        coalesce(latest_at, earliest_at, created_at) AS effective_time
       FROM summaries
       WHERE ${scopeClause}
         kind = 'leaf'
         AND julianday(coalesce(earliest_at, latest_at, created_at)) < julianday(?)
         AND julianday(coalesce(latest_at, earliest_at, created_at)) >= julianday(?)
       ORDER BY julianday(coalesce(latest_at, earliest_at, created_at)) DESC
       LIMIT 20`,
    )
    .all(...args) as unknown as RecentSummaryFallbackRow[];
}

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
      "Retrieve recent activity summaries from pre-built temporal rollups. Returns daily, weekly, or monthly summaries without LLM calls. Use for questions like 'what happened today?', 'what did we do yesterday?', or recap requests. Falls back to a direct time-bounded SQL query over leaf summaries when no rollup exists.",
    parameters: LcmRecentSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }

      const p = params as Record<string, unknown>;
      const includeSources = p.includeSources === true;
      const timezone = lcm.timezone;
      const rollupStore = input.rollupStore ?? lcm.getRollupStore();
      const db = rollupStore.db;
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });

      if (!conversationScope.allConversations && conversationScope.conversationId == null) {
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

      if (conversationScope.allConversations) {
        const recentSummaries = getRecentSummaryFallback(
          db,
          undefined,
          resolution.start,
          resolution.end,
        );
        const summaryIds = recentSummaries.map((summary) => summary.summary_id);

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}`);
        lines.push(
          `**Period:** ${formatDisplayTime(resolution.start, timezone)} — ${formatDisplayTime(resolution.end, timezone)}`,
        );
        lines.push("**Status:** fallback");
        lines.push(`**Token count:** 0`);
        lines.push("");
        if (recentSummaries.length === 0) {
          lines.push("No pre-built rollup found, and no leaf summaries were captured in this period.");
        } else {
          lines.push("No pre-built rollup available. Here's what LCM captured for this period:");
          lines.push("");
          for (const summary of recentSummaries) {
            lines.push(
              `- [${summary.summary_id}] (${summary.kind}, ${formatDisplayTime(summary.effective_time, timezone)}): ${summary.content.replace(/\n/g, " ").trim()}`,
            );
          }
          lines.push("");
        }
        lines.push("---");
        lines.push(formatSourcesLine(summaryIds, includeSources));
        lines.push("*Drill down: Use lcm_expand_query with matching summaryIds for deeper recall*");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "fallback",
            usedFallback: true,
            totalMatches: recentSummaries.length,
            summaryIds,
          },
        };
      }

      const conversationId = conversationScope.conversationId as number;

      let rollupContent: string | null = null;
      let tokenCount = 0;
      let status: "ready" | "stale" | "fallback" = "fallback";
      let sourceSummaryIds: string[] = [];

      if (resolution.kind && resolution.periodKey) {
        const rollup = rollupStore.getRollup(conversationId, resolution.kind, resolution.periodKey);
        if (rollup && (rollup.status === "ready" || rollup.status === "stale")) {
          rollupContent = rollup.content;
          tokenCount = rollup.token_count;
          status = rollup.status === "ready" ? "ready" : "stale";
          sourceSummaryIds = parseJsonStringArray(rollup.source_summary_ids);
        }
      } else if (resolution.kind) {
        const rollups = rollupStore.listRollups(conversationId, resolution.kind, 200)
          .filter((rollup) => new Date(rollup.period_start) >= resolution.start && new Date(rollup.period_start) < resolution.end);
        const usableRollups = rollups.filter((rollup) => rollup.status === "ready" || rollup.status === "stale").map((rollup) => ({
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
          coverageStart: rollup.coverage_start ? new Date(rollup.coverage_start) : null,
          coverageEnd: rollup.coverage_end ? new Date(rollup.coverage_end) : null,
          summarizerModel: rollup.summarizer_model,
          sourceFingerprint: rollup.source_fingerprint,
          builtAt: new Date(rollup.built_at),
          invalidatedAt: rollup.invalidated_at ? new Date(rollup.invalidated_at) : null,
          errorText: rollup.error_text,
        }));
        const expectedDayKeys =
          resolution.kind === "day"
            ? getExpectedDayKeys(resolution.start, resolution.end, timezone)
            : [];
        const usableByKey = new Map(
          usableRollups.map((rollup) => [rollup.periodKey, rollup])
        );
        const completeWindow =
          resolution.kind !== "day" ||
          expectedDayKeys.every((key) => usableByKey.has(key));
        if (usableRollups.length > 0 && completeWindow) {
          const orderedRollups =
            resolution.kind === "day"
              ? expectedDayKeys
                  .map((key) => usableByKey.get(key))
                  .filter((rollup): rollup is RollupRecord => rollup != null)
              : usableRollups.sort(
                  (left, right) =>
                    left.periodStart.getTime() - right.periodStart.getTime()
                );
          const combined = combineRollups(orderedRollups);
          rollupContent = combined.content;
          tokenCount = combined.tokenCount;
          status = combined.status;
          sourceSummaryIds = combined.sourceSummaryIds;
        }
      }

      if (rollupContent == null) {
        const recentSummaries = getRecentSummaryFallback(db, conversationId, resolution.start, resolution.end);

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}`);
        lines.push(
          `**Period:** ${formatDisplayTime(resolution.start, timezone)} — ${formatDisplayTime(resolution.end, timezone)}`,
        );
        lines.push("**Status:** fallback");
        lines.push("**Token count:** 0");
        lines.push("");
        if (recentSummaries.length === 0) {
          lines.push("No pre-built rollup available, and LCM captured no leaf summaries for this period.");
        } else {
          lines.push("No pre-built rollup available. Here's what LCM captured for this period:");
          lines.push("");
          for (const summary of recentSummaries) {
            lines.push(
              `- [${summary.summary_id}] (${summary.kind}, ${formatDisplayTime(summary.effective_time, timezone)}): ${summary.content.replace(/\n/g, " ").trim()}`,
            );
          }
          lines.push("");
          sourceSummaryIds = recentSummaries.map((summary) => summary.summary_id);
        }
        lines.push("---");
        lines.push(formatSourcesLine(sourceSummaryIds, includeSources));
        lines.push("*Drill down: Use lcm_expand_query with these summaryIds for deeper recall*");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "fallback",
            usedFallback: true,
            totalMatches: recentSummaries.length,
            summaryIds: sourceSummaryIds,
          },
        };
      }

      const lines: string[] = [];
      lines.push(`## Recent Activity: ${resolution.label}`);
      lines.push(
        `**Period:** ${formatDisplayTime(resolution.start, timezone)} — ${formatDisplayTime(resolution.end, timezone)}`,
      );
      lines.push(`**Status:** ${status}`);
      lines.push(`**Token count:** ${tokenCount}`);
      lines.push("");
      lines.push(rollupContent.trim());
      lines.push("");
      lines.push("---");
      lines.push(formatSourcesLine(sourceSummaryIds, includeSources));
      lines.push("*Drill down: Use lcm_expand_query with these summaryIds for deeper recall*");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          status,
          usedFallback: false,
          tokenCount,
          summaryIds: sourceSummaryIds,
        },
      };
    },
  };
}
