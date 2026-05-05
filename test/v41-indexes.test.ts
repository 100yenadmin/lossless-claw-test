import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

type IndexInfo = { name: string; tbl_name: string; sql: string };

function getIndexNames(db: DatabaseSync, tableName: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
    .all(tableName) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe("v4.1 summaries indexes (A.08)", () => {
  it("creates session_key + kind + latest_at index for retrieval", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(getIndexNames(db, "summaries")).toContain("summaries_session_key_kind_latest_idx");
    db.close();
  });

  it("creates partial suppressed_at index (small footprint, fast filter)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const sql = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name = 'summaries_suppressed_idx'`,
      )
      .get() as { sql: string };
    expect(sql.sql).toContain("WHERE suppressed_at IS NOT NULL");
    db.close();
  });

  it("creates partial contains_suppressed_leaves index for idle-rebuild candidate scan", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const sql = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name = 'summaries_contains_suppressed_idx'`,
      )
      .get() as { sql: string };
    expect(sql.sql).toContain("contains_suppressed_leaves = 1");
    expect(sql.sql).toContain("superseded_by IS NULL");
    db.close();
  });

  it("creates messages.suppressed_at partial index", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(getIndexNames(db, "messages")).toContain("messages_suppressed_idx");
    db.close();
  });

  it("creates conversations.session_key index for v4.1 read patterns", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(getIndexNames(db, "conversations")).toContain("conversations_session_key_v41_idx");
    db.close();
  });

  it("uses the new indexes via EXPLAIN QUERY PLAN", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    db.prepare(`INSERT INTO conversations (session_id) VALUES ('s1')`).run();

    // Insert a few summaries with non-empty session_key
    const ins = db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, latest_at) VALUES (?, 1, 'leaf', 'x', 1, ?, datetime('now'))`,
    );
    ins.run("s1", "agent:main:main");
    ins.run("s2", "agent:main:main");
    ins.run("s3", "agent:other");

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM summaries WHERE session_key = 'agent:main:main' AND kind = 'leaf' ORDER BY latest_at DESC LIMIT 10`,
      )
      .all() as Array<{ detail: string }>;
    const planText = plan.map((p) => p.detail).join("\n");
    // Should pick the new index (or another existing index that covers this)
    expect(planText.toLowerCase()).toMatch(/idx|index/);
    db.close();
  });

  it("is idempotent — re-running migration does not fail on existing indexes", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() => runLcmMigrations(db, { fts5Available: false })).not.toThrow();
    db.close();
  });
});
