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
  private readonly dailyMaxTokens: number;

  constructor(
    private store: RollupStore,
    private config: RollupBuilderConfig,
  ) {
    const dailyTargetTokens = normalizePositiveInt(
      config.dailyTargetTokens,
      DEFAULT_DAILY_TARGET_TOKENS,
    );
    this.dailyMaxTokens = Math.max(
      dailyTargetTokens,
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

    const scannedAt = new Date();

    for (let offset = 0; offset < daysBack; offset += 1) {
      const dateKey = shiftDateKey(todayKey, -offset);
      if (!forceCurrentDay && dateKey === todayKey) {
        result.skipped += 1;
        continue;
      }

      const { start, end } = getLocalDayBoundsForDateKey(
        dateKey,
        this.config.timezone,
      );
      let summaries: SummaryRecord[];
      try {
        summaries = this.getLeafSummariesForDay(conversationId, start, end);
      } catch (error) {
        result.errors.push(
          `${dateKey}: leaf summary lookup failed: ${formatError(error)}`,
        );
        continue;
      }

      const leafSummaries = summaries
        .filter((summary) => summary.kind === "leaf")
        .sort(compareSummariesChronologically);
      if (leafSummaries.length === 0) {
        result.skipped += 1;
        continue;
      }

      const totalTokens = leafSummaries.reduce(
        (sum, summary) => sum + safeTokenCount(summary.tokenCount),
        0,
      );
      const fingerprint = computeFingerprint(leafSummaries);

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
          `${dateKey}: existing rollup lookup failed: ${formatError(error)}`,
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

    const latestState = this.store.getState(conversationId);
    const shouldClearPending =
      result.errors.length === 0 &&
      isTimestampAtOrBefore(latestState?.last_message_at, scannedAt);
    this.store.upsertState(conversationId, {
      timezone: this.config.timezone,
      last_rollup_check_at: scannedAt.toISOString(),
      pending_rebuild: result.errors.length === 0 && shouldClearPending ? 0 : 1,
    });

    return result;
  }

  async buildDayRollup(
    conversationId: number,
    dateKey: string,
  ): Promise<boolean> {
    const { start, end } = getLocalDayBoundsForDateKey(
      dateKey,
      this.config.timezone,
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
      0,
    );
    const sourceMessageCount = summaries.reduce(
      (sum, summary) => sum + Math.max(1, summary.sourceMessageCount),
      0,
    );
    const fingerprint = computeFingerprint(summaries);
    const draft = buildDailyRollupContent({
      dateKey,
      summaries,
      timezone: this.config.timezone,
      maxTokens: this.dailyMaxTokens,
    });
    const builtAt = new Date();
    const coverage = getCoverageBounds(summaries);

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
        const rollupId =
          existing?.rollup_id ?? buildRollupId(PERIOD_KIND, dateKey);

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
          source_summary_ids: JSON.stringify(
            summaries.map((summary) => summary.summaryId),
          ),
          source_message_count: sourceMessageCount,
          source_token_count: totalSourceTokens,
          status: "ready",
          coverage_start: coverage.start?.toISOString() ?? null,
          coverage_end: coverage.end?.toISOString() ?? null,
          summarizer_model: "concatenation-v1",
          source_fingerprint: fingerprint,
        });

        await this.store.replaceRollupSources(
          rollupId,
          summaries.map((summary, index) => ({
            type: "summary",
            id: summary.summaryId,
            ordinal: index,
          })),
        );

        this.store.upsertState(conversationId, {
          timezone: this.config.timezone,
          last_daily_build_at: builtAt.toISOString(),
          last_rollup_check_at: builtAt.toISOString(),
        });
      },
    );

    return true;
  }

  private getLeafSummariesForDay(
    conversationId: number,
    start: Date,
    end: Date,
  ): SummaryRecord[] {
    return this.store
      .getLeafSummariesForDay(
        conversationId,
        start.toISOString(),
        end.toISOString(),
      )
      .map((summary: LeafSummaryForDayRow) => ({
        summaryId: summary.summary_id,
        content: summary.content,
        tokenCount: summary.token_count,
        earliestAt: summary.earliest_at ? new Date(summary.earliest_at) : null,
        latestAt: summary.latest_at ? new Date(summary.latest_at) : null,
        createdAt: new Date(summary.created_at),
        sourceMessageCount: summary.source_message_count,
        kind: "leaf",
      }));
  }
}

