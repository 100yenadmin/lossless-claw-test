import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";

export interface RollupRow {
  rollup_id: string;
  conversation_id: number;
  period_kind: "day" | "week" | "month";
  period_key: string;
  period_start: string;
  period_end: string;
  timezone: string;
  content: string;
  token_count: number;
  source_summary_ids: string;
  source_message_count: number;
  source_token_count: number;
  status: "building" | "ready" | "stale" | "failed";
  coverage_start: string | null;
  coverage_end: string | null;
  summarizer_model: string | null;
  source_fingerprint: string | null;
  built_at: string;
  invalidated_at: string | null;
  error_text: string | null;
}

export interface RollupStateRow {
  conversation_id: number;
  timezone: string;
  last_message_at: string | null;
  last_rollup_check_at: string | null;
  last_daily_build_at: string | null;
  pending_rebuild: number;
  updated_at: string;
}

export interface RollupSourceRow {
  source_type: string;
  source_id: string;
  ordinal: number;
}

export interface RollupSourceInput {
  type: "summary" | "rollup";
  id: string;
  ordinal: number;
}

export interface LeafSummaryForDayRow {
  summary_id: string;
  content: string;
  token_count: number;
  earliest_at: string | null;
  latest_at: string | null;
  created_at: string;
}

export class RollupStore {
  constructor(public db: DatabaseSync) {}

  upsertRollup(input: Omit<RollupRow, "built_at" | "invalidated_at" | "error_text">): void {
    const rollupId = input.rollup_id || randomUUID();

    this.db
      .prepare(
        `INSERT INTO lcm_rollups (
          rollup_id,
          conversation_id,
          period_kind,
          period_key,
          period_start,
          period_end,
          timezone,
          content,
          token_count,
          source_summary_ids,
          source_message_count,
          source_token_count,
          status,
          coverage_start,
          coverage_end,
          summarizer_model,
          source_fingerprint,
          built_at,
          invalidated_at,
          error_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, NULL)
        ON CONFLICT(conversation_id, period_kind, period_key) DO UPDATE SET
          period_start = excluded.period_start,
          period_end = excluded.period_end,
          timezone = excluded.timezone,
          content = excluded.content,
          token_count = excluded.token_count,
          source_summary_ids = excluded.source_summary_ids,
          source_message_count = excluded.source_message_count,
          source_token_count = excluded.source_token_count,
          status = excluded.status,
          coverage_start = excluded.coverage_start,
          coverage_end = excluded.coverage_end,
          summarizer_model = excluded.summarizer_model,
          source_fingerprint = excluded.source_fingerprint,
          built_at = datetime('now'),
          invalidated_at = NULL,
          error_text = NULL`,
      )
      .run(
        rollupId,
        input.conversation_id,
        input.period_kind,
        input.period_key,
        input.period_start,
        input.period_end,
        input.timezone,
        input.content,
        input.token_count,
        input.source_summary_ids,
        input.source_message_count,
        input.source_token_count,
        input.status,
        input.coverage_start,
        input.coverage_end,
        input.summarizer_model,
        input.source_fingerprint,
      );
  }

  getRollup(
    conversationId: number,
    periodKind: string,
    periodKey: string,
  ): RollupRow | null {
    const row = this.db
      .prepare(
        `SELECT
          rollup_id,
          conversation_id,
          period_kind,
          period_key,
          period_start,
          period_end,
          timezone,
          content,
          token_count,
          source_summary_ids,
          source_message_count,
          source_token_count,
          status,
          coverage_start,
          coverage_end,
          summarizer_model,
          source_fingerprint,
          built_at,
          invalidated_at,
          error_text
        FROM lcm_rollups
        WHERE conversation_id = ?
          AND period_kind = ?
          AND period_key = ?`,
      )
      .get(conversationId, periodKind, periodKey) as RollupRow | undefined;

    return row ?? null;
  }

  getRollupById(rollupId: string): RollupRow | null {
    const row = this.db
      .prepare(
        `SELECT
          rollup_id,
          conversation_id,
          period_kind,
          period_key,
          period_start,
          period_end,
          timezone,
          content,
          token_count,
          source_summary_ids,
          source_message_count,
          source_token_count,
          status,
          coverage_start,
          coverage_end,
          summarizer_model,
          source_fingerprint,
          built_at,
          invalidated_at,
          error_text
        FROM lcm_rollups
        WHERE rollup_id = ?`,
      )
      .get(rollupId) as RollupRow | undefined;

    return row ?? null;
  }

  listRollups(conversationId: number, periodKind?: string, limit = 50): RollupRow[] {
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    const sql = periodKind
      ? `SELECT
           rollup_id,
           conversation_id,
           period_kind,
           period_key,
           period_start,
           period_end,
           timezone,
           content,
           token_count,
           source_summary_ids,
           source_message_count,
           source_token_count,
           status,
           coverage_start,
           coverage_end,
           summarizer_model,
           source_fingerprint,
           built_at,
           invalidated_at,
           error_text
         FROM lcm_rollups
         WHERE conversation_id = ?
           AND period_kind = ?
         ORDER BY period_start DESC
         LIMIT ?`
      : `SELECT
           rollup_id,
           conversation_id,
           period_kind,
           period_key,
           period_start,
           period_end,
           timezone,
           content,
           token_count,
           source_summary_ids,
           source_message_count,
           source_token_count,
           status,
           coverage_start,
           coverage_end,
           summarizer_model,
           source_fingerprint,
           built_at,
           invalidated_at,
           error_text
         FROM lcm_rollups
         WHERE conversation_id = ?
         ORDER BY period_start DESC
         LIMIT ?`;

    return (periodKind
      ? this.db.prepare(sql).all(conversationId, periodKind, normalizedLimit)
      : this.db.prepare(sql).all(conversationId, normalizedLimit)) as unknown as RollupRow[];
  }

