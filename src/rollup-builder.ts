import * as crypto from "node:crypto";
import { withDatabaseTransaction } from "./transaction-mutex.js";
import type { LeafSummaryForDayRow, RollupRow, RollupStateRow, RollupStore } from "./store/rollup-store.js";

const DEFAULT_DAILY_TARGET_TOKENS = 5_000;
const DEFAULT_DAILY_MAX_TOKENS = 15_000;
const TIMELINE_SENTENCE_LIMIT = 3;
const TIMELINE_MAX_CHARS = 500;
const PERIOD_KIND = "day";

export interface RollupBuilderConfig {
  timezone: string;
  dailyTargetTokens?: number;
  dailyMaxTokens?: number;
}

export interface BuildResult {
  built: number;
  skipped: number;
  errors: string[];
}

type RollupSourceRecord = {
  type: "summary" | "rollup";
  id: string;
  ordinal: number;
};

type SummaryRecord = {
  summaryId: string;
  content: string;
  tokenCount: number;
  earliestAt: Date | null;
  latestAt: Date | null;
  createdAt: Date;
  kind: "leaf" | "condensed";
};

type TimelineEntry = {
  summaryId: string;
  timeLabel: string;
  content: string;
  tokenCount: number;
  sourceCreatedAt: Date;
};

type RollupDraft = {
  content: string;
  summaryTokenCount: number;
  omittedEntries: number;
};

export class RollupBuilder {
  private readonly dailyTargetTokens: number;
  private readonly dailyMaxTokens: number;

  constructor(
    private store: RollupStore,
    private config: RollupBuilderConfig,
  ) {
    this.dailyTargetTokens = normalizePositiveInt(
      config.dailyTargetTokens,
      DEFAULT_DAILY_TARGET_TOKENS,
    );
    this.dailyMaxTokens = Math.max(
      this.dailyTargetTokens,
      normalizePositiveInt(config.dailyMaxTokens, DEFAULT_DAILY_MAX_TOKENS),
    );
  }

  async buildDailyRollups(
    conversationId: number,
    options: { forceCurrentDay?: boolean; daysBack?: number } = {},
  ): Promise<BuildResult> {
    const result: BuildResult = { built: 0, skipped: 0, errors: [] };
    const daysBack = normalizePositiveInt(options.daysBack, 7);
    const forceCurrentDay = options.forceCurrentDay === true;
    const now = new Date();
    const todayKey = getLocalDateKey(now, this.config.timezone);

    let state: RollupStateRow | null;
    try {
      state = this.store.getState(conversationId);
    } catch (error) {
      result.errors.push(`state lookup failed: ${formatError(error)}`);
      return result;
    }

    if (state && state.pending_rebuild === 0 && !forceCurrentDay) {
      result.skipped += daysBack;
      return result;
    }

    for (let offset = 0; offset < daysBack; offset += 1) {
      const candidateDate = shiftLocalDate(now, this.config.timezone, -offset);
      const dateKey = getLocalDateKey(candidateDate, this.config.timezone);
      if (!forceCurrentDay && dateKey === todayKey) {
        result.skipped += 1;
        continue;
      }

      const { start, end } = getLocalDayBounds(candidateDate, this.config.timezone);
      let summaries: SummaryRecord[];
      try {
        summaries = this.getLeafSummariesForDay(conversationId, start, end);
      } catch (error) {
        result.errors.push(`${dateKey}: leaf summary lookup failed: ${formatError(error)}`);
        continue;
      }

      const leafSummaries = summaries
        .filter((summary) => summary.kind === "leaf")
        .sort(compareSummariesChronologically);
      if (leafSummaries.length === 0) {
        result.skipped += 1;
        continue;
      }

      const totalTokens = leafSummaries.reduce((sum, summary) => sum + safeTokenCount(summary.tokenCount), 0);
      const fingerprint = computeFingerprint(
        leafSummaries.map((summary) => summary.summaryId),
        totalTokens,
      );

      let existing: RollupRow | null = null;
      try {
        existing = this.store.getRollup(conversationId, PERIOD_KIND, dateKey);
      } catch (error) {
        result.errors.push(`${dateKey}: existing rollup lookup failed: ${formatError(error)}`);
        continue;
      }

      if (existing?.source_fingerprint === fingerprint) {
        result.skipped += 1;
        continue;
      }

      try {
        const built = await this.buildDayRollup(conversationId, dateKey);
        if (built) {
          result.built += 1;
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        result.errors.push(`${dateKey}: build failed: ${formatError(error)}`);
      }
    }

    return result;
  }

  async buildDayRollup(conversationId: number, dateKey: string): Promise<boolean> {
    const localDate = parseDateKey(dateKey);
    const { start, end } = getLocalDayBounds(localDate, this.config.timezone);
    const summaries = this.getLeafSummariesForDay(conversationId, start, end)
      .filter((summary) => summary.kind === "leaf")
      .sort(compareSummariesChronologically);

    if (summaries.length === 0) {
      return false;
    }

    const totalSourceTokens = summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.tokenCount),
      0,
    );
    const fingerprint = computeFingerprint(
      summaries.map((summary) => summary.summaryId),
      totalSourceTokens,
    );
    const draft = buildDailyRollupContent({
      dateKey,
      summaries,
      timezone: this.config.timezone,
      maxTokens: this.dailyMaxTokens,
    });
    const existing = this.store.getRollup(conversationId, PERIOD_KIND, dateKey);
    const rollupId = existing?.rollup_id ?? buildRollupId(PERIOD_KIND, dateKey);
    const builtAt = new Date();

