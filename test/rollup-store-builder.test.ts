import { describe, expect, it, vi } from "vitest";
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
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollups'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollup_sources'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollup_state'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'daily_rollups'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'weekly_rollups'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'monthly_rollups'"
        )
        .get()
    ).toBeTruthy();
  });

  it("builds a stable daily rollup and preserves rollup_id across rebuilds", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
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
      content:
        "Completed a safe fallback audit and found the old wildcard path.",
      tokenCount: 12,
      earliestAt: new Date("2026-04-27T12:00:00.000Z"),
      latestAt: new Date("2026-04-27T12:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    const first = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27",
      "UTC"
    );
    expect(first?.status).toBe("ready");
    expect(first?.content).toContain("Daily Summary: 2026-04-27");
    expect(first?.source_summary_ids).toBe(
      JSON.stringify(["sum_rollup_a", "sum_rollup_b"])
    );
    expect(first?.source_message_count).toBe(2);
    expect(first?.coverage_start).toBe("2026-04-27T10:00:00.000Z");
    expect(first?.coverage_end).toBe("2026-04-27T12:30:00.000Z");

    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    const second = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27"
    );
    expect(second?.rollup_id).toBe(first?.rollup_id);
    expect(
      rollupStore
        .getRollupSources(second!.rollup_id)
        .map((source) => source.source_id)
    ).toEqual(["sum_rollup_a", "sum_rollup_b"]);

    db.prepare(
      `UPDATE summaries
       SET content = ?
       WHERE summary_id = ?`
    ).run(
      "Decided to restore the daily rollup MVP with content-sensitive rebuilds.",
      "sum_rollup_a"
    );

    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    const rebuilt = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27"
    );
    expect(rebuilt?.rollup_id).toBe(first?.rollup_id);
    expect(rebuilt?.source_fingerprint).not.toBe(first?.source_fingerprint);
    expect(rebuilt?.content).toContain("content-sensitive rebuilds");
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

  it("builds daily rollups when local midnight is skipped by DST", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "midnight-gap-day",
      sessionKey: "agent:main:midnight-gap-day",
      title: "Midnight gap day",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_midnight_gap",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Captured work after a skipped local midnight.",
      tokenCount: 10,
      earliestAt: new Date("2026-04-23T22:30:00.000Z"),
      latestAt: new Date("2026-04-23T22:45:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, {
      timezone: "Africa/Cairo",
    });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-24")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(
        conversation.conversationId,
        "day",
        "2026-04-24",
        "Africa/Cairo"
      )?.content
    ).toContain("skipped local midnight");
  });

  it("checks for an existing rollup inside buildDayRollup before writing", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-toctou",
      sessionKey: "agent:main:rollup-toctou",
      title: "Rollup TOCTOU",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_rollup_txn",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Completed the transactional lookup hardening.",
      tokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    const spy = vi.spyOn(rollupStore, "getRollup");

    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);

    expect(spy).toHaveBeenCalledWith(
      conversation.conversationId,
      "day",
      "2026-04-27",
      "UTC"
    );
    expect(spy.mock.calls.length).toBe(1);
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

  it("uses the requested local date key for UTC+13 daily rebuilds", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-utc-plus",
      sessionKey: "agent:main:rollup-utc-plus",
      title: "Rollup UTC+13",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_rollup_auckland",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Completed the UTC+13 local-date preservation fix.",
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

    const rollup = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27"
    );
    expect(rollup?.period_start).toBe("2026-04-26T12:00:00.000Z");
    expect(rollup?.period_end).toBe("2026-04-27T12:00:00.000Z");
    expect(rollup?.content).toContain("UTC+13 local-date preservation");
  });
});

import {
  createLcmRecentTool,
  __lcmRecentTestInternals,
} from "../src/tools/lcm-recent-tool.js";
import type { LcmDependencies } from "../src/types.js";

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

