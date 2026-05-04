import type { DatabaseSync, SQLInputValue } from "node:sqlite";
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

type ValidatedUpsertArgs = {
  suggestionId: string;
  workItemId: string;
  taskId: string | undefined;
  suggestionKind: TaskBridgeSuggestionKind;
  confidence: number;
  rationale: string;
  sourceIds: string[];
  createdBy: string;
};

export class TaskBridgeSuggestionStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Counter used to make per-row savepoint names unique within a process. */
  private static savepointId = 0;

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

  private validateAndNormalizeUpsertInput(
    input: TaskBridgeSuggestionInput
  ): ValidatedUpsertArgs {
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
    if (sourceIds.length > MAX_SUGGESTION_SOURCE_IDS) {
      throw new Error(
        `sourceIds must not exceed ${MAX_SUGGESTION_SOURCE_IDS} entries (received ${sourceIds.length}).`
      );
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

  async upsertSuggestion(
    input: TaskBridgeSuggestionInput
  ): Promise<TaskBridgeSuggestionUpsertResult> {
    const args = this.validateAndNormalizeUpsertInput(input);
    // Wrap the read-then-write (status check + INSERT … ON CONFLICT DO UPDATE)
    // in a single transaction. Without it, two concurrent upserts can both
    // observe `existingStatus === undefined`, both report "inserted", and
    // race on the conflict resolution. Route through `withDatabaseTransaction`
    // so we participate in the per-DB async mutex (issue #260) — a raw
    // BEGIN IMMEDIATE here would throw if a future caller invoked us from
    // inside an enclosing transaction on the same shared DatabaseSync handle.
    return withDatabaseTransaction(this.db, "BEGIN IMMEDIATE", () =>
      this.upsertSuggestionInTransaction(args)
    );
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
   * source IDs, or sourceIds beyond MAX_SUGGESTION_SOURCE_IDS) still throw
   * before the transaction opens — the whole batch aborts with no fsync. Once
   * inside the transaction, per-row INSERT/UPSERT errors (e.g. a concurrent
   * FK-deletion of the work item or its source evidence) are demoted to a
   * "skipped" outcome via SQLite SAVEPOINTs around each row, so a single bad
   * row does not poison the rest of the batch. The result array is
   * order-preserving: `results[i]` corresponds to `inputs[i]`.
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

  private upsertSuggestionInTransaction(
    args: ValidatedUpsertArgs
  ): TaskBridgeSuggestionUpsertResult {
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
            -- Refreshed kind drives task_id: link/mark/add suggestions get
            -- excluded.task_id (which is required and validated above for
            -- task-targeting kinds), create_task gets NULL (it intentionally
            -- targets no task). COALESCE-ing the old value would leave a
            -- stale task association on a pending row whose kind no longer
            -- targets that task — listSuggestions({ taskId }) would then
            -- return suggestions that don't actually concern that task.
            THEN excluded.task_id
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

  listSuggestions(input?: {
    status?: TaskBridgeSuggestionStatus;
    suggestionKind?: TaskBridgeSuggestionKind;
    workItemId?: string;
    taskId?: string;
    limit?: number;
  }): TaskBridgeSuggestion[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
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
    // SQLite `datetime('now')` is whole-second precision, so suggestions
    // refreshed in the same scan tick share `updated_at` and `created_at`.
    // Without a deterministic tiebreaker their relative order in the result
    // depends on storage layout — append `suggestion_id ASC` so the ordering
    // is stable and tests can rely on it.
    const rows = this.db.prepare(
      `SELECT suggestion_id, work_item_id, task_id, suggestion_kind, status,
              confidence, rationale, source_ids, created_by, reviewed_by, reviewed_at,
              created_at, updated_at
       FROM lcm_task_bridge_suggestions
       ${whereSql}
       ORDER BY updated_at DESC, created_at DESC, suggestion_id ASC
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
    const suggestionId = input.suggestionId?.trim();
    if (!suggestionId) {
      throw new Error("suggestionId is required.");
    }
    const reviewedBy = input.reviewedBy?.trim() || null;
    const result = this.db.prepare(
      `UPDATE lcm_task_bridge_suggestions
       SET status = ?,
           reviewed_by = COALESCE(?, reviewed_by),
           reviewed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE suggestion_id = ? AND status = 'pending'`,
    ).run(input.status, reviewedBy, suggestionId);
    return result.changes > 0;
  }

  /**
   * Returns the observed-work conversation_id for the given suggestion (joined
   * via work_item_id), or undefined if the suggestion does not exist or its
   * underlying observed-work item has been deleted. Used by the review tool to
   * gate cross-conversation review updates.
   */
  getSuggestionConversationId(suggestionId: string): number | undefined {
    const trimmed = suggestionId?.trim();
    if (!trimmed) {
      return undefined;
    }
    const row = this.db
      .prepare(
        `SELECT owi.conversation_id AS conversation_id
         FROM lcm_task_bridge_suggestions AS s
         JOIN lcm_observed_work_items AS owi
           ON owi.work_item_id = s.work_item_id
         WHERE s.suggestion_id = ?`
      )
      .get(trimmed) as { conversation_id: number } | undefined;
    return row?.conversation_id;
  }
}
