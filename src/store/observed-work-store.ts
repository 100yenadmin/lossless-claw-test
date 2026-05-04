import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type ObservedWorkStatus =
  | "observed_completed"
  | "observed_unfinished"
  | "observed_ambiguous"
  | "decision_recorded"
  | "dismissed";

export type ObservedWorkKind =
  | "implementation"
  | "review"
  | "blocker"
  | "decision"
  | "question"
  | "follow_up"
  | "test"
  | "deploy"
  | "research"
  | "other";

export type ObservedWorkItemInput = {
  workItemId: string;
  conversationId: number;
  ownerId?: string;
  title: string;
  description?: string;
  observedStatus: ObservedWorkStatus;
  kind: ObservedWorkKind;
  confidence?: number;
  confidenceBand?: "low" | "medium" | "medium-high" | "high";
  rationale?: string;
  topicKey?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  completedAt?: string;
  completionConfidence?: number;
  evidenceCount?: number;
  sourceMessageCount?: number;
  sourceTokenCount?: number;
  authoritySource?: string;
  sensitivity?: string;
  visibility?: string;
  fingerprint: string;
  fingerprintVersion?: number;
};

export type ObservedWorkDensityQuery = {
  conversationId?: number;
  since?: string;
  before?: string;
  statuses?: ObservedWorkStatus[];
  kinds?: ObservedWorkKind[];
  topic?: string;
  minConfidence?: number;
  includeSources?: boolean;
  limit?: number;
};

type ObservedWorkRow = {
  work_item_id: string;
  conversation_id: number;
  title: string;
  observed_status: ObservedWorkStatus;
  kind: ObservedWorkKind;
  confidence: number;
  confidence_band: string;
  rationale: string | null;
  topic_key: string | null;
  first_seen_at: string;
  last_seen_at: string;
  completed_at: string | null;
  evidence_count: number;
};

type ObservedWorkDensityCountRow = {
  total_observed: number;
  completed: number | null;
  unfinished: number | null;
  ambiguous: number | null;
  dismissed: number | null;
  decision_recorded: number | null;
};

type ObservedWorkSourceRow = {
  work_item_id: string;
  source_type: "summary" | "rollup" | "message";
  source_id: string;
  ordinal: number;
  evidence_kind:
    | "created"
    | "reinforced"
    | "possible_completion"
    | "completed"
    | "contradicted"
    | "dismissed";
};

export type ObservedWorkSource = {
  sourceType: "summary" | "rollup" | "message";
  sourceId: string;
  ordinal: number;
  evidenceKind:
    | "created"
    | "reinforced"
    | "possible_completion"
    | "completed"
    | "contradicted"
    | "dismissed";
};

export type ObservedWorkDensityItem = {
  workItemId: string;
  conversationId: number;
  title: string;
  observedStatus: ObservedWorkStatus;
  kind: ObservedWorkKind;
  confidence: number;
  confidenceBand: string;
  rationale?: string;
  topicKey?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  completedAt?: string;
  evidenceCount: number;
  sources?: ObservedWorkSource[];
};

export type ObservedWorkDensityResult = {
  density: {
    totalObserved: number;
    completed: number;
    unfinished: number;
    ambiguous: number;
    dismissed: number;
    decisionRecorded: number;
  };
  topUnfinished: ObservedWorkDensityItem[];
  completedHighlights: ObservedWorkDensityItem[];
  ambiguous: ObservedWorkDensityItem[];
  decisions: ObservedWorkDensityItem[];
  dismissedItems: ObservedWorkDensityItem[];
  itemsIncluded: number;
  itemsOmitted: number;
};

