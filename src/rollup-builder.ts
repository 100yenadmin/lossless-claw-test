import * as crypto from "node:crypto";
import { withDatabaseTransaction } from "./transaction-mutex.js";
import type {
  LeafSummaryForDayRow,
  RollupRow,
  RollupStateRow,
  RollupStore,
} from "./store/rollup-store.js";

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
  sourceMessageCount: number;
  earliestAt: Date | null;
  latestAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
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

type KeyItems = {
  decisions: string[];
  completed: string[];
  blockers: string[];
};

export class RollupBuilder {
  private readonly dailyMaxTokens: number;

  constructor(private store: RollupStore, private config: RollupBuilderConfig) {
    const dailyTargetTokens = normalizePositiveInt(
      config.dailyTargetTokens,
      DEFAULT_DAILY_TARGET_TOKENS
    );
    this.dailyMaxTokens = Math.max(
      dailyTargetTokens,
      normalizePositiveInt(config.dailyMaxTokens, DEFAULT_DAILY_MAX_TOKENS)
    );
  }

  async buildDailyRollups(
    conversationId: number,
    options: { forceCurrentDay?: boolean; daysBack?: number } = {}
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

    const scannedAt = new Date();

    for (let offset = 0; offset < daysBack; offset += 1) {
      const dateKey = shiftDateKey(todayKey, -offset);
      if (!forceCurrentDay && dateKey === todayKey) {
        result.skipped += 1;
        continue;
      }

      const { start, end } = getLocalDayBoundsForDateKey(
        dateKey,
        this.config.timezone
      );
      let summaries: SummaryRecord[];
      try {
        summaries = this.getLeafSummariesForDay(conversationId, start, end);
      } catch (error) {
        result.errors.push(
          `${dateKey}: leaf summary lookup failed: ${formatError(error)}`
        );
        continue;
      }

      const leafSummaries = summaries
        .filter((summary) => summary.kind === "leaf")
        .sort(compareSummariesChronologically);
      if (leafSummaries.length === 0) {
        try {
          const existing = this.store.getRollup(
            conversationId,
            PERIOD_KIND,
            dateKey,
            this.config.timezone
          );
          if (existing) {
            this.store.deleteRollup(existing.rollup_id);
            result.built += 1;
            continue;
          }
          result.skipped += 1;
        } catch (error) {
          result.errors.push(
            `${dateKey}: empty-day cleanup failed: ${formatError(error)}`
          );
        }
        continue;
      }

      const fingerprint = computeFingerprint(
        leafSummaries.map((summary) => ({
          id: summary.summaryId,
          tokenCount: summary.tokenCount,
          content: summary.content,
          updatedAt: summary.updatedAt,
          createdAt: summary.createdAt,
          earliestAt: summary.earliestAt,
          latestAt: summary.latestAt,
          sourceCount: summary.sourceMessageCount,
        }))
      );

      let existing: RollupRow | null = null;
      try {
        existing = this.store.getRollup(
          conversationId,
          PERIOD_KIND,
          dateKey,
          this.config.timezone
        );
      } catch (error) {
        result.errors.push(
          `${dateKey}: existing rollup lookup failed: ${formatError(error)}`
        );
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

    try {
      const finishedAt = new Date();
      const latestState = this.store.getState(conversationId);
      const shouldClearPending =
        result.errors.length === 0 &&
        isTimestampAtOrBefore(latestState?.last_message_at, scannedAt);
      this.store.upsertState(conversationId, {
        timezone: this.config.timezone,
        last_rollup_check_at: laterDate(
          finishedAt,
          latestState?.last_rollup_check_at
        ).toISOString(),
        pending_rebuild:
          result.errors.length === 0 && shouldClearPending ? 0 : 1,
      });
    } catch (error) {
      result.errors.push(`final sweep state update failed: ${formatError(error)}`);
    }

    return result;
  }

  async buildDayRollup(
    conversationId: number,
    dateKey: string
  ): Promise<boolean> {
    const { start, end } = getLocalDayBoundsForDateKey(
      dateKey,
      this.config.timezone
    );
    const summaries = this.getLeafSummariesForDay(conversationId, start, end)
      .filter((summary) => summary.kind === "leaf")
      .sort(compareSummariesChronologically);

    if (summaries.length === 0) {
      const existing = this.store.getRollup(
        conversationId,
        PERIOD_KIND,
        dateKey,
        this.config.timezone
      );
      if (existing) {
        this.store.deleteRollup(existing.rollup_id);
        return true;
      }
      return false;
    }

    const totalSourceTokens = summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.tokenCount),
      0
    );
    const sourceMessageCount = summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.sourceMessageCount),
      0
    );
    const fingerprint = computeFingerprint(
      summaries.map((summary) => ({
        id: summary.summaryId,
        tokenCount: summary.tokenCount,
        content: summary.content,
        updatedAt: summary.updatedAt,
        createdAt: summary.createdAt,
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
        sourceCount: summary.sourceMessageCount,
      }))
    );
    const draft = buildDailyRollupContent({
      dateKey,
      summaries,
      timezone: this.config.timezone,
      maxTokens: this.dailyMaxTokens,
    });
    const builtAt = new Date();
    const sourceSummaryIds = JSON.stringify(
      summaries.map((summary) => summary.summaryId)
    );
    const coverageStart = minSummaryTime(summaries)?.toISOString() ?? null;
    const coverageEnd = maxSummaryTime(summaries)?.toISOString() ?? null;

    await withDatabaseTransaction(
      this.store.db,
      "BEGIN IMMEDIATE",
      async () => {
        const existing = this.store.getRollup(
          conversationId,
          PERIOD_KIND,
          dateKey,
          this.config.timezone
        );
        const rollupId = existing?.rollup_id ?? buildRollupId(PERIOD_KIND, dateKey);
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
          source_summary_ids: sourceSummaryIds,
          source_message_count: sourceMessageCount,
          source_token_count: totalSourceTokens,
          status: "ready",
          coverage_start: coverageStart,
          coverage_end: coverageEnd,
          summarizer_model: "concatenation-v1",
          source_fingerprint: fingerprint,
        });

        await this.store.replaceRollupSources(
          rollupId,
          summaries.map((summary, index) => ({
            type: "summary",
            id: summary.summaryId,
            ordinal: index,
          }))
        );

        this.store.upsertState(conversationId, {
          timezone: this.config.timezone,
          last_daily_build_at: builtAt.toISOString(),
          last_rollup_check_at: builtAt.toISOString(),
        });
      }
    );

    return true;
  }

  private getLeafSummariesForDay(
    conversationId: number,
    start: Date,
    end: Date
  ): SummaryRecord[] {
    return this.store
      .getLeafSummariesForDay(
        conversationId,
        start.toISOString(),
        end.toISOString()
      )
      .map((summary: LeafSummaryForDayRow) => ({
        summaryId: summary.summary_id,
        content: summary.content,
        tokenCount: summary.token_count,
        sourceMessageCount: summary.source_message_count,
        earliestAt: summary.earliest_at ? new Date(summary.earliest_at) : null,
        latestAt: summary.latest_at ? new Date(summary.latest_at) : null,
        createdAt: new Date(summary.created_at),
        updatedAt: summary.updated_at ? new Date(summary.updated_at) : null,
        kind: "leaf",
      }));
  }
}

