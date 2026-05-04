import type { DatabaseSync } from "node:sqlite";

export type TaskBridgeSuggestionKind =
  | "create_task"
  | "link_task"
  | "mark_task_done"
  | "mark_task_blocked"
  | "add_task_evidence";

export type TaskBridgeSuggestionStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "dismissed"
  | "expired";

export type TaskBridgeSuggestionInput = {
  suggestionId: string;
  workItemId: string;
  taskId?: string;
  suggestionKind: TaskBridgeSuggestionKind;
  status?: TaskBridgeSuggestionStatus;
  confidence: number;
  rationale: string;
  sourceIds: string[];
  createdBy?: string;
};

export type TaskBridgeSuggestion = {
  suggestionId: string;
  workItemId: string;
  taskId?: string;
  suggestionKind: TaskBridgeSuggestionKind;
  status: TaskBridgeSuggestionStatus;
  confidence: number;
  rationale: string;
  sourceIds: string[];
  createdBy: string;
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskBridgeSuggestionUpsertResult =
  | "inserted"
  | "refreshed"
  | "preserved_reviewed";

type TaskBridgeSuggestionRow = {
  suggestion_id: string;
  work_item_id: string;
  task_id: string | null;
  suggestion_kind: TaskBridgeSuggestionKind;
  status: TaskBridgeSuggestionStatus;
  confidence: number;
  rationale: string;
  source_ids: string;
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

const REVIEW_STATUSES = new Set<TaskBridgeSuggestionStatus>([
  "accepted",
  "rejected",
  "dismissed",
  "expired",
]);

const TASK_TARGETING_KINDS = new Set<TaskBridgeSuggestionKind>([
  "link_task",
  "mark_task_done",
  "mark_task_blocked",
  "add_task_evidence",
]);

const MAX_SUGGESTION_SOURCE_IDS = 50;
const SQLITE_BIND_CHUNK_SIZE = 500;

function normalizeSourceIds(sourceIds: string[]): string[] {
  return [
    ...new Set(
      sourceIds
        .map((sourceId) => sourceId.trim())
        .filter((sourceId) => sourceId.length > 0)
    ),
  ];
}

function chunk<T>(values: T[], size: number): T[][] {
  if (size <= 0 || values.length <= size) {
    return values.length === 0 ? [] : [values];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function rowToSuggestion(row: TaskBridgeSuggestionRow): TaskBridgeSuggestion {
  let sourceIds: string[] = [];
  try {
    const parsed = JSON.parse(row.source_ids) as unknown;
    sourceIds = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    sourceIds = [];
  }
  return {
    suggestionId: row.suggestion_id,
    workItemId: row.work_item_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    suggestionKind: row.suggestion_kind,
    status: row.status,
    confidence: row.confidence,
    rationale: row.rationale,
    sourceIds,
    createdBy: row.created_by,
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskBridgeSuggestionStore {
  constructor(private readonly db: DatabaseSync) {}

  private getSuggestionStatus(
    suggestionId: string
  ): TaskBridgeSuggestionStatus | undefined {
    const row = this.db
      .prepare(
        `SELECT status
         FROM lcm_task_bridge_suggestions
         WHERE suggestion_id = ?`
      )
      .get(suggestionId) as { status: TaskBridgeSuggestionStatus } | undefined;
    return row?.status;
  }

  private assertSourceIdsBelongToWorkItem(
    workItemId: string,
    sourceIds: string[]
  ): void {
    if (sourceIds.length === 0) {
      return;
    }
    // Chunk the IN(...) lookup so dense evidence sets can't exceed the
    // SQLite bind-variable limit (mirrors ObservedWorkExtractor.loadExistingItems).
    const found = new Set<string>();
    for (const batch of chunk(sourceIds, SQLITE_BIND_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT DISTINCT source_id
           FROM lcm_observed_work_sources
           WHERE work_item_id = ?
             AND source_id IN (${placeholders})`
        )
        .all(workItemId, ...batch) as Array<{ source_id: string }>;
      for (const row of rows) {
        found.add(row.source_id);
      }
    }
    const missing = sourceIds.filter((sourceId) => !found.has(sourceId));
    if (missing.length > 0) {
      throw new Error(
        `source IDs must reference observed-work evidence for this work item: ${missing.join(", ")}`
      );
    }
  }

  upsertSuggestion(input: TaskBridgeSuggestionInput): TaskBridgeSuggestionUpsertResult {
    const suggestionId = input.suggestionId.trim();
    if (suggestionId.length === 0) {
      throw new Error("suggestionId is required.");
    }
    const workItemId = input.workItemId.trim();
    if (workItemId.length === 0) {
      throw new Error("workItemId is required.");
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error("confidence must be between 0 and 1.");
    }
    if (input.rationale.trim().length === 0) {
      throw new Error("rationale is required.");
    }
    const requestedStatus = input.status ?? "pending";
    if (requestedStatus !== "pending") {
      throw new Error(
        "upsertSuggestion only creates or refreshes pending suggestions; use reviewSuggestion for reviewed states."
      );
    }
    const taskId = input.taskId?.trim();
    if (TASK_TARGETING_KINDS.has(input.suggestionKind) && !taskId) {
      throw new Error(`${input.suggestionKind} suggestions require taskId.`);
    }
    const existingStatus = this.getSuggestionStatus(suggestionId);
    if (existingStatus && existingStatus !== "pending") {
      return "preserved_reviewed";
    }
    const sourceIds = normalizeSourceIds(input.sourceIds);
    if (sourceIds.length === 0) {
      throw new Error("at least one source ID is required.");
    }
    if (sourceIds.length > MAX_SUGGESTION_SOURCE_IDS) {
      throw new Error(
        `sourceIds must not exceed ${MAX_SUGGESTION_SOURCE_IDS} entries (received ${sourceIds.length}).`
      );
    }
    this.assertSourceIdsBelongToWorkItem(workItemId, sourceIds);
    this.db.prepare(
      `INSERT INTO lcm_task_bridge_suggestions (
        suggestion_id, work_item_id, task_id, suggestion_kind, status, confidence,
        rationale, source_ids, created_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(suggestion_id) DO UPDATE SET
        work_item_id = CASE
          WHEN lcm_task_bridge_suggestions.status = 'pending' THEN excluded.work_item_id
          ELSE lcm_task_bridge_suggestions.work_item_id
        END,
        task_id = CASE
          WHEN lcm_task_bridge_suggestions.status = 'pending'
            THEN COALESCE(excluded.task_id, lcm_task_bridge_suggestions.task_id)
          ELSE lcm_task_bridge_suggestions.task_id
        END,
        suggestion_kind = CASE
          WHEN lcm_task_bridge_suggestions.status = 'pending' THEN excluded.suggestion_kind
          ELSE lcm_task_bridge_suggestions.suggestion_kind
        END,
        confidence = CASE
          WHEN lcm_task_bridge_suggestions.status = 'pending' THEN excluded.confidence
          ELSE lcm_task_bridge_suggestions.confidence
        END,
        rationale = CASE
          WHEN lcm_task_bridge_suggestions.status = 'pending' THEN excluded.rationale
          ELSE lcm_task_bridge_suggestions.rationale
        END,
        source_ids = CASE
          WHEN lcm_task_bridge_suggestions.status = 'pending' THEN excluded.source_ids
          ELSE lcm_task_bridge_suggestions.source_ids
        END,
        updated_at = CASE
          WHEN lcm_task_bridge_suggestions.status = 'pending' THEN datetime('now')
          ELSE lcm_task_bridge_suggestions.updated_at
        END`,
    ).run(
      suggestionId,
      workItemId,
      taskId ?? null,
      input.suggestionKind,
      "pending",
      input.confidence,
      input.rationale.trim(),
      JSON.stringify(sourceIds),
      input.createdBy?.trim() || "lcm_observed",
    );
    return existingStatus === "pending" ? "refreshed" : "inserted";
  }

  listSuggestions(input?: {
    status?: TaskBridgeSuggestionStatus;
    suggestionKind?: TaskBridgeSuggestionKind;
    workItemId?: string;
    taskId?: string;
    limit?: number;
  }): TaskBridgeSuggestion[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (input?.status) {
      where.push("status = ?");
      args.push(input.status);
    }
    if (input?.suggestionKind) {
      where.push("suggestion_kind = ?");
      args.push(input.suggestionKind);
    }
    // Trim filter IDs so callers passing whitespace-padded IDs still match the
    // (trimmed) values that upsertSuggestion writes.
    const filterWorkItemId = normalizeOptionalId(input?.workItemId);
    if (filterWorkItemId) {
      where.push("work_item_id = ?");
      args.push(filterWorkItemId);
    }
    const filterTaskId = normalizeOptionalId(input?.taskId);
    if (filterTaskId) {
      where.push("task_id = ?");
      args.push(filterTaskId);
    }
    const limit = Math.max(1, Math.min(input?.limit ?? 20, 100));
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT suggestion_id, work_item_id, task_id, suggestion_kind, status,
              confidence, rationale, source_ids, created_by, reviewed_by, reviewed_at,
              created_at, updated_at
       FROM lcm_task_bridge_suggestions
       ${whereSql}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT ?`,
    ).all(...args, limit) as TaskBridgeSuggestionRow[];
    return rows.map(rowToSuggestion);
  }

  reviewSuggestion(input: {
    suggestionId: string;
    status: Exclude<TaskBridgeSuggestionStatus, "pending">;
    reviewedBy?: string;
  }): boolean {
    if (!REVIEW_STATUSES.has(input.status)) {
      throw new Error("review status must be accepted, rejected, dismissed, or expired.");
    }
    // Trim suggestionId/reviewedBy so callers passing whitespace-padded values
    // still match the (trimmed) IDs that upsertSuggestion writes.
    const suggestionId = normalizeOptionalId(input.suggestionId);
    if (!suggestionId) {
      throw new Error("suggestionId is required.");
    }
    const reviewedBy = normalizeOptionalId(input.reviewedBy);
    const result = this.db.prepare(
      `UPDATE lcm_task_bridge_suggestions
       SET status = ?,
           reviewed_by = COALESCE(?, reviewed_by),
           reviewed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE suggestion_id = ? AND status = 'pending'`,
    ).run(input.status, reviewedBy ?? null, suggestionId);
    return result.changes > 0;
  }
}
