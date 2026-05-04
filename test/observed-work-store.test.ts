import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ObservedWorkExtractor } from "../src/observed-work-extractor.js";
import { EventObservationStore } from "../src/store/event-observation-store.js";
import { ObservedWorkStore } from "../src/store/observed-work-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmEventSearchTool } from "../src/tools/lcm-event-search-tool.js";
import { createLcmWorkDensityTool } from "../src/tools/lcm-work-density-tool.js";
import type { LcmDependencies } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

function createConversation(db: DatabaseSync, conversationId: number): void {
  db.prepare(
    `INSERT INTO conversations (conversation_id, session_id, session_key, title)
     VALUES (?, ?, ?, ?)`
  ).run(
    conversationId,
    `observed-work-${conversationId}`,
    `agent:main:observed-work-${conversationId}`,
    `Observed work ${conversationId}`
  );
}

async function insertLeafSummary(input: {
  db: DatabaseSync;
  summaryStore: SummaryStore;
  summaryId: string;
  conversationId: number;
  content: string;
  createdAt: string;
}): Promise<void> {
  await input.summaryStore.insertSummary({
    summaryId: input.summaryId,
    conversationId: input.conversationId,
    kind: "leaf",
    depth: 0,
    content: input.content,
    tokenCount: 50,
    sourceMessageTokenCount: 80,
    latestAt: new Date(input.createdAt),
  });
  input.db.prepare(`UPDATE summaries SET created_at = ? WHERE summary_id = ?`)
    .run(input.createdAt, input.summaryId);
}