describe("LCM sub-day window retrieval", () => {
  it("parses deterministic local-time windows with DST-safe UTC bounds", () => {
    const dateWindow = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-03-08 1:30-3:30",
      "America/New_York"
    );
    expect(dateWindow.label).toBe("2026-03-08 1:30-3:30");
    expect(dateWindow.window?.startMinutes).toBe(90);
    expect(dateWindow.window?.endMinutes).toBe(210);
    expect(dateWindow.start.toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(dateWindow.end.toISOString()).toBe("2026-03-08T07:30:00.000Z");

    const namedWindow = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-27 morning",
      "Asia/Bangkok"
    );
    expect(namedWindow.label).toBe("2026-04-27 morning");
    expect(namedWindow.start.toISOString()).toBe("2026-04-26T23:00:00.000Z");
    expect(namedWindow.end.toISOString()).toBe("2026-04-27T05:00:00.000Z");

    const meridiemWindow = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-27 4-8pm",
      "Asia/Bangkok"
    );
    expect(meridiemWindow.window?.startMinutes).toBe(16 * 60);
    expect(meridiemWindow.window?.endMinutes).toBe(20 * 60);

    expect(() =>
      __lcmRecentTestInternals.resolvePeriod(
        "date:2026-03-08 2:30-3:30",
        "America/New_York"
      )
    ).toThrow(/Nonexistent local time/);

    expect(() =>
      __lcmRecentTestInternals.resolvePeriod(
        "date:2026-02-31",
        "UTC"
      )
    ).toThrow(/real calendar date/);

    const nightWindow = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-27 night",
      "Pacific/Auckland"
    );
    expect(nightWindow.label).toBe("2026-04-27 night");
    expect(nightWindow.start.toISOString()).toBe("2026-04-27T10:00:00.000Z");
    expect(nightWindow.end.toISOString()).toBe("2026-04-27T12:00:00.000Z");

    const midnightTransition = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-03-28",
      "Asia/Gaza"
    );
    expect(midnightTransition.start.toISOString()).toBe(
      "2026-03-27T22:00:00.000Z"
    );

    const skippedMidnight = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-24",
      "Africa/Cairo"
    );
    expect(skippedMidnight.start.toISOString()).toBe(
      "2026-04-23T22:00:00.000Z"
    );

    const skippedMidnightNight = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-23 night",
      "Africa/Cairo"
    );
    expect(skippedMidnightNight.start.toISOString()).toBe(
      "2026-04-23T20:00:00.000Z"
    );
    expect(skippedMidnightNight.end.toISOString()).toBe(
      "2026-04-23T22:00:00.000Z"
    );

    const explicitEndOfDay = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-23 22:00-24:00",
      "Africa/Cairo"
    );
    expect(explicitEndOfDay.window?.endMinutes).toBe(24 * 60);
    expect(explicitEndOfDay.start.toISOString()).toBe(
      "2026-04-23T20:00:00.000Z"
    );
    expect(explicitEndOfDay.end.toISOString()).toBe(
      "2026-04-23T22:00:00.000Z"
    );
  });

  it("falls back to leaf summaries inside the requested sub-day window", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "window-retrieval",
      sessionKey: "agent:main:window-retrieval",
      title: "Window retrieval",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_before_window",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Morning setup before the interesting window.",
      tokenCount: 8,
      latestAt: new Date("2026-04-27T08:00:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_inside_window",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content:
        "Eric Wilder npm ENOTEMPTY repair happened in the afternoon window.",
      tokenCount: 12,
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_spanning_window",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Spanning summary began before the window but overlaps it.",
      tokenCount: 11,
      earliestAt: new Date("2026-04-27T09:50:00.000Z"),
      latestAt: new Date("2026-04-27T11:10:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_after_window",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Evening connector rollout after the requested window.",
      tokenCount: 9,
      latestAt: new Date("2026-04-27T13:00:00.000Z"),
    });

    const rollupStore = new RollupStore(db);
    const lcm = {
      timezone: "Asia/Bangkok",
      getRollupStore: () => rollupStore,
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "window-retrieval",
          title: null,
          bootstrappedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "window-retrieval",
    });

    const result = await tool.execute("call-window", {
      period: "date:2026-04-27 17:00-18:00",
      includeSources: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("sum_inside_window");
    expect(text).toContain("sum_spanning_window");
    expect(text).toContain("ENOTEMPTY repair");
    expect(text).not.toContain("sum_before_window");
    expect(text).not.toContain("sum_after_window");
    expect((result.details as { summaryIds?: string[] }).summaryIds).toEqual([
      "sum_spanning_window",
      "sum_inside_window",
    ]);
  });

  it("orders fallback rows by the displayed effective time", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "fallback-effective-order",
      sessionKey: "agent:main:fallback-effective-order",
      title: "Fallback effective order",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_late_effective",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Late effective fallback should appear first.",
      tokenCount: 8,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T11:55:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_early_effective",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Earlier effective fallback should appear second.",
      tokenCount: 8,
      earliestAt: new Date("2026-04-27T11:00:00.000Z"),
      latestAt: new Date("2026-04-27T11:05:00.000Z"),
    });

    const lcm = {
      timezone: "UTC",
      getRollupStore: () => rollupStore,
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "fallback-effective-order",
          title: null,
          bootstrappedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "fallback-effective-order",
    });

    const result = await tool.execute("call-effective-order", {
      period: "date:2026-04-27 10:00-12:00",
      includeSources: true,
    });

    expect((result.details as { summaryIds?: string[] }).summaryIds).toEqual([
      "sum_late_effective",
      "sum_early_effective",
    ]);
  });

  it("uses bounded fallback for today's window even when a rollup exists", async () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "today-freshness",
        sessionKey: "agent:main:today-freshness",
        title: "Today freshness",
      });
      const todayKey = now.toISOString().slice(0, 10);

      await summaryStore.insertSummary({
        summaryId: "sum_today_fresh",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Fresh same-day work should come from bounded fallback.",
        tokenCount: 8,
        latestAt: now,
      });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, todayKey);
      db.prepare(
        `UPDATE lcm_rollups
         SET content = ?
         WHERE conversation_id = ? AND period_kind = 'day' AND period_key = ?`
      ).run(
        "STALE CURRENT DAY ROLLUP SHOULD NOT BE USED",
        conversation.conversationId,
        todayKey
      );

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "today-freshness",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "today-freshness",
      });

      const result = await tool.execute("call-today", {
        period: "today",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Fresh same-day work");
      expect(text).not.toContain("STALE CURRENT DAY ROLLUP");
      expect(
        (result.details as { status?: string; usedFallback?: boolean }).status
      ).toBe("fallback");
      expect(
        (result.details as { status?: string; usedFallback?: boolean })
          .usedFallback
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("combines complete prior daily rollups with live fallback for 7d", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "seven-day-live",
        sessionKey: "agent:main:seven-day-live",
        title: "Seven day live",
      });
      const priorDays = [
        "2026-04-22",
        "2026-04-23",
        "2026-04-24",
        "2026-04-25",
        "2026-04-26",
        "2026-04-27",
      ];
      for (const day of priorDays) {
        await summaryStore.insertSummary({
          summaryId: `sum_${day}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Completed archived work for ${day}.`,
          tokenCount: 8,
          latestAt: new Date(`${day}T10:00:00.000Z`),
        });
      }
      await summaryStore.insertSummary({
        summaryId: "sum_today_live",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Fresh current-day work should use live fallback.",
        tokenCount: 8,
        latestAt: now,
      });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      for (const day of priorDays) {
        await builder.buildDayRollup(conversation.conversationId, day);
      }

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "seven-day-live",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "seven-day-live",
      });

      const result = await tool.execute("call-7d", {
        period: "7d",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Completed archived work for 2026-04-22");
      expect(text).toContain("Fresh current-day work should use live fallback");
      expect((result.details as { usedFallback?: boolean }).usedFallback).toBe(
        true
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats inactive days as covered when combining 7d rollups", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "seven-day-sparse",
        sessionKey: "agent:main:seven-day-sparse",
        title: "Seven day sparse",
      });

      for (let index = 0; index < 25; index += 1) {
        await summaryStore.insertSummary({
          summaryId: `sum_sparse_${index}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Sparse inactive-day item ${index}.`,
          tokenCount: 8,
          latestAt: new Date(`2026-04-22T10:${String(index).padStart(2, "0")}:00.000Z`),
        });
      }

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, "2026-04-22");

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "seven-day-sparse",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "seven-day-sparse",
      });

      const result = await tool.execute("call-7d-sparse", {
        period: "7d",
        includeSources: true,
      });
      const details = result.details as {
        status?: string;
        summaryIds?: string[];
      };
      expect(details.status).toBe("ready");
      expect(details.summaryIds).toHaveLength(25);
    } finally {
      vi.useRealTimers();
    }
  });
});
