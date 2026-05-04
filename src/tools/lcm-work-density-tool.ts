import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
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
  period: Type.Optional(Type.String({ description: 'Observed work period: "today", "yesterday", "7d", "30d", "week", "month", or "date:YYYY-MM-DD". Explicit since/before wins when provided.' })),
  since: Type.Optional(Type.String({ description: "Only include observed items last seen at or after this ISO timestamp." })),
  before: Type.Optional(Type.String({ description: "Only include observed items first seen before this ISO timestamp." })),
  topic: Type.Optional(Type.String({ description: "Exact topic_key filter." })),
  statuses: Type.Optional(
    Type.Array(
      Type.Union(STATUS_VALUES.map((value) => Type.Literal(value))),
      { description: "Observed statuses to include." },
    ),
  ),
  kinds: Type.Optional(
    Type.Array(
      Type.Union(KIND_VALUES.map((value) => Type.Literal(value))),
      { description: "Observed work kinds to include." },
    ),
  ),
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
    'period must be one of "today", "yesterday", "7d", "30d", "week", "month", or "date:YYYY-MM-DD".'
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

// Mirror the serialization used by `jsonResult()` (pretty-printed with 2-space
// indent) so the estimate matches the bytes actually returned to the caller.
// Using minified `JSON.stringify` here would understate size by ~30–50% on
// nested payloads and let trimming exit while the real response is still over
// budget.
function estimateJsonTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value, null, 2).length / 4);
}

function itemArray(details: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = details[key];
  return Array.isArray(value) ? value : undefined;
}

function countReturnedItems(details: Record<string, unknown>): number {
  return DETAIL_ARRAY_KEYS.reduce((count, key) => count + (itemArray(details, key)?.length ?? 0), 0);
}

// Approximate per-item byte cost of a single trimmed value when serialized
// with JSON.stringify(value, null, 2). Used for incremental size accounting
// (issue #44/#48) to avoid an O(N) full re-stringify per trim iteration.
function approxStringifiedSize(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

// Returns the approximate number of characters removed from the
// pretty-printed serialization of `details` after dropping the last source
// of one item, or 0 if no source could be trimmed.
function trimOneSource(details: Record<string, unknown>): number {
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
      const droppedSource = sources[sources.length - 1];
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
      // Approximate: size of the dropped element plus separators / indentation.
      // The exact byte delta depends on whether `sources` is now empty (removes
      // the key entirely), but for budget tracking an over-estimate is safe —
      // periodic resync corrects drift.
      return approxStringifiedSize(droppedSource) + 4;
    }
  }
  return 0;
}