function rowToItem(
  row: ObservedWorkRow,
  sourcesByWorkItemId?: Map<string, ObservedWorkSource[]>
): ObservedWorkDensityItem {
  return {
    workItemId: row.work_item_id,
    conversationId: row.conversation_id,
    title: row.title,
    observedStatus: row.observed_status,
    kind: row.kind,
    confidence: row.confidence,
    confidenceBand: row.confidence_band,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    ...(row.topic_key ? { topicKey: row.topic_key } : {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    evidenceCount: row.evidence_count,
    ...(sourcesByWorkItemId
      ? { sources: sourcesByWorkItemId.get(row.work_item_id) ?? [] }
      : {}),
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export class ObservedWorkStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertItem(item: ObservedWorkItemInput): void {
    // Clamp confidence to [0, 1] before binding so out-of-range inputs from
    // upstream extractors (e.g. an LLM returning 1.7 or -0.2) cannot poison
    // downstream filters that assume the column stays in the documented range.
    const confidenceRaw =
      item.confidence == null
        ? null
        : Math.max(0, Math.min(1, item.confidence));
    // For optional-with-default fields (confidence, confidence_band,
    // authority_source, evidence_count, source_*_count), we bind NULL when the
    // caller did not supply a value. The INSERT path uses COALESCE(?, default)
    // in VALUES so the NOT-NULL constraints hold on first insert. The
    // ON CONFLICT path then references the raw bound parameter via a separate
    // placeholder so a missing value preserves the existing row instead of
    // overwriting it with the default.
    const ownerId = item.ownerId ?? null;
    const description = item.description ?? null;
    const confidenceBand = item.confidenceBand ?? null;
    const rationale = item.rationale ?? null;
    const topicKey = item.topicKey ?? null;
    const evidenceCount = item.evidenceCount ?? null;
    const sourceMessageCount = item.sourceMessageCount ?? null;
    const sourceTokenCount = item.sourceTokenCount ?? null;
    const authoritySource = item.authoritySource ?? null;
    const sensitivity = item.sensitivity ?? null;
    const visibility = item.visibility ?? null;
    this.db.prepare(
      `INSERT INTO lcm_observed_work_items (
        work_item_id, conversation_id, owner_id, title, description, observed_status, kind,
        confidence, confidence_band, rationale, topic_key, first_seen_at, last_seen_at,
        completed_at, completion_confidence, evidence_count, source_message_count,
        source_token_count, authority_source, sensitivity, visibility, fingerprint,
        fingerprint_version, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        COALESCE(?, 0.5), COALESCE(?, 'medium'), ?, ?, ?, ?,
        ?, ?, COALESCE(?, 0), COALESCE(?, 0),
        COALESCE(?, 0), COALESCE(?, 'lcm_observed'), ?, ?, ?,
        ?, datetime('now')
      )
      ON CONFLICT(work_item_id) DO UPDATE SET
        -- conversation_id is intentionally NOT updated on conflict. Treating it
        -- as immutable prevents an existing observed-work row (and its sources)
        -- from being silently moved between conversations if a workItemId is
        -- ever reused, which would corrupt history and leak evidence across
        -- conversation boundaries.
        --
        -- Optional fields below use COALESCE(?, existing.X) so a partial
        -- re-upsert (e.g. lighter snapshot that omits ownerId, description,
        -- rationale, etc.) does not blow away values established by a richer
        -- earlier snapshot. Counters use MAX so they cannot regress under a
        -- smaller snapshot. Required fields (title, observed_status, kind)
        -- and per-snapshot stable fields (fingerprint, last_seen_at, etc.)
        -- are still overwritten directly.
        owner_id = COALESCE(?, lcm_observed_work_items.owner_id),
        title = excluded.title,
        description = COALESCE(?, lcm_observed_work_items.description),
        observed_status = excluded.observed_status,
        kind = excluded.kind,
        confidence = COALESCE(?, lcm_observed_work_items.confidence),
        confidence_band = COALESCE(?, lcm_observed_work_items.confidence_band),
        rationale = COALESCE(?, lcm_observed_work_items.rationale),
        topic_key = COALESCE(?, lcm_observed_work_items.topic_key),
        first_seen_at = CASE
          WHEN excluded.first_seen_at < lcm_observed_work_items.first_seen_at
            THEN excluded.first_seen_at
          ELSE lcm_observed_work_items.first_seen_at
        END,
        last_seen_at = CASE
          WHEN excluded.last_seen_at > lcm_observed_work_items.last_seen_at
            THEN excluded.last_seen_at
          ELSE lcm_observed_work_items.last_seen_at
        END,
        completed_at = CASE
          WHEN lcm_observed_work_items.completed_at IS NULL THEN excluded.completed_at
          WHEN excluded.completed_at IS NULL THEN lcm_observed_work_items.completed_at
          WHEN excluded.completed_at < lcm_observed_work_items.completed_at
            THEN excluded.completed_at
          ELSE lcm_observed_work_items.completed_at
        END,
        completion_confidence = CASE
          WHEN excluded.completion_confidence IS NULL THEN lcm_observed_work_items.completion_confidence
          WHEN lcm_observed_work_items.completion_confidence IS NULL THEN excluded.completion_confidence
          WHEN excluded.completion_confidence > lcm_observed_work_items.completion_confidence
            THEN excluded.completion_confidence
          ELSE lcm_observed_work_items.completion_confidence
        END,
        evidence_count = MAX(COALESCE(?, lcm_observed_work_items.evidence_count), lcm_observed_work_items.evidence_count),
        source_message_count = MAX(COALESCE(?, lcm_observed_work_items.source_message_count), lcm_observed_work_items.source_message_count),
        source_token_count = MAX(COALESCE(?, lcm_observed_work_items.source_token_count), lcm_observed_work_items.source_token_count),
        authority_source = COALESCE(?, lcm_observed_work_items.authority_source),
        sensitivity = COALESCE(?, lcm_observed_work_items.sensitivity),
        visibility = COALESCE(?, lcm_observed_work_items.visibility),
        fingerprint = excluded.fingerprint,
        fingerprint_version = excluded.fingerprint_version,
        updated_at = datetime('now')`,
    ).run(
      // INSERT VALUES binds (23 params)
      item.workItemId,
      item.conversationId,
      ownerId,
      item.title,
      description,
      item.observedStatus,
      item.kind,
      confidenceRaw,
      confidenceBand,
      rationale,
      topicKey,
      item.firstSeenAt,
      item.lastSeenAt,
      item.completedAt ?? null,
      item.completionConfidence ?? null,
      evidenceCount,
      sourceMessageCount,
      sourceTokenCount,
      authoritySource,
      sensitivity,
      visibility,
      item.fingerprint,
      item.fingerprintVersion ?? 1,
      // ON CONFLICT DO UPDATE binds — re-bind the raw NULL-or-value so the
      // COALESCE(?, existing.X) pattern preserves prior values on partial
      // re-upserts.
      ownerId,
      description,
      confidenceRaw,
      confidenceBand,
      rationale,
      topicKey,
      evidenceCount,
      sourceMessageCount,
      sourceTokenCount,
      authoritySource,
      sensitivity,
      visibility,
    );
  }

  addSource(input: {
    workItemId: string;
    sourceType: "summary" | "rollup" | "message";
    sourceId: string;
    ordinal: number;
    evidenceKind: "created" | "reinforced" | "possible_completion" | "completed" | "contradicted" | "dismissed";
  }): void {
    this.db.prepare(
      `INSERT INTO lcm_observed_work_sources (
        work_item_id, source_type, source_id, ordinal, evidence_kind
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(work_item_id, source_type, source_id, evidence_kind) DO UPDATE SET
        ordinal = excluded.ordinal`,
    ).run(input.workItemId, input.sourceType, input.sourceId, input.ordinal, input.evidenceKind);
  }

  upsertState(input: {
    conversationId: number;
    lastProcessedSummaryCreatedAt?: string;
    lastProcessedSummaryId?: string;
    pendingRebuild?: boolean;
  }): void {
    const pendingRebuild =
      input.pendingRebuild == null ? null : input.pendingRebuild ? 1 : 0;
    this.db.prepare(
      `INSERT INTO lcm_observed_work_state (
        conversation_id, last_processed_summary_created_at, last_processed_summary_id,
        pending_rebuild, updated_at
      ) VALUES (?, ?, ?, COALESCE(?, 0), datetime('now'))
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_processed_summary_created_at = CASE
          WHEN ? IS NULL THEN lcm_observed_work_state.last_processed_summary_created_at
          ELSE excluded.last_processed_summary_created_at
        END,
        last_processed_summary_id = CASE
          WHEN ? IS NULL THEN lcm_observed_work_state.last_processed_summary_id
          ELSE excluded.last_processed_summary_id
        END,
        pending_rebuild = CASE
          WHEN ? IS NULL THEN lcm_observed_work_state.pending_rebuild
          ELSE excluded.pending_rebuild
        END,
        updated_at = datetime('now')`,
    ).run(
      input.conversationId,
      input.lastProcessedSummaryCreatedAt ?? null,
      input.lastProcessedSummaryId ?? null,
      pendingRebuild,
      input.lastProcessedSummaryCreatedAt ?? null,
      input.lastProcessedSummaryId ?? null,
      pendingRebuild,
    );
  }

  getDensity(query: ObservedWorkDensityQuery): ObservedWorkDensityResult {
    const where: string[] = [
      `EXISTS (
        SELECT 1
        FROM lcm_observed_work_sources src
        WHERE src.work_item_id = lcm_observed_work_items.work_item_id
      )`,
    ];
    const args: SQLInputValue[] = [];
    if (query.conversationId != null) {
      where.push("conversation_id = ?");
      args.push(query.conversationId);
    }
    if (query.since) {
      // ISO 8601 Z timestamps sort lexicographically, so a direct range
      // predicate is index-friendly (composite idx on
      // conversation_id, observed_status, kind, last_seen_at DESC).
      where.push("last_seen_at >= ?");
      args.push(query.since);
    }
    if (query.before) {
      where.push("first_seen_at < ?");
      args.push(query.before);
    }
    if (query.statuses?.length) {
      where.push(`observed_status IN (${placeholders(query.statuses)})`);
      args.push(...query.statuses);
    }
    if (query.kinds?.length) {
      where.push(`kind IN (${placeholders(query.kinds)})`);
      args.push(...query.kinds);
    }
    if (query.topic) {
      where.push("topic_key = ?");
      args.push(query.topic);
    }
    if (query.minConfidence != null) {
      where.push("confidence >= ?");
      args.push(query.minConfidence);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
    const ambiguousLimit = limit;
    const counts = this.db.prepare(
      `SELECT
         COUNT(*) AS total_observed,
         SUM(CASE WHEN observed_status = 'observed_completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN observed_status = 'observed_unfinished' THEN 1 ELSE 0 END) AS unfinished,
         SUM(CASE WHEN observed_status = 'observed_ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
         SUM(CASE WHEN observed_status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
         SUM(CASE WHEN observed_status = 'decision_recorded' THEN 1 ELSE 0 END) AS decision_recorded
       FROM lcm_observed_work_items
       ${whereSql}`,
    ).get(...args) as ObservedWorkDensityCountRow;

    const statusAllowed = (status: ObservedWorkStatus): boolean =>
      !query.statuses?.length || query.statuses.includes(status);
    const getRowsForStatus = (
      status: ObservedWorkStatus,
      statusLimit: number,
    ): ObservedWorkRow[] => {
      if (!statusAllowed(status) || statusLimit <= 0) {
        return [];
      }
      const statusWhereSql =
        where.length > 0
          ? `WHERE ${where.join(" AND ")} AND observed_status = ?`
          : "WHERE observed_status = ?";
      return this.db.prepare(
        `SELECT work_item_id, conversation_id, title, observed_status, kind, confidence,
                confidence_band, rationale, topic_key, first_seen_at, last_seen_at,
                completed_at, evidence_count
         FROM lcm_observed_work_items
         ${statusWhereSql}
         ORDER BY last_seen_at DESC, confidence DESC
         LIMIT ?`,
      ).all(...args, status, statusLimit) as ObservedWorkRow[];
    };

    const unfinishedRows = getRowsForStatus("observed_unfinished", limit);
    const completedRows = getRowsForStatus("observed_completed", limit);
    const ambiguousRows = getRowsForStatus("observed_ambiguous", ambiguousLimit);
    const decisionRows = getRowsForStatus("decision_recorded", limit);
    const dismissedRows = getRowsForStatus("dismissed", limit);
    const includedRows = [
      ...unfinishedRows,
      ...completedRows,
      ...ambiguousRows,
      ...decisionRows,
      ...dismissedRows,
    ];
    const includedIds = new Set<string>(includedRows.map((row) => row.work_item_id));
    const sourcesByWorkItemId = query.includeSources
      ? this.getSourcesForWorkItems([...includedIds])
      : undefined;
    return {
      density: {
        totalObserved: counts.total_observed ?? 0,
        completed: counts.completed ?? 0,
        unfinished: counts.unfinished ?? 0,
        ambiguous: counts.ambiguous ?? 0,
        dismissed: counts.dismissed ?? 0,
        decisionRecorded: counts.decision_recorded ?? 0,
      },
      topUnfinished: unfinishedRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      completedHighlights: completedRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      ambiguous: ambiguousRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      decisions: decisionRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      dismissedItems: dismissedRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      itemsIncluded: includedIds.size,
      itemsOmitted: Math.max(0, (counts.total_observed ?? 0) - includedIds.size),
    };
  }

  private getSourcesForWorkItems(
    workItemIds: string[],
    perItemLimit = 20,
  ): Map<string, ObservedWorkSource[]> {
    if (workItemIds.length === 0) {
      return new Map();
    }
    const sourceLimit = Math.max(1, Math.min(Math.trunc(perItemLimit), 50));
    const rows = this.db
      .prepare(
        `WITH ranked_sources AS (
           SELECT work_item_id, source_type, source_id, ordinal, evidence_kind,
                  ROW_NUMBER() OVER (
                    PARTITION BY work_item_id
                    ORDER BY ordinal ASC, created_at ASC
                  ) AS source_rank
           FROM lcm_observed_work_sources
           WHERE work_item_id IN (${placeholders(workItemIds)})
         )
         SELECT work_item_id, source_type, source_id, ordinal, evidence_kind
         FROM ranked_sources
         WHERE source_rank <= ?
         ORDER BY work_item_id ASC, ordinal ASC`
      )
      .all(...workItemIds, sourceLimit) as ObservedWorkSourceRow[];
    const grouped = new Map<string, ObservedWorkSource[]>();
    for (const row of rows) {
      const sources = grouped.get(row.work_item_id) ?? [];
      sources.push({
        sourceType: row.source_type,
        sourceId: row.source_id,
        ordinal: row.ordinal,
        evidenceKind: row.evidence_kind,
      });
      grouped.set(row.work_item_id, sources);
    }
    return grouped;
  }
}