  markStale(rollupId: string): void {
    this.db
      .prepare(
        `UPDATE lcm_rollups
         SET status = 'stale',
             invalidated_at = datetime('now')
         WHERE rollup_id = ?`,
      )
      .run(rollupId);
  }

  deleteRollup(rollupId: string): void {
    this.db.prepare(`DELETE FROM lcm_rollups WHERE rollup_id = ?`).run(rollupId);
  }

  replaceRollupSources(rollupId: string, sources: RollupSourceInput[]): void {
    void withDatabaseTransaction(this.db, "BEGIN", () => {
      this.db.prepare(`DELETE FROM lcm_rollup_sources WHERE rollup_id = ?`).run(rollupId);

      if (sources.length === 0) {
        return;
      }

      const insert = this.db.prepare(
        `INSERT INTO lcm_rollup_sources (rollup_id, source_type, source_id, ordinal)
         VALUES (?, ?, ?, ?)`,
      );

      for (const source of sources) {
        insert.run(rollupId, source.type, source.id, source.ordinal);
      }
    });
  }

  getRollupSources(rollupId: string): Array<{ source_type: string; source_id: string; ordinal: number }> {
    return this.db
      .prepare(
        `SELECT source_type, source_id, ordinal
         FROM lcm_rollup_sources
         WHERE rollup_id = ?
         ORDER BY ordinal ASC`,
      )
      .all(rollupId) as unknown as RollupSourceRow[];
  }

  getState(conversationId: number): RollupStateRow | null {
    const row = this.db
      .prepare(
        `SELECT
          conversation_id,
          timezone,
          last_message_at,
          last_rollup_check_at,
          last_daily_build_at,
          pending_rebuild,
          updated_at
         FROM lcm_rollup_state
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as RollupStateRow | undefined;

    return row ?? null;
  }

  upsertState(conversationId: number, updates: Partial<RollupStateRow>): void {
    this.db
      .prepare(
        `INSERT INTO lcm_rollup_state (
          conversation_id,
          timezone,
          updated_at
        ) VALUES (?, ?, datetime('now'))
        ON CONFLICT(conversation_id) DO NOTHING`,
      )
      .run(conversationId, updates.timezone ?? "UTC");

    if (updates.timezone !== undefined) {
      this.db
        .prepare(
          `UPDATE lcm_rollup_state
           SET timezone = ?,
               updated_at = datetime('now')
           WHERE conversation_id = ?`,
        )
        .run(updates.timezone, conversationId);
    }

    if (updates.last_message_at !== undefined) {
      this.db
        .prepare(
          `UPDATE lcm_rollup_state
           SET last_message_at = ?,
               updated_at = datetime('now')
           WHERE conversation_id = ?`,
        )
        .run(updates.last_message_at, conversationId);
    }

    if (updates.last_rollup_check_at !== undefined) {
      this.db
        .prepare(
          `UPDATE lcm_rollup_state
           SET last_rollup_check_at = ?,
               updated_at = datetime('now')
           WHERE conversation_id = ?`,
        )
        .run(updates.last_rollup_check_at, conversationId);
    }

    if (updates.last_daily_build_at !== undefined) {
      this.db
        .prepare(
          `UPDATE lcm_rollup_state
           SET last_daily_build_at = ?,
               updated_at = datetime('now')
           WHERE conversation_id = ?`,
        )
        .run(updates.last_daily_build_at, conversationId);
    }

    if (updates.pending_rebuild !== undefined) {
      this.db
        .prepare(
          `UPDATE lcm_rollup_state
           SET pending_rebuild = ?,
               updated_at = datetime('now')
           WHERE conversation_id = ?`,
        )
        .run(updates.pending_rebuild, conversationId);
    }
  }

  getLeafSummariesForDay(
    conversationId: number,
    dayStart: string,
    dayEnd: string,
  ): Array<{
    summary_id: string;
    content: string;
    token_count: number;
    earliest_at: string | null;
    latest_at: string | null;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT
          summary_id,
          content,
          token_count,
          earliest_at,
          latest_at,
          created_at
         FROM summaries
         WHERE conversation_id = ?
           AND kind = 'leaf'
           AND coalesce(latest_at, earliest_at, created_at) >= ?
           AND coalesce(latest_at, earliest_at, created_at) < ?
         ORDER BY coalesce(latest_at, earliest_at, created_at) ASC, created_at ASC`,
      )
      .all(conversationId, dayStart, dayEnd) as unknown as LeafSummaryForDayRow[];
  }
}