    await withDatabaseTransaction(this.store.db, "BEGIN IMMEDIATE", () => {
      if (
        existing?.rollup_id
        && existing.source_fingerprint
        && existing.source_fingerprint !== fingerprint
      ) {
        this.store.markStale(existing.rollup_id);
      }

      this.store.upsertRollup({
        rollup_id: rollupId,
        conversation_id: conversationId,
        period_kind: PERIOD_KIND,
        period_key: dateKey,
        period_start: start.toISOString(),
        period_end: end.toISOString(),
        timezone: this.config.timezone,
        content: draft.content,
        token_count: draft.summaryTokenCount,
        source_summary_ids: JSON.stringify(summaries.map((summary) => summary.summaryId)),
        source_message_count: 0,
        source_token_count: totalSourceTokens,
        status: "building",
        coverage_start:
          summaries[0]?.earliestAt?.toISOString() ?? summaries[0]?.createdAt.toISOString() ?? null,
        coverage_end:
          summaries[summaries.length - 1]?.latestAt?.toISOString()
          ?? summaries[summaries.length - 1]?.createdAt.toISOString()
          ?? null,
        summarizer_model: "concatenation-v1",
        source_fingerprint: fingerprint,
      });

      this.store.replaceRollupSources(
        rollupId,
        summaries.map((summary, index) => ({
          type: "summary",
          id: summary.summaryId,
          ordinal: index,
        })),
      );

      this.store.upsertRollup({
        rollup_id: rollupId,
        conversation_id: conversationId,
        period_kind: PERIOD_KIND,
        period_key: dateKey,
        period_start: start.toISOString(),
        period_end: end.toISOString(),
        timezone: this.config.timezone,
        content: draft.content,
        token_count: draft.summaryTokenCount,
        source_summary_ids: JSON.stringify(summaries.map((summary) => summary.summaryId)),
        source_message_count: 0,
        source_token_count: totalSourceTokens,
        status: "ready",
        coverage_start:
          summaries[0]?.earliestAt?.toISOString() ?? summaries[0]?.createdAt.toISOString() ?? null,
        coverage_end:
          summaries[summaries.length - 1]?.latestAt?.toISOString()
          ?? summaries[summaries.length - 1]?.createdAt.toISOString()
          ?? null,
        summarizer_model: "concatenation-v1",
        source_fingerprint: fingerprint,
      });

      this.store.upsertState(conversationId, {
        timezone: this.config.timezone,
        last_daily_build_at: builtAt.toISOString(),
        last_rollup_check_at: builtAt.toISOString(),
        pending_rebuild: 0,
      });
    });

    return true;
  }

  private getLeafSummariesForDay(conversationId: number, start: Date, end: Date): SummaryRecord[] {
    return this.store
      .getLeafSummariesForDay(conversationId, start.toISOString(), end.toISOString())
      .map((summary: LeafSummaryForDayRow) => ({
        summaryId: summary.summary_id,
        content: summary.content,
        tokenCount: summary.token_count,
        earliestAt: summary.earliest_at ? new Date(summary.earliest_at) : null,
        latestAt: summary.latest_at ? new Date(summary.latest_at) : null,
        createdAt: new Date(summary.created_at),
        kind: "leaf",
      }));
  }
}

