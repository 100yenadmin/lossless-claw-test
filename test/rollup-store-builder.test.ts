import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { RollupBuilder } from "../src/rollup-builder.js";
import { RollupStore } from "../src/store/rollup-store.js";

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
    summaryStore: new SummaryStore(db, { fts5Available }),
    rollupStore: new RollupStore(db),
  };
}

describe("LCM temporal rollup MVP", () => {
  it("creates rollup schema and compatibility views", () => {
    const { db } = createStores();

    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollups'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollup_sources'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollup_state'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'daily_rollups'").get(),
    ).toBeTruthy();
  });

  it("builds a stable daily rollup and preserves rollup_id across rebuilds", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-stability",
      sessionKey: "agent:main:rollup-stability",
      title: "Rollup stability",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_rollup_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Decided to restore the daily rollup MVP.",
      tokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_rollup_b",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Completed a safe fallback audit and found the old wildcard path.",
      tokenCount: 12,
      earliestAt: new Date("2026-04-27T12:00:00.000Z"),
      latestAt: new Date("2026-04-27T12:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(builder.buildDayRollup(conversation.conversationId, "2026-04-27")).resolves.toBe(true);
    const first = rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27");
    expect(first?.status).toBe("ready");
    expect(first?.content).toContain("Daily Summary: 2026-04-27");
    expect(first?.source_summary_ids).toBe(JSON.stringify(["sum_rollup_a", "sum_rollup_b"]));

    await expect(builder.buildDayRollup(conversation.conversationId, "2026-04-27")).resolves.toBe(true);
    const second = rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27");
    expect(second?.rollup_id).toBe(first?.rollup_id);
    expect(rollupStore.getRollupSources(second!.rollup_id).map((source) => source.source_id)).toEqual([
      "sum_rollup_a",
      "sum_rollup_b",
    ]);
  });
});