describe("ObservedWorkStore", () => {
  it("creates observed work tables during migration", () => {
    const db = makeDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lcm_observed_work_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "lcm_observed_work_items",
      "lcm_observed_work_sources",
      "lcm_observed_work_state",
    ]);
  });

  it("extracts leaf-summary work with a rowid cursor so same-second summaries are not skipped", async () => {
    const db = makeDb();
    createConversation(db, 7);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);
    const pointLookupSpy = vi.spyOn(observedWork, "getItem");

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 7,
      summaryId: "sum_z_first",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #540 still has unresolved review comments",
    });
    await expect(extractor.processConversation(7)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 7,
      summaryId: "sum_a_later",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #541 still has failing CI",
    });
    await expect(extractor.processConversation(7)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 7,
      statuses: ["observed_unfinished"],
      limit: 10,
    });
    expect(density.density.unfinished).toBe(2);
    expect(density.topUnfinished.map((item) => item.topicKey).sort()).toEqual([
      "pr-540",
      "pr-541",
    ]);
    const state = observedWork.getState(7);
    expect(state?.lastProcessedSummaryId).toBe("sum_a_later");
    expect(state?.lastProcessedSummaryRowid).toBeGreaterThan(0);
    expect(pointLookupSpy).not.toHaveBeenCalled();
  });

  it("does not inflate evidence when a retry reprocesses the same summary source", async () => {
    const db = makeDb();
    createConversation(db, 12);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 12,
      summaryId: "sum_retry_same_source",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #552 still has a failing extractor retry test",
    });
    await expect(extractor.processConversation(12)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    db.prepare(`DELETE FROM lcm_observed_work_state WHERE conversation_id = ?`).run(12);
    await expect(extractor.processConversation(12)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 12,
      statuses: ["observed_unfinished"],
      includeSources: true,
      limit: 10,
    });
    expect(density.topUnfinished).toHaveLength(1);
    expect(density.topUnfinished[0]?.evidenceCount).toBe(1);
    expect(density.topUnfinished[0]?.sources).toEqual([
      expect.objectContaining({
        sourceType: "summary",
        sourceId: "sum_retry_same_source",
        evidenceKind: "created",
      }),
    ]);
  });

  it("rolls back partial summary extraction writes before retry", async () => {
    const db = makeDb();
    createConversation(db, 13);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 13,
      summaryId: "sum_partial_retry",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #553 still has partial write retry risk",
    });

    const addSourceSpy = vi.spyOn(observedWork, "addSource");
    addSourceSpy.mockImplementationOnce(() => {
      throw new Error("simulated source write failure");
    });
    await expect(extractor.processConversation(13)).rejects.toThrow(/simulated source/);
    addSourceSpy.mockRestore();

    expect(
      observedWork.getDensity({
        conversationId: 13,
        statuses: ["observed_unfinished"],
      }).density.totalObserved
    ).toBe(0);
    expect(observedWork.getState(13)).toBeNull();

    await expect(extractor.processConversation(13)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    const density = observedWork.getDensity({
      conversationId: 13,
      statuses: ["observed_unfinished"],
      includeSources: true,
    });
    expect(density.topUnfinished).toHaveLength(1);
    expect(density.topUnfinished[0]?.evidenceCount).toBe(1);
    expect(density.topUnfinished[0]?.sources).toHaveLength(1);
  });

  it("derives the rowid cursor from the processed summary id after rowid drift", async () => {
    const db = makeDb();
    createConversation(db, 11);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 11,
      summaryId: "sum_cursor_anchor",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #550 needs review",
    });
    await expect(extractor.processConversation(11)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    observedWork.upsertState({
      conversationId: 11,
      lastProcessedSummaryCreatedAt: "2026-04-28T05:00:00.000Z",
      lastProcessedSummaryId: "sum_cursor_anchor",
      lastProcessedSummaryRowid: 9999,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 11,
      summaryId: "sum_cursor_later",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #551 needs review",
    });
    await expect(extractor.processConversation(11)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    const density = observedWork.getDensity({
      conversationId: 11,
      statuses: ["observed_unfinished"],
      limit: 10,
    });
    expect(density.topUnfinished.map((item) => item.topicKey).sort()).toEqual([
      "pr-550",
      "pr-551",
    ]);
  });

  it("falls back to the persisted rowid cursor when the processed summary id is missing", async () => {
    const db = makeDb();
    createConversation(db, 16);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 16,
      summaryId: "sum_cursor_deleted_anchor",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #560 needs review",
    });
    await expect(extractor.processConversation(16)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    const state = observedWork.getState(16);
    expect(state?.lastProcessedSummaryRowid).toBeGreaterThan(0);
    observedWork.upsertState({
      conversationId: 16,
      lastProcessedSummaryId: "zz_missing_anchor",
      lastProcessedSummaryCreatedAt: state?.lastProcessedSummaryCreatedAt,
      lastProcessedSummaryRowid: state?.lastProcessedSummaryRowid,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 16,
      summaryId: "aaa_cursor_later",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #561 needs review",
    });
    await expect(extractor.processConversation(16)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 16,
      statuses: ["observed_unfinished"],
      limit: 10,
    });
    expect(density.topUnfinished.map((item) => item.topicKey).sort()).toEqual([
      "pr-560",
      "pr-561",
    ]);
  });

  it("chunks dense summary lookups so extraction stays under SQLite bind limits", async () => {
    const db = makeDb();
    createConversation(db, 18);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);
    const content = Array.from(
      { length: 1100 },
      (_, index) => `- Blocker: PR #${7000 + index} needs review`
    ).join("\n");

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 18,
      summaryId: "sum_dense_bind_limit",
      createdAt: "2026-04-28T05:00:00.000Z",
      content,
    });

    await expect(extractor.processConversation(18, { limit: 1 })).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1100,
    });
    expect(
      observedWork.getDensity({
        conversationId: 18,
        statuses: ["observed_unfinished"],
      }).density.unfinished
    ).toBe(1100);
  });

  it("preserves semantic evidence kinds when reinforcing extracted work", async () => {
    const db = makeDb();
    createConversation(db, 9);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 9,
      summaryId: "sum_completed_first",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Completed: PR #542 tests passed",
    });
    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 9,
      summaryId: "sum_completed_later",
      createdAt: "2026-04-28T06:00:00.000Z",
      content: "- Completed: PR #542 tests passed",
    });

    await expect(extractor.processConversation(9)).resolves.toMatchObject({
      summariesScanned: 2,
      workItemsUpserted: 2,
    });

    const density = observedWork.getDensity({
      conversationId: 9,
      includeSources: true,
    });
    expect(density.completedHighlights[0]?.sources).toEqual([
      expect.objectContaining({
        sourceId: "sum_completed_first",
        evidenceKind: "completed",
      }),
      expect.objectContaining({
        sourceId: "sum_completed_later",
        evidenceKind: "completed",
      }),
    ]);
  });

  it("records deterministic event observations and hides sources unless requested", async () => {
    const db = makeDb();
    createConversation(db, 8);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const events = new EventObservationStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork, events);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 8,
      summaryId: "sum_incident",
      createdAt: "2026-04-28T06:00:00.000Z",
      content: [
        "- Incident: ENOTEMPTY failed during package cleanup",
        "- Retell: recalled the older Tarzan onboarding incident",
        "- Cortex config drift caused plugin validation failure",
      ].join("\n"),
    });
    await expect(extractor.processConversation(8)).resolves.toMatchObject({
      summariesScanned: 1,
      eventsUpserted: 3,
    });
    expect(
      events.listObservations({
        conversationId: 8,
        eventKinds: ["operational_incident"],
        query: "cortex config drift",
      })[0]?.eventKind
    ).toBe("operational_incident");
    await events.upsertObservation({
      eventId: "evt_pr_normalized",
      conversationId: 8,
      eventKind: "primary",
      title: "Normalized event key",
      queryKey: "PR #123",
      ingestTime: "2026-04-28T07:00:00.000Z",
      confidence: 0.8,
      rationale: "Direct store caller uses human PR spelling.",
      sourceType: "summary",
      sourceId: "sum_incident",
    });
    expect(
      events.listObservations({ conversationId: 8, query: "pr-123" })[0]
        ?.eventId
    ).toBe("evt_pr_normalized");
    expect(
      events.listObservations({ conversationId: 8, query: "PR 123" })[0]
        ?.eventId
    ).toBe("evt_pr_normalized");
    expect(
      events.listObservations({
        conversationId: 8,
        query: "https://github.com/Martian-Engineering/lossless-claw/pull/123",
      })[0]?.eventId
    ).toBe("evt_pr_normalized");
    await expect(
      events.upsertObservation({
        eventId: "evt_missing_source",
        conversationId: 8,
        eventKind: "primary",
        title: "Missing source event",
        ingestTime: "2026-04-28T07:00:00.000Z",
        confidence: 0.8,
        rationale: "Direct store caller omitted the primary source.",
        sourceType: "summary",
        sourceId: " ",
      }),
    ).rejects.toThrow(/source ID/);

    const lcm = {
      getEventObservationStore: () => events,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
    } as unknown as LcmDependencies;
    const tool = createLcmEventSearchTool({
      deps,
      lcm: lcm as never,
      sessionId: "event-session",
    });

    const hidden = await tool.execute("event-hidden", {
      conversationId: 8,
      query: "enotempty",
    });
    expect((hidden.details as { accounting: { eventsIncluded: number } }).accounting.eventsIncluded).toBe(1);
    expect(JSON.stringify(hidden.details)).not.toContain("sum_incident");

    const shown = await tool.execute("event-shown", {
      conversationId: 8,
      query: "tarzan",
      includeSources: true,
    });
    expect(JSON.stringify(shown.details)).toContain("sum_incident");
    expect(JSON.stringify(shown.details)).toContain("retelling");

    const global = await tool.execute("event-global", {
      allConversations: true,
      query: "enotempty",
    });
    expect((global.details as { error?: string }).error).toMatch(
      /does not support allConversations/
    );
  });

  it("uses neutral evidence for ambiguous work without a completion cue", async () => {
    const db = makeDb();
    createConversation(db, 17);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 17,
      summaryId: "sum_ambiguous_investigate",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Investigate PR #562 review behavior before calling it complete",
    });
    await expect(extractor.processConversation(17)).resolves.toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 17,
      statuses: ["observed_ambiguous"],
      includeSources: true,
      limit: 10,
    });
    expect(density.ambiguous[0]?.sources).toEqual([
      expect.objectContaining({
        sourceId: "sum_ambiguous_investigate",
        evidenceKind: "created",
      }),
    ]);
  });

  it("treats negated completion cues as unfinished, not completed", async () => {
    const db = makeDb();
    createConversation(db, 22);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 22,
      summaryId: "sum_neg_a",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- PR #777 not completed yet",
    });
    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 22,
      summaryId: "sum_neg_b",
      createdAt: "2026-04-28T05:01:00.000Z",
      content: "- Never shipped the rollout for issue #888",
    });
    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 22,
      summaryId: "sum_neg_c",
      createdAt: "2026-04-28T05:02:00.000Z",
      content: "- Cannot fix this regression on the auth path",
    });
    await expect(extractor.processConversation(22)).resolves.toMatchObject({
      summariesScanned: 3,
      workItemsUpserted: 3,
    });

    const density = observedWork.getDensity({
      conversationId: 22,
      statuses: ["observed_unfinished"],
      limit: 10,
    });
    expect(density.density.unfinished).toBe(3);
    // None of these lines should have minted observed_completed work items.
    const completed = observedWork.getDensity({
      conversationId: 22,
      statuses: ["observed_completed"],
      limit: 10,
    });
    expect(completed.density.completed).toBe(0);
  });

  it("reports completed, unfinished, and ambiguous work density", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    const base = {
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      confidence: 0.9,
      confidenceBand: "high" as const,
    };

    store.upsertItem({
      ...base,
      workItemId: "work_done",
      title: "Daily rollup tests passed",
      observedStatus: "observed_completed",
      kind: "test",
      fingerprint: "test:daily-rollup",
      completedAt: "2026-04-28T01:00:00.000Z",
      rationale: "Observed passing test output.",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_open",
      title: "Fix PR #14 review comments",
      observedStatus: "observed_unfinished",
      kind: "review",
      fingerprint: "review:pr14",
      rationale: "Review still requested changes.",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_maybe",
      title: "Decide task bridge policy",
      observedStatus: "observed_ambiguous",
      kind: "decision",
      fingerprint: "decision:task-bridge-policy",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_decision",
      title: "Decision recorded for advisory labels",
      observedStatus: "decision_recorded",
      kind: "decision",
      fingerprint: "decision:advisory-labels",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_dismissed",
      title: "Dismiss noisy follow-up",
      observedStatus: "dismissed",
      kind: "follow_up",
      fingerprint: "follow_up:dismissed-noise",
    });
    for (const [index, workItemId] of [
      "work_done",
      "work_open",
      "work_maybe",
      "work_decision",
      "work_dismissed",
    ].entries()) {
      store.addSource({
        workItemId,
        sourceType: "summary",
        sourceId: `sum_density_${index}`,
        ordinal: index,
        evidenceKind: "created",
      });
    }

    const density = store.getDensity({ conversationId: 1, limit: 5 });
    expect(density.density).toMatchObject({
      totalObserved: 5,
      completed: 1,
      unfinished: 1,
      ambiguous: 1,
      dismissed: 1,
      decisionRecorded: 1,
    });
    expect(density.topUnfinished[0]?.title).toBe("Fix PR #14 review comments");
    expect(density.completedHighlights[0]?.title).toBe("Daily rollup tests passed");
    expect(density.ambiguous[0]?.title).toBe("Decide task bridge policy");
    expect(density.decisions[0]?.title).toBe("Decision recorded for advisory labels");
    expect(density.dismissedItems[0]?.title).toBe("Dismiss noisy follow-up");

    const decisionOnly = store.getDensity({
      conversationId: 1,
      statuses: ["decision_recorded"],
      limit: 5,
    });
    expect(decisionOnly.density.totalObserved).toBe(1);
    expect(decisionOnly.decisions[0]?.workItemId).toBe("work_decision");
    expect(decisionOnly.itemsIncluded).toBe(1);
  });

  it("does not surface source-free observed work in density results", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    const base = {
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      observedStatus: "observed_unfinished" as const,
      kind: "review" as const,
    };

    store.upsertItem({
      ...base,
      workItemId: "work_sourced",
      title: "Sourced observed item",
      fingerprint: "review:sourced",
    });
    store.addSource({
      workItemId: "work_sourced",
      sourceType: "summary",
      sourceId: "sum_sourced",
      ordinal: 0,
      evidenceKind: "created",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_unsourced",
      title: "Unsourced observed item",
      fingerprint: "review:unsourced",
    });

    const density = store.getDensity({ conversationId: 1, includeSources: true });
    expect(density.density.totalObserved).toBe(1);
    expect(density.topUnfinished.map((item) => item.workItemId)).toEqual([
      "work_sourced",
    ]);
    expect(JSON.stringify(density)).not.toContain("work_unsourced");
  });

  it("preserves temporal invariants while updating mutable metadata", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    store.upsertItem({
      workItemId: "work_temporal",
      conversationId: 1,
      ownerId: "agent:main",
      description: "Initial description",
      firstSeenAt: "2026-04-28T05:00:00.000Z",
      lastSeenAt: "2026-04-28T06:00:00.000Z",
      completedAt: "2026-04-28T06:00:00.000Z",
      completionConfidence: 0.72,
      title: "Temporal invariant test",
      observedStatus: "observed_completed",
      kind: "test",
      fingerprint: "test:temporal-invariant",
    });
    store.upsertItem({
      workItemId: "work_temporal",
      conversationId: 1,
      ownerId: "agent:reviewer",
      description: "Updated description",
      firstSeenAt: "2026-04-28T04:00:00.000Z",
      lastSeenAt: "2026-04-28T05:30:00.000Z",
      completedAt: "2026-04-28T05:30:00.000Z",
      completionConfidence: 0.91,
      title: "Temporal invariant test updated",
      observedStatus: "observed_completed",
      kind: "test",
      fingerprint: "test:temporal-invariant",
    });

    const row = db
      .prepare(
        `SELECT owner_id, description, title, first_seen_at, last_seen_at, completed_at, completion_confidence
         FROM lcm_observed_work_items
         WHERE work_item_id = ?`,
      )
      .get("work_temporal") as {
      owner_id: string;
      description: string;
      title: string;
      first_seen_at: string;
      last_seen_at: string;
      completed_at: string;
      completion_confidence: number;
    };
    expect(row).toMatchObject({
      owner_id: "agent:reviewer",
      description: "Updated description",
      title: "Temporal invariant test updated",
      first_seen_at: "2026-04-28T04:00:00.000Z",
      last_seen_at: "2026-04-28T06:00:00.000Z",
      completed_at: "2026-04-28T05:30:00.000Z",
      completion_confidence: 0.91,
    });
  });

  it("hides sources by default and includes them only when requested", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    store.upsertItem({
      workItemId: "work_with_sources",
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      title: "Review source visibility",
      observedStatus: "observed_unfinished",
      kind: "review",
      fingerprint: "review:sources",
    });
    store.addSource({
      workItemId: "work_with_sources",
      sourceType: "summary",
      sourceId: "sum_hidden",
      ordinal: 0,
      evidenceKind: "created",
    });

    const hidden = store.getDensity({ conversationId: 1 });
    expect(hidden.topUnfinished[0]?.sources).toBeUndefined();

    const shown = store.getDensity({ conversationId: 1, includeSources: true });
    expect(shown.topUnfinished[0]?.sources).toEqual([
      {
        sourceType: "summary",
        sourceId: "sum_hidden",
        ordinal: 0,
        evidenceKind: "created",
      },
    ]);

    store.addSource({
      workItemId: "work_with_sources",
      sourceType: "summary",
      sourceId: "sum_hidden",
      ordinal: 5,
      evidenceKind: "created",
    });
    const reordered = store.getDensity({ conversationId: 1, includeSources: true });
    expect(reordered.topUnfinished[0]?.sources?.[0]?.ordinal).toBe(5);
  });

  it("bounds density detail rows and only loads sources for included items", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    for (const index of [1, 2, 3]) {
      store.upsertItem({
        workItemId: `work_limited_${index}`,
        conversationId: 1,
        firstSeenAt: `2026-04-28T0${index}:00:00.000Z`,
        lastSeenAt: `2026-04-28T0${index}:30:00.000Z`,
        title: `Limited unfinished ${index}`,
        observedStatus: "observed_unfinished",
        kind: "review",
        fingerprint: `review:limited:${index}`,
      });
      store.addSource({
        workItemId: `work_limited_${index}`,
        sourceType: "summary",
        sourceId: `sum_limited_${index}`,
        ordinal: index,
        evidenceKind: "created",
      });
    }
    for (let index = 4; index <= 30; index += 1) {
      store.addSource({
        workItemId: "work_limited_3",
        sourceType: "summary",
        sourceId: `sum_limited_extra_${index}`,
        ordinal: index,
        evidenceKind: "reinforced",
      });
    }

    const density = store.getDensity({
      conversationId: 1,
      includeSources: true,
      limit: 1,
    });
    expect(density.density.unfinished).toBe(3);
    expect(density.topUnfinished).toHaveLength(1);
    expect(density.itemsOmitted).toBe(2);
    expect(JSON.stringify(density)).toContain("sum_limited_3");
    expect(density.topUnfinished[0]?.sources).toHaveLength(20);
    expect(density.topUnfinished[0]?.sources?.map((source) => source.sourceId)).not.toContain(
      "sum_limited_extra_30",
    );
    expect(JSON.stringify(density)).not.toContain("sum_limited_1");
    expect(JSON.stringify(density)).not.toContain("sum_limited_2");
  });

  it("tracks incremental processing state", () => {
    const db = makeDb();
    createConversation(db, 42);
    const store = new ObservedWorkStore(db);
    store.upsertState({
      conversationId: 42,
      lastProcessedSummaryCreatedAt: "2026-04-28T02:00:00.000Z",
      lastProcessedSummaryId: "sum_123",
      lastProcessedSummaryRowid: 1,
      pendingRebuild: true,
    });
    const row = db
      .prepare(`SELECT * FROM lcm_observed_work_state WHERE conversation_id = ?`)
      .get(42) as { last_processed_summary_id: string; pending_rebuild: number };
    expect(row.last_processed_summary_id).toBe("sum_123");
    expect(row.pending_rebuild).toBe(1);

    // All three cursor fields advance together — this is the only legal way
    // to update a checkpoint. Partial updates are rejected by upsertState.
    store.upsertState({
      conversationId: 42,
      lastProcessedSummaryCreatedAt: "2026-04-28T02:30:00.000Z",
      lastProcessedSummaryId: "sum_456",
      lastProcessedSummaryRowid: 2,
    });
    const updated = db
      .prepare(`SELECT * FROM lcm_observed_work_state WHERE conversation_id = ?`)
      .get(42) as { last_processed_summary_id: string; pending_rebuild: number };
    expect(updated.last_processed_summary_id).toBe("sum_456");
    expect(updated.pending_rebuild).toBe(1);
  });

  it("rejects partial processed-summary cursor updates", () => {
    const db = makeDb();
    createConversation(db, 99);
    const store = new ObservedWorkStore(db);
    expect(() =>
      store.upsertState({
        conversationId: 99,
        lastProcessedSummaryId: "sum_only_id",
      }),
    ).toThrow(/must all be provided together/);
    expect(() =>
      store.upsertState({
        conversationId: 99,
        lastProcessedSummaryId: "sum_id",
        lastProcessedSummaryRowid: 5,
        // missing lastProcessedSummaryCreatedAt
      }),
    ).toThrow(/must all be provided together/);
    // Toggling pendingRebuild alone is still legal — no cursor fields supplied.
    store.upsertState({ conversationId: 99, pendingRebuild: true });
    const row = db
      .prepare(`SELECT pending_rebuild FROM lcm_observed_work_state WHERE conversation_id = ?`)
      .get(99) as { pending_rebuild: number };
    expect(row.pending_rebuild).toBe(1);
  });

  it("serves lcm_work_density with deterministic period filtering and source redaction", async () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    store.upsertItem({
      workItemId: "work_today",
      conversationId: 1,
      firstSeenAt: "2026-04-28T01:00:00.000Z",
      lastSeenAt: "2026-04-28T02:00:00.000Z",
      title: "Finish work density tests",
      observedStatus: "observed_completed",
      kind: "test",
      fingerprint: "test:work-density",
    });
    store.upsertItem({
      workItemId: "work_yesterday",
      conversationId: 1,
      firstSeenAt: "2026-04-27T01:00:00.000Z",
      lastSeenAt: "2026-04-27T02:00:00.000Z",
      title: "Older unfinished item",
      observedStatus: "observed_unfinished",
      kind: "review",
      fingerprint: "review:old",
    });
    store.addSource({
      workItemId: "work_today",
      sourceType: "summary",
      sourceId: "sum_today",
      ordinal: 0,
      evidenceKind: "completed",
    });
    store.addSource({
      workItemId: "work_yesterday",
      sourceType: "summary",
      sourceId: "sum_yesterday",
      ordinal: 0,
      evidenceKind: "created",
    });

    const lcm = {
      timezone: "UTC",
      getObservedWorkStore: () => store,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const now = new Date("2026-04-28T12:00:00.000Z");
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
      // Inject the deterministic clock the tool now reads through —
      // resolvePeriodBounds("today"/"week"/...) routes wall-clock reads
      // through deps.clock.now() so tests stay frozen.
      clock: { now: () => now },
    } as unknown as LcmDependencies;
    const tool = createLcmWorkDensityTool({
      deps,
      lcm: lcm as never,
      sessionId: "density-session",
    });

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const hidden = await tool.execute("density-hidden", {
        conversationId: 1,
        period: "today",
      });
      expect((hidden.details as { density: { totalObserved: number } }).density.totalObserved).toBe(1);
      expect(JSON.stringify(hidden.details)).not.toContain("sum_today");

      const shown = await tool.execute("density-shown", {
        conversationId: 1,
        period: "today",
        includeSources: true,
      });
      expect(JSON.stringify(shown.details)).toContain("sum_today");
      expect((shown.details as { period?: string }).period).toBe("today");

      const dateWithWhitespace = await tool.execute("density-date-trimmed", {
        conversationId: 1,
        period: "date: 2026-04-28 ",
        detailLevel: 0,
      });
      expect(
        (dateWithWhitespace.details as { density: { totalObserved: number } })
          .density.totalObserved,
      ).toBe(1);

      const week = await tool.execute("density-week", {
        conversationId: 1,
        period: "week",
        detailLevel: 0,
      });
      expect((week.details as { density: { totalObserved: number }; window?: { since?: string; before?: string } }).density.totalObserved).toBe(2);
      expect((week.details as { window?: { since?: string; before?: string } }).window).toMatchObject({
        since: "2026-04-27T00:00:00.000Z",
        before: "2026-05-04T00:00:00.000Z",
      });

      const sinceOverride = await tool.execute("density-since-override", {
        conversationId: 1,
        period: "week",
        since: "2026-04-28T00:00:00.000Z",
        detailLevel: 0,
      });
      expect((sinceOverride.details as { density: { totalObserved: number } }).density.totalObserved).toBe(1);

      const invalid = await tool.execute("density-invalid-period", {
        conversationId: 1,
        period: "quarter",
      });
      expect((invalid.details as { error?: string }).error).toContain("period must be one of");

      const global = await tool.execute("density-global", {
        allConversations: true,
      });
      expect((global.details as { error?: string }).error).toMatch(
        /does not support allConversations/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("trims rich lcm_work_density sections to the requested output budget", async () => {
    const db = makeDb();
    createConversation(db, 9);
    const store = new ObservedWorkStore(db);
    for (let index = 0; index < 20; index += 1) {
      const workItemId = `work_budget_${index}`;
      store.upsertItem({
        workItemId,
        conversationId: 9,
        firstSeenAt: "2026-04-28T01:00:00.000Z",
        lastSeenAt: `2026-04-28T01:${String(index).padStart(2, "0")}:00.000Z`,
        title: `Budget-sensitive unfinished item ${index} with a deliberately verbose title for trimming`,
        observedStatus: "observed_unfinished",
        kind: "review",
        rationale: "Verbose evidence rationale that should be removable by output-budget trimming.",
        fingerprint: `review:budget:${index}`,
      });
      for (let sourceIndex = 0; sourceIndex < 5; sourceIndex += 1) {
        store.addSource({
          workItemId,
          sourceType: "summary",
          sourceId: `sum_budget_${index}_${sourceIndex}`,
          ordinal: sourceIndex,
          evidenceKind: "created",
        });
      }
    }
    const lcm = {
      timezone: "UTC",
      getObservedWorkStore: () => store,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
      // The tool reads wall-clock through deps.clock.now() — supply a frozen
      // clock even though this test doesn't pass a `period` (defensive: tool
      // resolves the clock once per execute() regardless).
      clock: { now: () => new Date("2026-04-28T12:00:00.000Z") },
    } as unknown as LcmDependencies;
    const tool = createLcmWorkDensityTool({
      deps,
      lcm: lcm as never,
      sessionId: "density-session",
    });

    const result = await tool.execute("density-budget", {
      conversationId: 9,
      includeSources: true,
      limit: 20,
      maxOutputTokens: 256,
    });
    const details = result.details as {
      topUnfinished?: unknown[];
      accounting: {
        budgetTruncated?: boolean;
        itemsReturned?: number;
        estimatedOutputTokens?: number;
      };
    };
    expect(details.accounting.budgetTruncated).toBe(true);
    expect(details.accounting.itemsReturned).toBeLessThan(20);
    expect(details.accounting.estimatedOutputTokens).toBeLessThanOrEqual(256);
    // Whole items dropped by trimOneItem must be reflected in itemsOmitted —
    // callers must not be told "0 omitted" when most rows were forced out by
    // the budget. accounting is widened to include itemsOmitted at runtime.
    const omitted = (details.accounting as Record<string, unknown>).itemsOmitted;
    expect(typeof omitted).toBe("number");
    expect(omitted as number).toBeGreaterThan(0);
  });

  it("canonicalizes event timestamps and rejects unparseable values", async () => {
    const db = makeDb();
    createConversation(db, 71);
    const store = new EventObservationStore(db);
    await store.upsertObservation({
      eventId: "ev_canon_a",
      conversationId: 71,
      eventKind: "primary",
      title: "Canonical event",
      // Non-canonical (no fractional seconds, no Z suffix expected by lex sort).
      eventTime: "2026-04-28T05:00:00+00:00",
      ingestTime: "2026-04-28T05:00:01+00:00",
      rationale: "canonical",
      sourceType: "summary",
      sourceId: "sum_canon_a",
    });
    const row = db
      .prepare(
        `SELECT event_time, ingest_time FROM lcm_event_observations WHERE event_id = ?`,
      )
      .get("ev_canon_a") as { event_time: string; ingest_time: string };
    expect(row.event_time).toBe("2026-04-28T05:00:00.000Z");
    expect(row.ingest_time).toBe("2026-04-28T05:00:01.000Z");

    await expect(
      store.upsertObservation({
        eventId: "ev_canon_bad",
        conversationId: 71,
        eventKind: "primary",
        title: "Bad event",
        eventTime: "not a date",
        ingestTime: "2026-04-28T05:00:01.000Z",
        rationale: "bad",
        sourceType: "summary",
        sourceId: "sum_canon_bad",
      }),
    ).rejects.toThrow(/eventTime/);
  });

  it("orders task-bridge suggestions deterministically when timestamps tie", async () => {
    const { TaskBridgeSuggestionStore } = await import(
      "../src/store/task-bridge-suggestion-store.js"
    );
    const db = makeDb();
    createConversation(db, 73);
    const observedWork = new ObservedWorkStore(db);
    for (const id of ["work_tie_a", "work_tie_b", "work_tie_c"]) {
      observedWork.upsertItem({
        workItemId: id,
        conversationId: 73,
        firstSeenAt: "2026-04-28T01:00:00.000Z",
        lastSeenAt: "2026-04-28T01:00:00.000Z",
        title: `Tie item ${id}`,
        observedStatus: "observed_unfinished",
        kind: "follow_up",
        fingerprint: `tie:${id}`,
      });
      observedWork.addSource({
        workItemId: id,
        sourceType: "summary",
        sourceId: `sum_tie_${id}`,
        ordinal: 0,
        evidenceKind: "created",
      });
    }
    const store = new TaskBridgeSuggestionStore(db);
    // datetime('now') has whole-second precision, so all three writes share
    // updated_at + created_at. listSuggestions must still return them in a
    // deterministic order — append `suggestion_id ASC` as a tiebreaker.
    await store.upsertSuggestion({
      suggestionId: "sug_b",
      workItemId: "work_tie_b",
      suggestionKind: "create_task",
      confidence: 0.7,
      rationale: "b",
      sourceIds: ["sum_tie_work_tie_b"],
    });
    await store.upsertSuggestion({
      suggestionId: "sug_a",
      workItemId: "work_tie_a",
      suggestionKind: "create_task",
      confidence: 0.7,
      rationale: "a",
      sourceIds: ["sum_tie_work_tie_a"],
    });
    await store.upsertSuggestion({
      suggestionId: "sug_c",
      workItemId: "work_tie_c",
      suggestionKind: "create_task",
      confidence: 0.7,
      rationale: "c",
      sourceIds: ["sum_tie_work_tie_c"],
    });
    const list = store.listSuggestions({ status: "pending" });
    expect(list.map((row) => row.suggestionId)).toEqual(["sug_a", "sug_b", "sug_c"]);
  });
});