export function computeFingerprint(summaryIds: string[], totalTokens: number): string {
  const data = [...summaryIds].sort().join(",") + `:${Math.max(0, Math.floor(totalTokens))}`;
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export function getLocalDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function getLocalDayBounds(date: Date, timezone: string): { start: Date; end: Date } {
  const dateKey = getLocalDateKey(date, timezone);
  const start = localDateTimeToUtc(dateKey, "00:00:00", timezone);
  const end = localDateTimeToUtc(shiftDateKey(dateKey, 1), "00:00:00", timezone);
  return { start, end };
}

function buildRollupId(periodKind: string, periodKey: string): string {
  return `rollup_${periodKind}_${periodKey}_${crypto.randomUUID().slice(0, 8)}`;
}

function buildDailyRollupContent(params: {
  dateKey: string;
  summaries: SummaryRecord[];
  timezone: string;
  maxTokens: number;
}): RollupDraft {
  const entries = params.summaries.map((summary) => buildTimelineEntry(summary, params.timezone));
  const keyItems = extractKeyItems(params.summaries);
  const stats = buildStatistics(params.summaries, params.timezone);

  let timelineEntries = [...entries];
  let omittedEntries = 0;
  let content = renderDailyRollup({
    dateKey: params.dateKey,
    entries: timelineEntries,
    omittedEntries,
    keyItems,
    stats,
  });

  while (timelineEntries.length > 0 && estimateTokens(content) > params.maxTokens) {
    timelineEntries = timelineEntries.slice(1);
    omittedEntries += 1;
    content = renderDailyRollup({
      dateKey: params.dateKey,
      entries: timelineEntries,
      omittedEntries,
      keyItems,
      stats,
    });
  }

  if (timelineEntries.length === 0 && estimateTokens(content) > params.maxTokens) {
    const fallback = renderDailyRollup({
      dateKey: params.dateKey,
      entries: [],
      omittedEntries: entries.length,
      keyItems,
      stats,
    });
    return {
      content: fallback,
      summaryTokenCount: estimateTokens(fallback),
      omittedEntries: entries.length,
    };
  }

  return {
    content,
    summaryTokenCount: estimateTokens(content),
    omittedEntries,
  };
}

function renderDailyRollup(params: {
  dateKey: string;
  entries: TimelineEntry[];
  omittedEntries: number;
  keyItems: { decisions: string[]; completed: string[]; blockers: string[] };
  stats: { leafSummaries: number; timeSpan: string; totalSourceTokens: number };
}): string {
  const timelineLines: string[] = [];
  if (params.omittedEntries > 0) {
    timelineLines.push(`- (${params.omittedEntries} earlier entries omitted)`);
  }
  if (params.entries.length === 0) {
    timelineLines.push("- No retained timeline entries.");
  } else {
    for (const entry of params.entries) {
      timelineLines.push(`- [${entry.timeLabel}] ${entry.content}`);
    }
  }

  return [
    `# Daily Summary: ${params.dateKey}`,
    "",
    "## Activity Timeline",
    ...timelineLines,
    "",
    "## Key Items",
    `- Decisions: ${formatList(params.keyItems.decisions)}`,
    `- Completed: ${formatList(params.keyItems.completed)}`,
    `- Blockers: ${formatList(params.keyItems.blockers)}`,
    "",
    "## Statistics",
    `- Leaf summaries: ${params.stats.leafSummaries}`,
    `- Time span: ${params.stats.timeSpan}`,
    `- Total source tokens: ${params.stats.totalSourceTokens}`,
  ].join("\n");
}

function buildTimelineEntry(summary: SummaryRecord, timezone: string): TimelineEntry {
  const sourceCreatedAt = summary.earliestAt ?? summary.createdAt;
  return {
    summaryId: summary.summaryId,
    timeLabel: formatTime(sourceCreatedAt, timezone),
    content: summariseTimelineContent(summary.content),
    tokenCount: safeTokenCount(summary.tokenCount),
    sourceCreatedAt,
  };
}

function summariseTimelineContent(content: string): string {
  const normalized = normalizeWhitespace(content);
  if (!normalized) {
    return "(empty summary content)";
  }

  const sentences = splitIntoSentences(normalized).slice(0, TIMELINE_SENTENCE_LIMIT);
  const summary = sentences.length > 0 ? sentences.join(" ") : normalized;
  if (summary.length <= TIMELINE_MAX_CHARS) {
    return summary;
  }
  return `${summary.slice(0, TIMELINE_MAX_CHARS - 1).trimEnd()}…`;
}

function extractKeyItems(summaries: SummaryRecord[]): {
  decisions: string[];
  completed: string[];
  blockers: string[];
} {
  const buckets = {
    decisions: collectMatchingLines(summaries, /\b(decided|decision|chose|agreed)\b/i),
    completed: collectMatchingLines(summaries, /\b(completed|done|finished|shipped|merged|deployed)\b/i),
    blockers: collectMatchingLines(summaries, /\b(blocked|failed|error|issue|broken)\b/i),
  };
  return buckets;
}

function collectMatchingLines(summaries: SummaryRecord[], pattern: RegExp): string[] {
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const summary of summaries) {
    const lines = summary.content
      .split(/\r?\n+/)
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    for (const line of lines) {
      if (!pattern.test(line)) {
        continue;
      }
      const cleaned = stripBulletPrefix(line);
      const key = cleaned.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      matches.push(cleaned);
    }
  }
  return matches;
}

