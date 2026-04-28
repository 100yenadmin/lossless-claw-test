import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { RollupBuilder } from "../src/rollup-builder.js";
import { RollupStore } from "../src/store/rollup-store.js";
import { createLcmRecentTool } from "../src/tools/lcm-recent-tool.js";
import type { LcmDependencies } from "../src/types.js";

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

function makeRecentDeps(): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      ignoreSessionPatterns: [],
      statelessSessionPatterns: [],
      skipStatelessSessions: true,
      contextThreshold: 0.75,
      freshTailCount: 8,
      newSessionRetainDepth: 2,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      proactiveThresholdCompactionMode: "deferred",
      summaryMaxOverageFactor: 3,
    },
    complete: async () => "",
    callGateway: async () => ({}),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey: () => null,
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "/tmp/openclaw-agent",
    resolveSessionIdFromSessionKey: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  } as LcmDependencies;
}

function makeLcmForConversation(params: {
  conversationId: number;
  rollupStore: RollupStore;
  timezone?: string;
}) {
  return {
    timezone: params.timezone ?? "UTC",
    getRollupStore: () => params.rollupStore,
    getConversationStore: () => ({
      getConversationBySessionId: async () => ({
        conversationId: params.conversationId,
        sessionId: "recent-session",
        title: null,
        bootstrappedAt: null,
        createdAt: new Date("2026-04-27T00:00:00.000Z"),
        updatedAt: new Date("2026-04-27T00:00:00.000Z"),
      }),
      getConversationBySessionKey: async () => null,
    }),
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
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'weekly_rollups'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'monthly_rollups'").get(),
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
    expect(second?.source_message_count).toBe(2);
    expect(rollupStore.getRollupSources(second!.rollup_id).map((source) => source.source_id)).toEqual([
      "sum_rollup_a",
      "sum_rollup_b",
    ]);
  });

  it("uses the requested local date key for UTC+13 daily rollups", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-utc-plus",
      sessionKey: "agent:main:rollup-utc-plus",
      title: "Rollup UTC plus",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_utc_plus",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Completed the UTC+13 daily boundary fix.",
      tokenCount: 10,
      earliestAt: new Date("2026-04-26T12:30:00.000Z"),
      latestAt: new Date("2026-04-26T13:00:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, {
      timezone: "Pacific/Auckland",
    });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(
        conversation.conversationId,
        "day",
        "2026-04-27",
        "Pacific/Auckland"
      )?.content
    ).toContain("UTC+13 daily boundary fix");
  });

  it("rejects impossible date keys", async () => {
    const { conversationStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-invalid-date",
      sessionKey: "agent:main:rollup-invalid-date",
      title: "Rollup invalid date",
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(builder.buildDayRollup(conversation.conversationId, "2026-02-31")).rejects.toThrow(
      "Invalid date key: 2026-02-31",
    );
  });

  it("updates stale daily rollups when source content changes with stable ids and tokens", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-fingerprint",
      sessionKey: "agent:main:rollup-fingerprint",
      title: "Rollup fingerprint",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_rollup_fingerprint",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Completed the first daily note.",
      tokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDailyRollups(conversation.conversationId, {
        daysBack: 2,
        forceCurrentDay: true,
      }),
    ).resolves.toMatchObject({ built: 1, errors: [] });
    const first = rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27");
    expect(first?.content).toContain("first daily note");

    db.prepare(
      `UPDATE summaries
       SET content = ?
       WHERE summary_id = ?`,
    ).run("Completed the revised daily note.", "sum_rollup_fingerprint");

    await expect(
      builder.buildDailyRollups(conversation.conversationId, {
        daysBack: 2,
        forceCurrentDay: true,
      }),
    ).resolves.toMatchObject({ built: 1, errors: [] });
    const second = rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27");
    expect(second?.rollup_id).toBe(first?.rollup_id);
    expect(second?.source_fingerprint).not.toBe(first?.source_fingerprint);
    expect(second?.content).toContain("revised daily note");
  });

  it("returns lcm_recent rollups, validates dates, and uses SQL fallback when needed", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "recent-daily",
      sessionKey: "agent:main:recent-daily",
      title: "Recent daily",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_recent_rollup",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Completed the daily rollup retrieval path.",
      tokenCount: 10,
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_recent_fallback",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Fallback found a mixed-format timestamp summary.",
      tokenCount: 12,
    });
    db.prepare(
      `UPDATE summaries
       SET created_at = '2026-04-26 10:00:00',
           earliest_at = NULL,
           latest_at = NULL
       WHERE summary_id = 'sum_recent_fallback'`,
    ).run();

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await builder.buildDayRollup(conversation.conversationId, "2026-04-27");

    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: makeLcmForConversation({
        conversationId: conversation.conversationId,
        rollupStore,
      }) as never,
      sessionId: "recent-session",
    });

    const rollupResult = await tool.execute("call-rollup", {
      period: "date:2026-04-27",
      includeSources: true,
    });
    const rollupText = (rollupResult.content[0] as { text: string }).text;
    expect(rollupText).toContain("Status:** ready");
    expect(rollupText).toContain("sum_recent_rollup");

    const fallbackResult = await tool.execute("call-fallback", {
      period: "date:2026-04-26",
      includeSources: true,
    });
    const fallbackText = (fallbackResult.content[0] as { text: string }).text;
    expect(fallbackText).toContain("Status:** fallback");
    expect(fallbackText).toContain("sum_recent_fallback");

    const invalidResult = await tool.execute("call-invalid", {
      period: "date:2026-02-31",
    });
    expect(invalidResult.details).toMatchObject({
      error: 'period date must be in the form "date:YYYY-MM-DD".',
    });
  });

  it("falls back instead of serving partial multi-day rollup windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "recent-partial-window",
        sessionKey: "agent:main:recent-partial-window",
        title: "Recent partial window",
      });

      await summaryStore.insertSummary({
        summaryId: "sum_partial_rollup",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Only one day in the seven day window has a rollup.",
        tokenCount: 10,
        latestAt: new Date("2026-04-27T10:00:00.000Z"),
      });
      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, "2026-04-27");

      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: makeLcmForConversation({
          conversationId: conversation.conversationId,
          rollupStore,
        }) as never,
        sessionId: "recent-session",
      });

      const result = await tool.execute("call-partial", {
        period: "7d",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Status:** fallback");
      expect((result.details as { usedFallback?: boolean }).usedFallback).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
