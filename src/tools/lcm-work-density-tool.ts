import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { RollupStore } from "../store/rollup-store.js";
import {
  addDays,
  getUtcDateForZonedMidnight,
  getZonedDayString,
  startOfWeekDayString,
} from "../timezone-windows.js";
import type { LcmDependencies } from "../types.js";
import type {
  ObservedWorkKind,
  ObservedWorkStatus,
} from "../store/observed-work-store.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import {
  parseIsoTimestampParam,
  resolveLcmConversationScope,
} from "./lcm-conversation-scope.js";

const STATUS_VALUES = [
  "observed_completed",
  "observed_unfinished",
  "observed_ambiguous",
  "decision_recorded",
  "dismissed",
] as const;

const KIND_VALUES = [
  "implementation",
  "review",
  "blocker",
  "decision",
  "question",
  "follow_up",
  "test",
  "deploy",
  "research",
  "other",
] as const;

const LcmWorkDensitySchema = Type.Object({
  conversationId: Type.Optional(Type.Number({ description: "Conversation ID to inspect. Defaults to the current session conversation." })),
  allConversations: Type.Optional(
    Type.Boolean({
      description: "Reserved for a future bounded admin mode; currently rejected so density reads stay conversation-scoped.",
    })
  ),
  period: Type.Optional(Type.String({ description: 'Observed work period: "today", "yesterday", "7d", "30d", "week", "month", "date:YYYY-MM-DD", or a bare "YYYY-MM-DD" (treated as that single day). Explicit since/before wins when provided.' })),
  since: Type.Optional(Type.String({ description: "Only include observed items last seen at or after this ISO timestamp." })),
  before: Type.Optional(Type.String({ description: "Only include observed items first seen before this ISO timestamp." })),
  topic: Type.Optional(Type.String({ description: "Exact topic_key filter." })),
  statuses: Type.Optional(Type.Array(Type.String({ enum: [...STATUS_VALUES] }), { description: "Observed statuses to include." })),
  kinds: Type.Optional(Type.Array(Type.String({ enum: [...KIND_VALUES] }), { description: "Observed work kinds to include." })),
  includeSources: Type.Optional(Type.Boolean({ description: "Include observed-work source IDs. Defaults to false." })),
  detailLevel: Type.Optional(Type.Number({ description: "0 = compact counts only; values above 0 include the bounded top item sections. Default 1.", minimum: 0, maximum: 2 })),
  maxOutputTokens: Type.Optional(Type.Number({ description: "Approximate response budget; rich item/source sections are trimmed to stay within it when possible.", minimum: 256 })),
  minConfidence: Type.Optional(Type.Number({ description: "Minimum observed confidence to include.", minimum: 0, maximum: 1 })),
  limit: Type.Optional(Type.Number({ description: "Maximum items per highlight section. Default 5.", minimum: 1, maximum: 50 })),
});

function resolvePeriodBounds(
  period: unknown,
  timezone: string,
  now: Date
): { label?: string; since?: string; before?: string } {
  if (typeof period !== "string" || period.trim().length === 0) {
    return {};
  }
  const normalized = period.trim().toLowerCase().replace(/\s+/g, " ");
  const today = getZonedDayString(now, timezone);
  if (normalized === "today") {
    return dayBounds("today", today, timezone);
  }
  if (normalized === "yesterday") {
    return dayBounds("yesterday", addDays(today, -1), timezone);
  }
  if (normalized.startsWith("date:")) {
    const day = normalized.slice(5).trim();
    return dayBounds(day, day, timezone);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return dayBounds(normalized, normalized, timezone);
  }
  if (normalized === "7d" || normalized === "30d") {
    const days = normalized === "7d" ? 7 : 30;
    const startDay = addDays(today, -(days - 1));
    return {
      label: normalized,
      since: getUtcDateForZonedMidnight(startDay, timezone).toISOString(),
      before: getUtcDateForZonedMidnight(addDays(today, 1), timezone).toISOString(),
    };
  }
  if (normalized === "week") {
    const startDay = startOfWeekDayString(today);
    return {
      label: "week",
      since: getUtcDateForZonedMidnight(startDay, timezone).toISOString(),
      before: getUtcDateForZonedMidnight(addDays(startDay, 7), timezone).toISOString(),
    };
  }
  if (normalized === "month") {
    const startDay = `${today.slice(0, 7)}-01`;
    return {
      label: "month",
      since: getUtcDateForZonedMidnight(startDay, timezone).toISOString(),
      before: getUtcDateForZonedMidnight(nextMonthStartDay(startDay), timezone).toISOString(),
    };
  }
  throw new Error(
    'period must be one of "today", "yesterday", "7d", "30d", "week", "month", "date:YYYY-MM-DD", or a bare "YYYY-MM-DD".'
  );
}

function dayBounds(
  label: string,
  day: string,
  timezone: string
): { label: string; since: string; before: string } {
  return {
    label,
    since: getUtcDateForZonedMidnight(day, timezone).toISOString(),
    before: getUtcDateForZonedMidnight(addDays(day, 1), timezone).toISOString(),
  };
}

