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

  it("deletes an existing daily rollup when a direct rebuild finds no sources", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "empty-direct-day",
      sessionKey: "agent:main:empty-direct-day",
      title: "Empty direct day",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_empty_direct",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Temporary direct day rollup content.",
      tokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
    ).toBeTruthy();

    db.prepare("DELETE FROM summaries WHERE summary_id = ?").run("sum_empty_direct");
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
    ).toBeNull();
  });

  it("deletes empty-day rollups during the daily sweep", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "empty-sweep-day",
        sessionKey: "agent:main:empty-sweep-day",
        title: "Empty sweep day",
      });

      await summaryStore.insertSummary({
        summaryId: "sum_empty_sweep",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Temporary sweep day rollup content.",
        tokenCount: 10,
        earliestAt: new Date("2026-04-27T10:00:00.000Z"),
        latestAt: new Date("2026-04-27T10:30:00.000Z"),
      });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, "2026-04-27");
      db.prepare("DELETE FROM summaries WHERE summary_id = ?").run("sum_empty_sweep");
      const result = await builder.buildDailyRollups(conversation.conversationId, {
        forceCurrentDay: true,
        daysBack: 2,
      });

      expect(result.built).toBeGreaterThan(0);
      expect(
        rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not move last_rollup_check_at backwards after sweep builds", async () => {
    const scanStart = new Date("2026-04-28T12:00:00.000Z");
    const buildTime = new Date("2026-04-28T12:00:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(scanStart);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "rollup-check-monotonic",
        sessionKey: "agent:main:rollup-check-monotonic",
        title: "Rollup check monotonic",
      });

      await summaryStore.insertSummary({
        summaryId: "sum_rollup_check_monotonic",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Completed a monotonic state update check.",
        tokenCount: 10,
        earliestAt: new Date("2026-04-27T10:00:00.000Z"),
        latestAt: new Date("2026-04-27T10:30:00.000Z"),
      });

      const originalGetLeafSummaries =
        rollupStore.getLeafSummariesForDay.bind(rollupStore);
      const lookupSpy = vi
        .spyOn(rollupStore, "getLeafSummariesForDay")
        .mockImplementation((...args) => {
          vi.setSystemTime(buildTime);
          return originalGetLeafSummaries(...args);
        });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await expect(
        builder.buildDailyRollups(conversation.conversationId, {
          forceCurrentDay: true,
          daysBack: 2,
        })
      ).resolves.toMatchObject({ built: 1, errors: [] });
      lookupSpy.mockRestore();

      const state = rollupStore.getState(conversation.conversationId);
      expect(state?.last_rollup_check_at).toBe(buildTime.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports final sweep-state write failures without aborting built rollups", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-final-state-error",
      sessionKey: "agent:main:rollup-final-state-error",
      title: "Rollup final state error",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_final_state_error",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Built work should survive a final state write failure.",
      tokenCount: 10,
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });

    const originalUpsertState = rollupStore.upsertState.bind(rollupStore);
    const upsertSpy = vi
      .spyOn(rollupStore, "upsertState")
      .mockImplementation((conversationId, input) => {
        if (input.pending_rebuild != null) {
          throw new Error("state write failed");
        }
        originalUpsertState(conversationId, input);
      });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    const result = await builder.buildDailyRollups(conversation.conversationId, {
      forceCurrentDay: true,
      daysBack: 2,
    });
    upsertSpy.mockRestore();

    expect(result.built).toBe(1);
    expect(result.errors).toEqual([
      "final sweep state update failed: state write failed",
    ]);
    expect(
      rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
    ).toBeTruthy();
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

    const hiddenRollupResult = await tool.execute("call-rollup-hidden", {
      period: "date:2026-04-27",
      includeSources: false,
    });
    const hiddenRollupText = (hiddenRollupResult.content[0] as { text: string }).text;
    expect(hiddenRollupText).toContain("*Sources: omitted*");
    expect((hiddenRollupResult.details as { summaryIds?: string[] }).summaryIds).toEqual([]);

    const fallbackResult = await tool.execute("call-fallback", {
      period: "date:2026-04-26",
      includeSources: true,
    });
    const fallbackText = (fallbackResult.content[0] as { text: string }).text;
    expect(fallbackText).toContain("Status:** fallback");
    expect(fallbackText).toContain("sum_recent_fallback");

    const hiddenFallbackResult = await tool.execute("call-fallback-hidden", {
      period: "date:2026-04-26",
      includeSources: false,
    });
    const hiddenFallbackText = (hiddenFallbackResult.content[0] as { text: string }).text;
    expect(hiddenFallbackText).toContain("*Sources: omitted*");
    expect((hiddenFallbackResult.details as { summaryIds?: string[] }).summaryIds).toEqual([]);

    const hiddenGlobalFallbackResult = await tool.execute("call-global-hidden", {
      period: "date:2026-04-26",
      allConversations: true,
      includeSources: false,
    });
    expect((hiddenGlobalFallbackResult.details as { summaryIds?: string[] }).summaryIds).toEqual([]);

    const invalidResult = await tool.execute("call-invalid", {
      period: "date:2026-02-31",
    });
    expect(invalidResult.details).toMatchObject({
      error:
        'Invalid date in period; expected a real calendar date in the form "date:YYYY-MM-DD".',
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

  it("caps multi-day rollup output before returning combined recaps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "recent-capped-window",
        sessionKey: "agent:main:recent-capped-window",
        title: "Recent capped window",
      });
      const days = [
        "2026-04-22",
        "2026-04-23",
        "2026-04-24",
        "2026-04-25",
        "2026-04-26",
        "2026-04-27",
        "2026-04-28",
      ];

      for (const day of days) {
        await summaryStore.insertSummary({
          summaryId: `sum_cap_${day}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Daily recap for ${day}.`,
          tokenCount: 10,
          latestAt: new Date(`${day}T10:00:00.000Z`),
        });
      }

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      for (const day of days) {
        await builder.buildDayRollup(conversation.conversationId, day);
        db.prepare(
          `UPDATE lcm_rollups
           SET content = ?,
               token_count = ?,
               source_summary_ids = ?
           WHERE conversation_id = ? AND period_kind = 'day' AND period_key = ?`,
        ).run(
          `Large rollup payload for ${day}.`,
          10_000,
          JSON.stringify([`sum_cap_${day}`]),
          conversation.conversationId,
          day,
        );
      }

      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: makeLcmForConversation({
          conversationId: conversation.conversationId,
          rollupStore,
        }) as never,
        sessionId: "recent-session",
      });

      const result = await tool.execute("call-capped", {
        period: "7d",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("5 earlier rollups omitted to fit budget");
      expect(text).not.toContain("Large rollup payload for 2026-04-22");
      expect(text).toContain("Large rollup payload for 2026-04-27");
      expect(text).toContain("Large rollup payload for 2026-04-28");
      expect((result.details as { tokenCount?: number }).tokenCount).toBeLessThanOrEqual(20_000);
      expect((result.details as { summaryIds?: string[] }).summaryIds).toEqual([
        "sum_cap_2026-04-27",
        "sum_cap_2026-04-28",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