export function computeFingerprint(
  summaries: Array<
    Pick<
      SummaryRecord,
      | "summaryId"
      | "content"
      | "tokenCount"
      | "sourceMessageCount"
      | "earliestAt"
      | "latestAt"
      | "createdAt"
    >
  >,
): string {
  const data = summaries
    .map((summary) =>
      [
        summary.summaryId,
        safeTokenCount(summary.tokenCount),
        Math.max(1, summary.sourceMessageCount),
        summary.earliestAt?.toISOString() ?? "",
        summary.latestAt?.toISOString() ?? "",
        summary.createdAt.toISOString(),
        crypto.createHash("sha256").update(summary.content).digest("hex"),
      ].join("\u001f"),
    )
    .sort()
    .join("\u001e");
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

export function getLocalDayBounds(
  date: Date,
  timezone: string,
): { start: Date; end: Date } {
  const dateKey = getLocalDateKey(date, timezone);
  return getLocalDayBoundsForDateKey(dateKey, timezone);
}

function getLocalDayBoundsForDateKey(
  dateKey: string,
  timezone: string,
): { start: Date; end: Date } {
  assertValidDateKey(dateKey);
  const start = localDateTimeToUtc(dateKey, "00:00:00", timezone);
  const end = localDateTimeToUtc(
    shiftDateKey(dateKey, 1),
    "00:00:00",
    timezone,
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
    buildTimelineEntry(summary, params.timezone),
  );
  const keyItems = extractKeyItems(params.summaries);
  const stats = buildStatistics(params.summaries, params.timezone);

  let timelineEntries = [...entries];
  let retainedKeyItems = keyItems;
  let omittedEntries = 0;
  let content = renderDailyRollup({
    dateKey: params.dateKey,
    entries: timelineEntries,
    omittedEntries,
    keyItems: retainedKeyItems,
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
      keyItems: retainedKeyItems,
      stats,
    });
  }

  if (
    timelineEntries.length === 0 &&
    estimateTokens(content) > params.maxTokens
  ) {
    while (countKeyItems(retainedKeyItems) > 0 && estimateTokens(content) > params.maxTokens) {
      retainedKeyItems = trimLargestKeyItemBucket(retainedKeyItems);
      content = renderDailyRollup({
        dateKey: params.dateKey,
        entries: [],
        omittedEntries: entries.length,
        keyItems: retainedKeyItems,
        stats,
      });
    }
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

function buildTimelineEntry(
  summary: SummaryRecord,
  timezone: string,
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
    TIMELINE_SENTENCE_LIMIT,
  );
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
    decisions: collectMatchingLines(
      summaries,
      /\b(decided|decision|chose|agreed)\b/i,
    ),
    completed: collectMatchingLines(
      summaries,
      /\b(completed|done|finished|shipped|merged|deployed)\b/i,
    ),
    blockers: collectMatchingLines(
      summaries,
      /\b(blocked|failed|error|issue|broken)\b/i,
    ),
  };
  return buckets;
}

type KeyItems = {
  decisions: string[];
  completed: string[];
  blockers: string[];
};

function countKeyItems(items: KeyItems): number {
  return items.decisions.length + items.completed.length + items.blockers.length;
}

function trimLargestKeyItemBucket(items: KeyItems): KeyItems {
  const next: KeyItems = {
    decisions: [...items.decisions],
    completed: [...items.completed],
    blockers: [...items.blockers],
  };
  const largestBucket = (Object.keys(next) as Array<keyof KeyItems>).sort(
    (left, right) => next[right].length - next[left].length,
  )[0];
  next[largestBucket] = next[largestBucket].slice(1);
  return next;
}

function collectMatchingLines(
  summaries: SummaryRecord[],
  pattern: RegExp,
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
  const end =
    latestTimes[latestTimes.length - 1] ??
    summaries[summaries.length - 1]?.createdAt ??
    start;

  return {
    leafSummaries: summaries.length,
    timeSpan: `${formatTime(start, timezone)} — ${formatTime(end, timezone)}`,
    totalSourceTokens: summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.tokenCount),
      0,
    ),
  };
}

function compareSummariesChronologically(
  left: SummaryRecord,
  right: SummaryRecord,
): number {
  const leftTime = (left.earliestAt ?? left.createdAt).getTime();
  const rightTime = (right.earliestAt ?? right.createdAt).getTime();
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.summaryId.localeCompare(right.summaryId);
}

function getCoverageBounds(
  summaries: SummaryRecord[],
): { start: Date | null; end: Date | null } {
  const starts = summaries
    .map((summary) => summary.earliestAt ?? summary.createdAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  const ends = summaries
    .map((summary) => summary.latestAt ?? summary.createdAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  return {
    start: starts[0] ?? null,
    end: ends[ends.length - 1] ?? null,
  };
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
  fallback: number,
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

function shiftDateKey(dateKey: string, dayDelta: number): string {
  const utcDate = new Date(`${dateKey}T00:00:00.000Z`);
  utcDate.setUTCDate(utcDate.getUTCDate() + dayDelta);
  return utcDate.toISOString().slice(0, 10);
}

function assertValidDateKey(dateKey: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  const probe = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== dateKey) {
    throw new Error(`Invalid date key: ${dateKey}`);
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
  if (parts.hour !== 24) {
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

function localDateTimeToUtc(
  dateKey: string,
  time: string,
  timezone: string,
): Date {
  assertValidDateKey(dateKey);
  const [year, month, day] = dateKey
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const { hour, minute, second } = parseTimeParts(time);

  let candidate = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, 0),
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
        0,
      );
    if (deltaMs === 0) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + deltaMs);
  }

  throw new Error(
    `Nonexistent local time ${dateKey} ${time} in timezone ${timezone}`,
  );
}

function getZonedDateTimeParts(
  date: Date,
  timezone: string,
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
