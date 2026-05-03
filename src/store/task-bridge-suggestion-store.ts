import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";

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
  | "preserved_reviewed"
  | "skipped";

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

function normalizeSourceIds(sourceIds: string[]): string[] {
  return [
    ...new Set(
      sourceIds
        .map((sourceId) => sourceId.trim())
        .filter((sourceId) => sourceId.length > 0)
    ),
  ];
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
    const placeholders = sourceIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_id
         FROM lcm_observed_work_sources
         WHERE work_item_id = ?
           AND source_id IN (${placeholders})`
      )
      .all(workItemId, ...sourceIds) as Array<{ source_id: string }>;
    const found = new Set(rows.map((row) => row.source_id));
    const missing = sourceIds.filter((sourceId) => !found.has(sourceId));
    if (missing.length > 0) {
      throw new Error(
        `source IDs must reference observed-work evidence for this work item: ${missing.join(", ")}`
      );
    }
  }

  async upsertSuggestion(
    input: TaskBridgeSuggestionInput
  ): Promise<TaskBridgeSuggestionUpsertResult> {
    const args = this.validateAndNormalizeUpsertInput(input);
    return withDatabaseTransaction(this.db, "BEGIN IMMEDIATE", () =>
      this.upsertSuggestionInTransaction(args)
    );
  }

  private validateAndNormalizeUpsertInput(input: TaskBridgeSuggestionInput): {
    suggestionId: string;
    workItemId: string;
    taskId: string | undefined;
    suggestionKind: TaskBridgeSuggestionKind;
    confidence: number;
    rationale: string;
    sourceIds: string[];
    createdBy: string;
  } {
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
    const sourceIds = normalizeSourceIds(input.sourceIds);
    if (sourceIds.length === 0) {
      throw new Error("at least one source ID is required.");
    }
    return {
      suggestionId,
      workItemId,
      taskId,
      suggestionKind: input.suggestionKind,
      confidence: input.confidence,
      rationale: input.rationale.trim(),
      sourceIds,
      createdBy: input.createdBy?.trim() || "lcm_observed",
    };
  }

  /**
   * Upsert many suggestions inside a single SQLite transaction.
   *
   * Each individual upsert still preserves the same CASE-WHEN guards as
   * `upsertSuggestion`, but the whole batch commits with one fsync, which is a
   * dramatic speed-up when callers (e.g. the LCM task suggestion tool's
   * `record` mode) push 50 candidates at once.
   *
   * Per-row failure semantics: input validation errors (bad confidence, blank
   * IDs, requested non-pending status, missing taskId for targeted kinds, no
   * source IDs) still throw before the transaction opens — the whole batch
   * aborts with no fsync. Once inside the transaction, per-row INSERT/UPSERT
   * errors (e.g. a concurrent FK-deletion of the work item or its source
   * evidence) are demoted to a "skipped" outcome via SQLite SAVEPOINTs around
   * each row, so a single bad row does not poison the rest of the batch. The
   * result array is order-preserving: `results[i]` corresponds to `inputs[i]`.
   */
  async bulkUpsertSuggestions(
    inputs: TaskBridgeSuggestionInput[]
  ): Promise<TaskBridgeSuggestionUpsertResult[]> {
    if (inputs.length === 0) {
      // Skip transaction entirely when there's nothing to do.
      return [];
    }
    const prepared = inputs.map((input) =>
      this.validateAndNormalizeUpsertInput(input)
    );
    return withDatabaseTransaction(this.db, "BEGIN IMMEDIATE", () =>
      prepared.map((args) => {
        const savepointName = `lcm_task_bridge_row_sp_${++TaskBridgeSuggestionStore.savepointId}`;
        this.db.exec(`SAVEPOINT ${savepointName}`);
        try {
          const result = this.upsertSuggestionInTransaction(args);
          this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
          return result;
        } catch {
          // Demote to "skipped" instead of poisoning the whole batch. Common
          // causes: concurrent FK-deletion of the work item or its observed
          // source evidence between candidate scan and INSERT.
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
          return "skipped" as TaskBridgeSuggestionUpsertResult;
        }
      })
    );
  }

  private upsertSuggestionInTransaction(args: {
    suggestionId: string;
    workItemId: string;
    taskId: string | undefined;
    suggestionKind: TaskBridgeSuggestionKind;
    confidence: number;
    rationale: string;
    sourceIds: string[];
    createdBy: string;
  }): TaskBridgeSuggestionUpsertResult {
    const existingStatus = this.getSuggestionStatus(args.suggestionId);
    if (existingStatus && existingStatus !== "pending") {
      return "preserved_reviewed";
    }
    this.assertSourceIdsBelongToWorkItem(args.workItemId, args.sourceIds);
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
      args.suggestionId,
      args.workItemId,
      args.taskId ?? null,
      args.suggestionKind,
      "pending",
      args.confidence,
      args.rationale,
      JSON.stringify(args.sourceIds),
      args.createdBy,
    );
    return existingStatus === "pending" ? "refreshed" : "inserted";
  }

  /** Counter used to make per-row savepoint names unique within a process. */
  private static savepointId = 0;

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
    if (input?.workItemId) {
      where.push("work_item_id = ?");
      args.push(input.workItemId);
    }
    if (input?.taskId) {
      where.push("task_id = ?");
      args.push(input.taskId);
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
    const reviewedBy = input.reviewedBy?.trim() || null;
    const result = this.db.prepare(
      `UPDATE lcm_task_bridge_suggestions
       SET status = ?,
           reviewed_by = COALESCE(?, reviewed_by),
           reviewed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE suggestion_id = ? AND status = 'pending'`,
    ).run(input.status, reviewedBy, input.suggestionId);
    return result.changes > 0;
  }
}