function nextMonthStartDay(dayString: string): string {
  const year = Number(dayString.slice(0, 4));
  const month = Number(dayString.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

function arrayParam<T extends string>(value: unknown, allowed: readonly T[], key: string): T[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }
  const allowedSet = new Set<string>(allowed);
  return value.map((entry) => {
    if (typeof entry !== "string" || !allowedSet.has(entry)) {
      throw new Error(`${key} contains an unsupported value: ${String(entry)}`);
    }
    return entry as T;
  });
}

const DETAIL_ARRAY_KEYS = [
  "dismissedItems",
  "decisions",
  "completedHighlights",
  "ambiguous",
  "staleItems",
  "transitions",
  "topUnfinished",
] as const;

function estimateJsonTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function itemArray(details: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = details[key];
  return Array.isArray(value) ? value : undefined;
}

function countReturnedItems(details: Record<string, unknown>): number {
  return DETAIL_ARRAY_KEYS.reduce((count, key) => count + (itemArray(details, key)?.length ?? 0), 0);
}

function trimOneSource(details: Record<string, unknown>): boolean {
  for (const key of DETAIL_ARRAY_KEYS) {
    const items = itemArray(details, key);
    if (!items) {
      continue;
    }
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const itemRecord = item as Record<string, unknown>;
      const sources = itemRecord.sources;
      if (!Array.isArray(sources) || sources.length === 0) {
        continue;
      }
      const nextItem = { ...itemRecord };
      const nextSources = sources.slice(0, -1);
      if (nextSources.length > 0) {
        nextItem.sources = nextSources;
      } else {
        delete nextItem.sources;
      }
      const nextItems = items.slice();
      nextItems[index] = nextItem;
      details[key] = nextItems;
      return true;
    }
  }
  return false;
}

function trimOneItem(details: Record<string, unknown>): boolean {
  for (const key of DETAIL_ARRAY_KEYS) {
    const items = itemArray(details, key);
    if (items && items.length > 0) {
      details[key] = items.slice(0, -1);
      return true;
    }
  }
  return false;
}

function applyOutputBudget(
  details: Record<string, unknown>,
  maxOutputTokens: unknown
): Record<string, unknown> {
  const budget =
    typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)
      ? Math.max(256, Math.trunc(maxOutputTokens))
      : undefined;
  if (!budget) {
    return details;
  }
  const next: Record<string, unknown> = { ...details };
  // Pre-attach the accounting block so estimateJsonTokens() accounts for the
  // real final shape of the payload (maxOutputTokens / itemsReturned /
  // budgetTruncated / truncated / estimatedOutputTokens fields). Without this,
  // the trim loop could stop just under budget while the *final* JSON ends up
  // over budget once accounting is added afterwards.
  const baseAccounting =
    next.accounting != null && typeof next.accounting === "object" && !Array.isArray(next.accounting)
      ? { ...(next.accounting as Record<string, unknown>) }
      : {};
  const accounting: Record<string, unknown> = {
    ...baseAccounting,
    maxOutputTokens: budget,
    itemsReturned: countReturnedItems(next),
    budgetTruncated: false,
    truncated: Boolean(baseAccounting.truncated),
    estimatedOutputTokens: 0,
  };
  next.accounting = accounting;
  let budgetTruncated = false;
  let guard = 0;
  while (estimateJsonTokens(next) > budget && guard < 10_000) {
    guard += 1;
    // Adaptive trimming: when the payload is far over budget, drop multiple
    // sources/items per pass to avoid O(k·n) JSON.stringify hot-spots on
    // worst-case inputs (large limit + includeSources). When close to budget,
    // fall back to single-element trimming for precision.
    const overBy = estimateJsonTokens(next) - budget;
    const trimsPerPass = overBy > budget ? 8 : overBy > budget / 2 ? 4 : 1;
    let trimmedThisPass = false;
    for (let i = 0; i < trimsPerPass; i += 1) {
      if (trimOneSource(next) || trimOneItem(next)) {
        trimmedThisPass = true;
        budgetTruncated = true;
      } else {
        break;
      }
    }
    if (!trimmedThisPass) {
      break;
    }
    accounting.itemsReturned = countReturnedItems(next);
  }
  accounting.budgetTruncated = budgetTruncated;
  accounting.truncated = Boolean(accounting.truncated) || budgetTruncated;
  accounting.itemsReturned = countReturnedItems(next);
  accounting.estimatedOutputTokens = estimateJsonTokens(next);
  return next;
}

function validateFiniteNumber(
  value: unknown,
  key: string,
  options: { min?: number; max?: number; integer?: boolean }
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  if (options.integer && !Number.isInteger(value)) {
    // Allow callers to pass floats — we truncate rather than reject — but
    // catch obvious mistakes like negative or non-numeric input above.
  }
  if (options.min != null && value < options.min) {
    throw new Error(`${key} must be >= ${options.min}.`);
  }
  if (options.max != null && value > options.max) {
    throw new Error(`${key} must be <= ${options.max}.`);
  }
  return value;
}