// Returns the approximate number of characters removed after dropping the
// last item from one of the detail arrays, or 0 if no item could be trimmed.
function trimOneItem(details: Record<string, unknown>): number {
  for (const key of DETAIL_ARRAY_KEYS) {
    const items = itemArray(details, key);
    if (items && items.length > 0) {
      const dropped = items[items.length - 1];
      details[key] = items.slice(0, -1);
      return approxStringifiedSize(dropped) + 4;
    }
  }
  return 0;
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
  // Seed the accounting block BEFORE the trim loop so its bytes participate
  // in the size estimate. Otherwise we trim until `next` fits, then add
  // `maxOutputTokens` / `itemsReturned` / `truncated` / `estimatedOutputTokens`
  // afterward and the response can land back over budget.
  const next: Record<string, unknown> = { ...details };
  const baseAccounting =
    next.accounting != null && typeof next.accounting === "object" && !Array.isArray(next.accounting)
      ? { ...(next.accounting as Record<string, unknown>) }
      : {};
  const itemsOmittedBaseline =
    typeof baseAccounting.itemsOmitted === "number" ? baseAccounting.itemsOmitted : 0;
  const accounting: Record<string, unknown> = {
    ...baseAccounting,
    maxOutputTokens: budget,
    itemsReturned: countReturnedItems(next),
    itemsOmitted: itemsOmittedBaseline,
    budgetTruncated: false,
    truncated: Boolean(baseAccounting.truncated),
    // Placeholder; recomputed at the very end so the value reflects the
    // serialized payload that actually goes out.
    estimatedOutputTokens: 0,
  };
  next.accounting = accounting;

  let budgetTruncated = false;
  let guard = 0;
  // Incremental size accounting (issue #44/#48): the previous loop called
  // JSON.stringify on the whole `next` payload every iteration, giving O(N²)
  // behaviour when many items had to be trimmed. Track the running size and
  // subtract per-item deltas instead, resyncing periodically against the real
  // serialization to bound drift from approximation error.
  const RESYNC_INTERVAL = 64;
  let runningChars = JSON.stringify(next, null, 2).length;
  while (Math.ceil(runningChars / 4) > budget && guard < 10_000) {
    guard += 1;
    const beforeItems = countReturnedItems(next);
    const sourceDelta = trimOneSource(next);
    const itemDelta = sourceDelta > 0 ? 0 : trimOneItem(next);
    const delta = sourceDelta + itemDelta;
    if (delta > 0) {
      budgetTruncated = true;
      runningChars = Math.max(0, runningChars - delta);
      const afterItems = countReturnedItems(next);
      // Whole items dropped by trimOneItem must be reflected in itemsOmitted;
      // otherwise callers see "0 omitted" while most rows are gone.
      accounting.itemsOmitted = (accounting.itemsOmitted as number) + (beforeItems - afterItems);
      accounting.itemsReturned = afterItems;
      accounting.budgetTruncated = true;
      accounting.truncated = true;
      // Periodic resync against the real serialization to correct drift —
      // approxStringifiedSize ignores enclosing separators and indentation
      // changes, so the running total can diverge over many iterations.
      if (guard % RESYNC_INTERVAL === 0) {
        runningChars = JSON.stringify(next, null, 2).length;
      }
      continue;
    }
    break;
  }
  accounting.estimatedOutputTokens = estimateJsonTokens(next);
  if (budgetTruncated) {
    accounting.budgetTruncated = true;
    accounting.truncated = true;
  }
  return next;
}

export function createLcmWorkDensityTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_work_density",
    label: "LCM Work Density",
    description:
      "Summarize observed work density from LCM evidence. Returns counts and top observed completed/unfinished/ambiguous work items. This is not an authoritative task system; output is unrefined observed evidence.",
    parameters: LcmWorkDensitySchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
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
      let since: string | undefined;
      let before: string | undefined;
      let statuses: ObservedWorkStatus[] | undefined;
      let kinds: ObservedWorkKind[] | undefined;
      let periodLabel: string | undefined;
      try {
        const periodBounds = resolvePeriodBounds(p.period, lcm.timezone, input.deps.clock.now());
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
      // NaN/Infinity must not slip through `typeof === "number"` (issue #56,
      // #57). Math.trunc(NaN)===NaN and Math.min/max with NaN propagate to SQL.
      const limit = Number.isFinite(p.limit as number) ? Math.trunc(p.limit as number) : 5;
      const detailLevel = Number.isFinite(p.detailLevel as number) ? Math.trunc(p.detailLevel as number) : 1;
      const topic = typeof p.topic === "string" && p.topic.trim() ? p.topic.trim() : undefined;
      const minConfidence = Number.isFinite(p.minConfidence as number) ? (p.minConfidence as number) : undefined;
      const store = lcm.getObservedWorkStore();
      const includeSources = p.includeSources === true;
      const result = store.getDensity({
        conversationId: scope.conversationId,
        // Span the full session family (active + archived siblings under the
        // same session_key) so density covers /new and /reset boundaries.
        // PR #338 + v0.9.4 family-scope extension.
        conversationIds: scope.conversationIds,
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
      const details = applyOutputBudget({
        period: periodLabel,
        window: since || before ? { since, before, timezone: lcm.timezone } : undefined,
        conversationScope: scope.allConversations ? "all" : scope.conversationId,
        density: result.density,
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
      }, p.maxOutputTokens);
      return jsonResult(details);
    },
  };
}