type FingerprintSource = {
  id: string;
  tokenCount?: number | null;
  content?: string | null;
  updatedAt?: string | Date | null;
  createdAt?: string | Date | null;
  earliestAt?: string | Date | null;
  latestAt?: string | Date | null;
  sourceCount?: number | null;
};

export function computeFingerprint(sources: FingerprintSource[]): string {
  const normalized = [...sources]
    .map((source) => ({
      id: source.id,
      tokenCount: safeTokenCount(source.tokenCount ?? 0),
      contentHash: crypto
        .createHash("sha256")
        .update(source.content ?? "")
        .digest("hex")
        .slice(0, 16),
      updatedAt: normalizeFingerprintDate(source.updatedAt),
      createdAt: normalizeFingerprintDate(source.createdAt),
      earliestAt: normalizeFingerprintDate(source.earliestAt),
      latestAt: normalizeFingerprintDate(source.latestAt),
      sourceCount: safeTokenCount(source.sourceCount ?? 0),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 16);
}

function normalizeFingerprintDate(value: string | Date | null | undefined): string {
  if (value == null) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function getLocalDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function getLocalDayBounds(
  date: Date,
  timezone: string
): { start: Date; end: Date } {
  const dateKey = getLocalDateKey(date, timezone);
  return getLocalDayBoundsForDateKey(dateKey, timezone);
}

function getLocalDayBoundsForDateKey(
  dateKey: string,
  timezone: string
): { start: Date; end: Date } {
  parseDateKey(dateKey);
  const start = localDateTimeToUtc(dateKey, "00:00:00", timezone);
  const end = localDateTimeToUtc(
    shiftDateKey(dateKey, 1),
    "00:00:00",
    timezone
  );
  return { start, end };
}

function isTimestampAtOrBefore(
  value: string | null | undefined,
  boundary: Date
): boolean {
  if (!value) {
    return true;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed <= boundary;
}

function laterDate(left: Date, right: string | null | undefined): Date {
  if (!right) {
    return left;
  }
  const parsed = new Date(right);
  if (Number.isNaN(parsed.getTime())) {
    return left;
  }
  return parsed > left ? parsed : left;
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
  const entries = params.summaries.map((summary) =>
    buildTimelineEntry(summary, params.timezone)
  );
  const stats = buildStatistics(params.summaries, params.timezone);

  let keyItems = extractKeyItems(params.summaries);
  let timelineEntries = [...entries];
  let omittedEntries = 0;
  let content = renderDailyRollup({
    dateKey: params.dateKey,
    entries: timelineEntries,
    omittedEntries,
    keyItems,
    stats,
  });

  while (
    timelineEntries.length > 0 &&
    estimateTokens(content) > params.maxTokens
  ) {
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

  while (countKeyItems(keyItems) > 0 && estimateTokens(content) > params.maxTokens) {
    keyItems = trimLargestKeyItemBucket(keyItems);
    content = renderDailyRollup({
      dateKey: params.dateKey,
      entries: timelineEntries,
      omittedEntries,
      keyItems,
      stats,
    });
  }

  if (
    timelineEntries.length === 0 &&
    estimateTokens(content) > params.maxTokens
  ) {
    const fallback = renderDailyRollup({
      dateKey: params.dateKey,
      entries: [],
      omittedEntries: entries.length,
      keyItems: emptyKeyItems(),
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
  keyItems: KeyItems;
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

function buildTimelineEntry(
  summary: SummaryRecord,
  timezone: string
): TimelineEntry {
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

  const sentences = splitIntoSentences(normalized).slice(
    0,
    TIMELINE_SENTENCE_LIMIT
  );
  const summary = sentences.length > 0 ? sentences.join(" ") : normalized;
  if (summary.length <= TIMELINE_MAX_CHARS) {
    return summary;
  }
  return `${summary.slice(0, TIMELINE_MAX_CHARS - 1).trimEnd()}…`;
}

function extractKeyItems(summaries: SummaryRecord[]): KeyItems {
  const buckets = {
    decisions: collectMatchingLines(
      summaries,
      /\b(decided|decision|chose|agreed)\b/i
    ),
    completed: collectMatchingLines(
      summaries,
      /\b(completed|done|finished|shipped|merged|deployed)\b/i
    ),
    blockers: collectMatchingLines(
      summaries,
      /\b(blocked|failed|error|issue|broken)\b/i
    ),
  };
  return buckets;
}

function emptyKeyItems(): KeyItems {
  return { decisions: [], completed: [], blockers: [] };
}

function countKeyItems(keyItems: KeyItems): number {
  return (
    keyItems.decisions.length +
    keyItems.completed.length +
    keyItems.blockers.length
  );
}

function trimLargestKeyItemBucket(keyItems: KeyItems): KeyItems {
  const buckets: Array<keyof KeyItems> = ["decisions", "completed", "blockers"];
  const largest = buckets.reduce((current, candidate) =>
    keyItems[candidate].length > keyItems[current].length ? candidate : current
  );
  return {
    decisions:
      largest === "decisions" ? keyItems.decisions.slice(0, -1) : keyItems.decisions,
    completed:
      largest === "completed" ? keyItems.completed.slice(0, -1) : keyItems.completed,
    blockers:
      largest === "blockers" ? keyItems.blockers.slice(0, -1) : keyItems.blockers,
  };
}

function collectMatchingLines(
  summaries: SummaryRecord[],
  pattern: RegExp
): string[] {
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
  timezone: string
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
  const end =
    latestTimes[latestTimes.length - 1] ??
    summaries[summaries.length - 1]?.createdAt ??
    start;

  return {
    leafSummaries: summaries.length,
    timeSpan: `${formatTime(start, timezone)} — ${formatTime(end, timezone)}`,
    totalSourceTokens: summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.tokenCount),
      0
    ),
  };
}

function minSummaryTime(summaries: SummaryRecord[]): Date | null {
  return minDate(summaries.map((summary) => summary.earliestAt ?? summary.createdAt));
}

function maxSummaryTime(summaries: SummaryRecord[]): Date | null {
  return maxDate(summaries.map((summary) => summary.latestAt ?? summary.createdAt));
}

function minDate(dates: Date[]): Date | null {
  return dates.reduce<Date | null>(
    (min, date) => (min == null || date < min ? date : min),
    null
  );
}

function maxDate(dates: Date[]): Date | null {
  return dates.reduce<Date | null>(
    (max, date) => (max == null || date > max ? date : max),
    null
  );
}

function compareSummariesChronologically(
  left: SummaryRecord,
  right: SummaryRecord
): number {
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
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizePositiveInt(
  value: number | undefined,
  fallback: number
): number {
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
  const [year, month, day] = dateKey
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  return candidate;
}

function shiftDateKey(dateKey: string, dayDelta: number): string {
  const utcDate = new Date(`${dateKey}T00:00:00.000Z`);
  utcDate.setUTCDate(utcDate.getUTCDate() + dayDelta);
  return utcDate.toISOString().slice(0, 10);
}

function localDateTimeToUtc(
  dateKey: string,
  time: string,
  timezone: string
): Date {
  const [year, month, day] = dateKey
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const [hour, minute, second] = time
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  const utcGuess = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, 0)
  );
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
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number.parseInt(lookup.get("year") ?? "0", 10),
    Number.parseInt(lookup.get("month") ?? "1", 10) - 1,
    Number.parseInt(lookup.get("day") ?? "1", 10),
    Number.parseInt(lookup.get("hour") ?? "0", 10),
    Number.parseInt(lookup.get("minute") ?? "0", 10),
    Number.parseInt(lookup.get("second") ?? "0", 10)
  );
  return localAsUtc - date.getTime();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