function buildStatistics(
  summaries: SummaryRecord[],
  timezone: string,
): { leafSummaries: number; timeSpan: string; totalSourceTokens: number } {
  const orderedTimes = summaries
    .map((summary) => summary.earliestAt ?? summary.createdAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  const latestTimes = summaries
    .map((summary) => summary.latestAt ?? summary.createdAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());

  const start = orderedTimes[0] ?? summaries[0]?.createdAt ?? new Date();
  const end = latestTimes[latestTimes.length - 1] ?? summaries[summaries.length - 1]?.createdAt ?? start;

  return {
    leafSummaries: summaries.length,
    timeSpan: `${formatTime(start, timezone)} — ${formatTime(end, timezone)}`,
    totalSourceTokens: summaries.reduce((sum, summary) => sum + safeTokenCount(summary.tokenCount), 0),
  };
}

function compareSummariesChronologically(left: SummaryRecord, right: SummaryRecord): number {
  const leftTime = (left.earliestAt ?? left.createdAt).getTime();
  const rightTime = (right.earliestAt ?? right.createdAt).getTime();
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.summaryId.localeCompare(right.summaryId);
}

function formatTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join("; ") : "None";
}

function safeTokenCount(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function estimateTokens(content: string): number {
  const text = content.trim();
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitIntoSentences(value: string): string[] {
  const matches = value.match(/[^.!?\n]+(?:[.!?]+|$)/g);
  return matches?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function stripBulletPrefix(value: string): string {
  return value.replace(/^[-*•\d.)\s]+/, "").trim();
}

function parseDateKey(dateKey: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  return new Date(`${dateKey}T12:00:00.000Z`);
}

function shiftLocalDate(date: Date, timezone: string, dayDelta: number): Date {
  const dateKey = getLocalDateKey(date, timezone);
  return parseDateKey(shiftDateKey(dateKey, dayDelta));
}

function shiftDateKey(dateKey: string, dayDelta: number): string {
  const utcDate = new Date(`${dateKey}T00:00:00.000Z`);
  utcDate.setUTCDate(utcDate.getUTCDate() + dayDelta);
  return utcDate.toISOString().slice(0, 10);
}

function localDateTimeToUtc(dateKey: string, time: string, timezone: string): Date {
  const [year, month, day] = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  const [hour, minute, second] = time.split(":").map((part) => Number.parseInt(part, 10));
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  const offsetMs = getTimeZoneOffsetMs(utcGuess, timezone);
  return new Date(utcGuess.getTime() - offsetMs);
}

function getTimeZoneOffsetMs(date: Date, timezone: string): number {
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
  const localAsUtc = Date.UTC(
    Number.parseInt(lookup.get("year") ?? "0", 10),
    Number.parseInt(lookup.get("month") ?? "1", 10) - 1,
    Number.parseInt(lookup.get("day") ?? "1", 10),
    Number.parseInt(lookup.get("hour") ?? "0", 10),
    Number.parseInt(lookup.get("minute") ?? "0", 10),
    Number.parseInt(lookup.get("second") ?? "0", 10),
  );
  return localAsUtc - date.getTime();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
