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
      "2026-04-27"
    );
    expect(first?.status).toBe("ready");
    expect(first?.content).toContain("Daily Summary: 2026-04-27");
    expect(first?.source_summary_ids).toBe(
      JSON.stringify(["sum_rollup_a", "sum_rollup_b"])
    );

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

    const lcm = {
      timezone: "Asia/Bangkok",
      db,
      getRetrieval: () => ({
        grep: async () => ({}),
        expand: async () => ({}),
        describe: async () => ({}),
      }),
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
      "sum_inside_window",
      "sum_spanning_window",
    ]);
  });
});

describe("LCM weekly and monthly rollups", () => {
  it("builds aggregate week/month rollups from stable daily rollups", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "aggregate-rollups",
      sessionKey: "agent:main:aggregate-rollups",
      title: "Aggregate rollups",
    });

    for (const [summaryId, timestamp, content] of [
      ["sum_mon", "2026-04-27T10:00:00.000Z", "Monday decision completed."],
      ["sum_tue", "2026-04-28T10:00:00.000Z", "Tuesday rollout shipped."],
      ["sum_may", "2026-05-01T10:00:00.000Z", "May follow-up issue created."],
    ] as const) {
      await summaryStore.insertSummary({
        summaryId,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content,
        tokenCount: 10,
        earliestAt: new Date(timestamp),
        latestAt: new Date(timestamp),
      });
    }

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-28")
    ).resolves.toBe(true);
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-05-01")
    ).resolves.toBe(true);

    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    await expect(
      builder.buildMonthlyRollup(conversation.conversationId, "2026-04")
    ).resolves.toBe(true);

    const week = rollupStore.getRollup(
      conversation.conversationId,
      "week",
      "2026-04-27"
    );
    expect(week?.status).toBe("ready");
    expect(week?.content).toContain("Weekly Summary: 2026-04-27");
    expect(
      rollupStore
        .getRollupSources(week!.rollup_id)
        .map((source) => source.source_type)
    ).toEqual(["rollup", "rollup", "rollup"]);

    const month = rollupStore.getRollup(
      conversation.conversationId,
      "month",
      "2026-04"
    );
    expect(month?.status).toBe("ready");
    expect(month?.content).toContain("Monthly Summary: 2026-04");
    expect(rollupStore.getRollupSources(month!.rollup_id)).toHaveLength(2);

    const firstMonthId = month?.rollup_id;
    await expect(
      builder.buildMonthlyRollup(conversation.conversationId, "2026-04")
    ).resolves.toBe(false);
    expect(
      rollupStore.getRollup(conversation.conversationId, "month", "2026-04")
        ?.rollup_id
    ).toBe(firstMonthId);
  });
});