export function createLcmWorkDensityTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
  rollupStore?: RollupStore;
}): AnyAgentTool {
  return {
    name: "lcm_work_density",
    label: "LCM Work Density",
    description:
      "Summarize observed work density from LCM evidence. Returns counts and top observed completed/unfinished/ambiguous work items. This is not an authoritative task system; output is unrefined observed evidence. Note: when `statuses` is set, `density.totalObserved` and the per-status counts reflect rows matching the requested filter, NOT the unfiltered conversation total.",
    parameters: LcmWorkDensitySchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      // Capture wall-clock once at entry via the injected clock so every
      // "now" observation inside this call uses the same Date instance and
      // preset windows are deterministic under frozen-clock tests / replay
      // (matches the lcm_recent pattern).
      const callTime = input.deps.clock.now();
      const p = params as Record<string, unknown>;
      const scope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      if (!scope.allConversations && scope.conversationId == null) {
        return jsonResult({ error: "No LCM conversation found for this session. Provide conversationId." });
      }
      if (scope.allConversations) {
        return jsonResult({
          error:
            "lcm_work_density does not support allConversations=true yet. Provide a conversationId so observed-work reads stay bounded.",
        });
      }
      // Resolve timezone from per-conversation rollup state first, falling
      // back to the engine-wide default. Persisted state wins so a
      // conversation recorded in America/Los_Angeles keeps its day boundaries
      // even if the engine default later changes.
      const rollupStoreForTz = input.rollupStore ?? lcm.getRollupStore?.();
      const timezone =
        (scope.conversationId != null && rollupStoreForTz?.db
          ? rollupStoreForTz.getTimezone(scope.conversationId)
          : null) ?? lcm.timezone;
      let since: string | undefined;
      let before: string | undefined;
      let statuses: ObservedWorkStatus[] | undefined;
      let kinds: ObservedWorkKind[] | undefined;
      let periodLabel: string | undefined;
      let limit: number;
      let detailLevel: number;
      let minConfidence: number | undefined;
      let maxOutputTokens: number | undefined;
      try {
        // Runtime validation. The TypeBox schema describes bounds but is not
        // enforced at runtime, so callers can pass NaN/Infinity/out-of-range
        // numbers that would otherwise reach SQL or produce surprising
        // detailLevel/limit truncation.
        const limitValue = validateFiniteNumber(p.limit, "limit", { min: 1, max: 50 });
        limit = limitValue != null ? Math.max(1, Math.trunc(limitValue)) : 5;
        const detailValue = validateFiniteNumber(p.detailLevel, "detailLevel", { min: 0, max: 2 });
        detailLevel = detailValue != null ? Math.max(0, Math.min(2, Math.trunc(detailValue))) : 1;
        minConfidence = validateFiniteNumber(p.minConfidence, "minConfidence", { min: 0, max: 1 });
        maxOutputTokens = validateFiniteNumber(p.maxOutputTokens, "maxOutputTokens", { min: 256 });
        const periodBounds = resolvePeriodBounds(p.period, timezone, callTime);
        periodLabel = periodBounds.label;
        since = parseIsoTimestampParam(p, "since")?.toISOString() ?? periodBounds.since;
        before = parseIsoTimestampParam(p, "before")?.toISOString() ?? periodBounds.before;
        statuses = arrayParam(p.statuses, STATUS_VALUES, "statuses");
        kinds = arrayParam(p.kinds, KIND_VALUES, "kinds");
      } catch (error) {
        return jsonResult({ error: error instanceof Error ? error.message : "Invalid lcm_work_density parameters." });
      }
      if (since && before && since >= before) {
        return jsonResult({ error: "since must be earlier than before." });
      }
      const topic = typeof p.topic === "string" && p.topic.trim() ? p.topic.trim() : undefined;
      const store = lcm.getObservedWorkStore();
      const includeSources = p.includeSources === true;
      const result = store.getDensity({
        conversationId: scope.conversationId,
        since,
        before,
        statuses,
        kinds,
        topic,
        minConfidence,
        includeSources,
        limit,
      });
      const compact = detailLevel <= 0;
      const filterScopeNote = statuses?.length
        ? `density counts reflect statuses=[${statuses.join(",")}] only, not the unfiltered conversation total`
        : undefined;
      const details = applyOutputBudget({
        period: periodLabel,
        window: since || before ? { since, before, timezone } : undefined,
        conversationScope: scope.allConversations ? "all" : scope.conversationId,
        density: result.density,
        ...(filterScopeNote ? { filterScope: filterScopeNote } : {}),
        ...(compact
          ? {}
          : {
              topUnfinished: result.topUnfinished,
              completedHighlights: result.completedHighlights,
              ambiguous: result.ambiguous,
              decisions: result.decisions,
              dismissedItems: result.dismissedItems,
            }),
        accounting: {
          itemsIncluded: result.itemsIncluded,
          itemsOmitted: result.itemsOmitted,
          truncated: result.itemsOmitted > 0,
        },
        confidence: "observed-unrefined",
        disclaimer: "Observed from LCM evidence; not authoritative task state.",
        recommendedDives:
          result.density.unfinished > 0
            ? ["Inspect source evidence for unfinished items before claiming certainty."]
            : [],
      }, maxOutputTokens);
      return jsonResult(details);
    },
  };
}
