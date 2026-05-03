import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ObservedWorkStore } from "../src/store/observed-work-store.js";
import { TaskBridgeSuggestionStore } from "../src/store/task-bridge-suggestion-store.js";
import {
  createLcmTaskSuggestionReviewTool,
  createLcmTaskSuggestionsTool,
} from "../src/tools/lcm-task-suggestions-tool.js";
import type { LcmDependencies } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function createConversation(db: DatabaseSync, conversationId: number): void {
  db.prepare(
    `INSERT INTO conversations (conversation_id, session_id, session_key, title)
     VALUES (?, ?, ?, ?)`
  ).run(
    conversationId,
    `task-bridge-${conversationId}`,
    `agent:main:task-bridge-${conversationId}`,
    `Task bridge ${conversationId}`
  );
}

function addObservedSources(
  db: DatabaseSync,
  workItemId: string,
  sourceIds: string[]
): void {
  const observedWork = new ObservedWorkStore(db);
  sourceIds.forEach((sourceId, index) => {
    observedWork.addSource({
      workItemId,
      sourceType: "summary",
      sourceId,
      ordinal: index,
      evidenceKind: "created",
    });
  });
}

function createObservedWorkItem(
  db: DatabaseSync,
  workItemId: string,
  sourceIds?: string[],
  kind: "follow_up" | "blocker" | "question" = "follow_up",
  observedStatus: "observed_unfinished" | "observed_ambiguous" | "observed_completed" = "observed_unfinished"
): void {
  createConversation(db, 1);
  const observedWork = new ObservedWorkStore(db);
  observedWork.upsertItem({
    workItemId,
    conversationId: 1,
    firstSeenAt: "2026-04-28T00:00:00.000Z",
    lastSeenAt: "2026-04-28T01:00:00.000Z",
    title: `Observed work ${workItemId}`,
    observedStatus,
    kind,
    confidence: 0.86,
    fingerprint: `observed:${workItemId}`,
  });
  addObservedSources(db, workItemId, sourceIds ?? [`sum_${workItemId}`]);
}

describe("TaskBridgeSuggestionStore", () => {
  it("creates task bridge suggestion table during migration", () => {
    const db = makeDb();
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_task_bridge_suggestions'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("lcm_task_bridge_suggestions");
  });

  it("stores suggestions as pending records without applying task writes", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_1", ["sum_a", "sum_b"]);
    const store = new TaskBridgeSuggestionStore(db);
    expect(await store.upsertSuggestion({
      suggestionId: "sug_1",
      workItemId: "work_1",
      suggestionKind: "create_task",
      confidence: 0.91,
      rationale: "Observed repeated unfinished blocker evidence.",
      sourceIds: ["sum_a", "sum_b", "sum_a", ""],
    })).toBe("inserted");
    expect(await store.upsertSuggestion({
      suggestionId: "sug_1",
      workItemId: "work_1",
      suggestionKind: "create_task",
      confidence: 0.92,
      rationale: "Observed repeated unfinished blocker evidence again.",
      sourceIds: ["sum_a", "sum_b"],
    })).toBe("refreshed");

    const suggestions = store.listSuggestions({ status: "pending" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      suggestionId: "sug_1",
      workItemId: "work_1",
      suggestionKind: "create_task",
      status: "pending",
      sourceIds: ["sum_a", "sum_b"],
    });
    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'tasks'`)
        .get()
    ).toBeUndefined();
  });

  it("records review status without modifying external task state", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_2", ["sum_done", "sum_done_later"]);
    const store = new TaskBridgeSuggestionStore(db);
    expect(await store.upsertSuggestion({
      suggestionId: "sug_2",
      workItemId: "work_2",
      taskId: "task_123",
      suggestionKind: "mark_task_done",
      confidence: 0.97,
      rationale: "Observed explicit completion evidence.",
      sourceIds: ["sum_done"],
    })).toBe("inserted");
    expect(
      store.reviewSuggestion({
        suggestionId: "sug_2",
        status: "accepted",
        reviewedBy: " tester ",
      })
    ).toBe(true);

    const accepted = store.listSuggestions({ status: "accepted" });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      suggestionId: "sug_2",
      taskId: "task_123",
      status: "accepted",
      reviewedBy: "tester",
    });
    const observedWork = new ObservedWorkStore(db);
    observedWork.upsertItem({
      workItemId: "work_2b",
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      title: "Different observed work item",
      observedStatus: "observed_unfinished",
      kind: "follow_up",
      confidence: 0.8,
      fingerprint: "observed:work_2b",
    });
    observedWork.addSource({
      workItemId: "work_2b",
      sourceType: "summary",
      sourceId: "sum_other",
      ordinal: 0,
      evidenceKind: "created",
    });

    expect(await store.upsertSuggestion({
      suggestionId: "sug_2",
      workItemId: "work_2b",
      suggestionKind: "create_task",
      confidence: 0.99,
      rationale: "A later deterministic scan saw the same suggestion again.",
      sourceIds: ["sum_other"],
      createdBy: "second-writer",
    })).toBe("preserved_reviewed");
    const stillAccepted = store.listSuggestions({ status: "accepted" });
    expect(stillAccepted).toHaveLength(1);
    expect(stillAccepted[0]).toMatchObject({
      suggestionId: "sug_2",
      workItemId: "work_2",
      suggestionKind: "mark_task_done",
      status: "accepted",
      taskId: "task_123",
      confidence: 0.97,
      rationale: "Observed explicit completion evidence.",
      createdBy: "lcm_observed",
      reviewedBy: "tester",
      sourceIds: ["sum_done"],
    });
    expect(store.listSuggestions({ status: "pending" })).toHaveLength(0);

    expect(
      store.reviewSuggestion({
        suggestionId: "sug_2",
        status: "dismissed",
        reviewedBy: "second-reviewer",
      })
    ).toBe(false);
    expect(store.listSuggestions({ status: "dismissed" })).toHaveLength(0);
    const acceptedAfterSecondReview = store.listSuggestions({ status: "accepted" });
    expect(acceptedAfterSecondReview[0]).toMatchObject({
      suggestionId: "sug_2",
      status: "accepted",
      reviewedBy: "tester",
    });
  });

  it("orders refreshed pending suggestions by updated time", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_order", ["sum_order"]);
    const store = new TaskBridgeSuggestionStore(db);

    expect(await store.upsertSuggestion({
      suggestionId: "sug_old",
      workItemId: "work_order",
      suggestionKind: "create_task",
      confidence: 0.7,
      rationale: "Older suggestion.",
      sourceIds: ["sum_order"],
    })).toBe("inserted");
    expect(await store.upsertSuggestion({
      suggestionId: "sug_refreshed",
      workItemId: "work_order",
      suggestionKind: "create_task",
      confidence: 0.8,
      rationale: "Initial refreshed suggestion.",
      sourceIds: ["sum_order"],
    })).toBe("inserted");
    db.prepare(
      `UPDATE lcm_task_bridge_suggestions
       SET created_at = ?, updated_at = ?
       WHERE suggestion_id = ?`
    ).run("2026-04-28T01:00:00.000Z", "2026-04-28T01:00:00.000Z", "sug_old");
    db.prepare(
      `UPDATE lcm_task_bridge_suggestions
       SET created_at = ?, updated_at = ?
       WHERE suggestion_id = ?`
    ).run("2026-04-28T00:00:00.000Z", "2026-04-28T02:00:00.000Z", "sug_refreshed");

    expect(store.listSuggestions({ status: "pending" }).map((item) => item.suggestionId))
      .toEqual(["sug_refreshed", "sug_old"]);
  });

  it("rejects invalid suggestion records and reports missing review targets", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_3", ["sum_bad"]);
    const store = new TaskBridgeSuggestionStore(db);

    await expect(
      store.upsertSuggestion({
        suggestionId: "bad_confidence",
        workItemId: "work_3",
        suggestionKind: "create_task",
        confidence: 1.5,
        rationale: "too confident",
        sourceIds: ["sum_bad"],
      })
    ).rejects.toThrow(/confidence/);
    await expect(
      store.upsertSuggestion({
        suggestionId: "bad_sources",
        workItemId: "work_3",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "missing sources",
        sourceIds: [],
      })
    ).rejects.toThrow(/source ID/);
    await expect(
      store.upsertSuggestion({
        suggestionId: " ",
        workItemId: "work_3",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "blank suggestion ID",
        sourceIds: ["sum_bad"],
      })
    ).rejects.toThrow(/suggestionId/);
    await expect(
      store.upsertSuggestion({
        suggestionId: "bad_work_item",
        workItemId: " ",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "blank work item ID",
        sourceIds: ["sum_bad"],
      })
    ).rejects.toThrow(/workItemId/);
    await expect(
      store.upsertSuggestion({
        suggestionId: "missing_work",
        workItemId: "missing_work_item",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "missing FK target",
        sourceIds: ["sum_bad"],
      })
    ).rejects.toThrow();
    await expect(
      store.upsertSuggestion({
        suggestionId: "missing_source",
        workItemId: "work_3",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "missing observed source",
        sourceIds: ["missing_source"],
      })
    ).rejects.toThrow(/source IDs/);
    await expect(
      store.upsertSuggestion({
        suggestionId: "reviewed_on_upsert",
        workItemId: "work_3",
        suggestionKind: "create_task",
        status: "accepted",
        confidence: 0.8,
        rationale: "review state attempted on upsert",
        sourceIds: ["sum_bad"],
      })
    ).rejects.toThrow(/reviewSuggestion/);
    await expect(
      store.upsertSuggestion({
        suggestionId: "missing_task_id",
        workItemId: "work_3",
        suggestionKind: "mark_task_done",
        confidence: 0.8,
        rationale: "targeted task action without task target",
        sourceIds: ["sum_bad"],
      })
    ).rejects.toThrow(/taskId/);
    expect(
      store.reviewSuggestion({
        suggestionId: "missing",
        status: "dismissed",
        reviewedBy: "tester",
      })
    ).toBe(false);
  });

  it("previews, records, and reviews suggestions without external task writes", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_tool");
    const observedWork = new ObservedWorkStore(db);
    const taskBridge = new TaskBridgeSuggestionStore(db);
    const lcm = {
      getObservedWorkStore: () => observedWork,
      getTaskBridgeSuggestionStore: () => taskBridge,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
    } as unknown as LcmDependencies;
    const suggestionsTool = createLcmTaskSuggestionsTool({
      deps,
      lcm: lcm as never,
      sessionId: "task-suggestion-session",
    });

    const preview = await suggestionsTool.execute("suggest-preview", {
      conversationId: 1,
    });
    expect(JSON.stringify(preview.details)).toContain("create_task");
    expect(JSON.stringify(preview.details)).not.toContain("sum_work_tool");
    expect(taskBridge.listSuggestions()).toHaveLength(0);

    const allConversations = await suggestionsTool.execute("suggest-all", {
      allConversations: true,
    });
    expect((allConversations.details as { error?: string }).error).toMatch(
      /does not support allConversations/,
    );
    const invalidSince = await suggestionsTool.execute("suggest-invalid-since", {
      conversationId: 1,
      since: "2026-04-28",
    });
    expect((invalidSince.details as { error?: string }).error).toMatch(
      /ISO timestamp with timezone/
    );

    const recorded = await suggestionsTool.execute("suggest-record", {
      conversationId: 1,
      mode: "record",
      includeSources: true,
    });
    expect(JSON.stringify(recorded.details)).toContain("sum_work_tool");
    const pending = taskBridge.listSuggestions({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'tasks'`).get()).toBeUndefined();

    const reviewTool = createLcmTaskSuggestionReviewTool({ lcm: lcm as never });
    const reviewed = await reviewTool.execute("suggest-review", {
      suggestionId: pending[0]!.suggestionId,
      status: "dismissed ",
      reviewedBy: " unit-test ",
    });
    expect((reviewed.details as { changed: boolean }).changed).toBe(true);
    expect(taskBridge.listSuggestions({ status: "dismissed" })[0]).toMatchObject({
      status: "dismissed",
      reviewedBy: "unit-test",
    });

    const rerecorded = await suggestionsTool.execute("suggest-record-again", {
      conversationId: 1,
      mode: "record",
    });
    expect(
      (rerecorded.details as { accounting: { recorded: number } }).accounting
        .recorded
    ).toBe(0);
    expect(
      (rerecorded.details as { accounting: { preservedReviewed: number } })
        .accounting.preservedReviewed
    ).toBe(1);
  });

  it("records unlinked blocker observations as task-creation suggestions", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_blocker", ["sum_blocker"], "blocker");
    const observedWork = new ObservedWorkStore(db);
    const taskBridge = new TaskBridgeSuggestionStore(db);
    const lcm = {
      getObservedWorkStore: () => observedWork,
      getTaskBridgeSuggestionStore: () => taskBridge,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
    } as unknown as LcmDependencies;
    const suggestionsTool = createLcmTaskSuggestionsTool({
      deps,
      lcm: lcm as never,
      sessionId: "task-suggestion-session",
    });

    const preview = await suggestionsTool.execute("suggest-preview", {
      conversationId: 1,
      kinds: ["blocker"],
    });
    expect(JSON.stringify(preview.details)).toContain("create_task");
    expect(JSON.stringify(preview.details)).not.toContain("mark_task_blocked");

    await suggestionsTool.execute("suggest-record", {
      conversationId: 1,
      kinds: ["blocker"],
      mode: "record",
    });
    const pending = taskBridge.listSuggestions({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.suggestionKind).toBe("create_task");
  });

  it("records ambiguous observations as task-creation suggestions until a task is linked", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_ambiguous", ["sum_ambiguous"], "question", "observed_ambiguous");
    const observedWork = new ObservedWorkStore(db);
    const taskBridge = new TaskBridgeSuggestionStore(db);
    const lcm = {
      getObservedWorkStore: () => observedWork,
      getTaskBridgeSuggestionStore: () => taskBridge,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
    } as unknown as LcmDependencies;
    const suggestionsTool = createLcmTaskSuggestionsTool({
      deps,
      lcm: lcm as never,
      sessionId: "task-suggestion-session",
    });

    const preview = await suggestionsTool.execute("suggest-preview", {
      conversationId: 1,
      statuses: ["observed_ambiguous"],
    });
    expect(JSON.stringify(preview.details)).toContain("create_task");
    expect(JSON.stringify(preview.details)).not.toContain("add_task_evidence");

    await suggestionsTool.execute("suggest-record", {
      conversationId: 1,
      statuses: ["observed_ambiguous"],
      mode: "record",
    });
    const pending = taskBridge.listSuggestions({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.suggestionKind).toBe("create_task");
  });

  describe("bulkUpsertSuggestions", () => {
    it("returns [] for an empty input without opening a transaction", async () => {
      const db = makeDb();
      const store = new TaskBridgeSuggestionStore(db);
      // If this opened a tx, a follow-up BEGIN IMMEDIATE would fail with
      // "cannot start a transaction within a transaction".
      const results = await store.bulkUpsertSuggestions([]);
      expect(results).toEqual([]);
      db.exec("BEGIN IMMEDIATE");
      db.exec("COMMIT");
    });

    it("inserts new rows and refreshes existing pending rows in one batch", async () => {
      const db = makeDb();
      createObservedWorkItem(db, "work_bulk_a", ["sum_a1", "sum_a2"]);
      const observedWork = new ObservedWorkStore(db);
      observedWork.upsertItem({
        workItemId: "work_bulk_b",
        conversationId: 1,
        firstSeenAt: "2026-04-28T00:00:00.000Z",
        lastSeenAt: "2026-04-28T01:00:00.000Z",
        title: "Bulk B",
        observedStatus: "observed_unfinished",
        kind: "follow_up",
        confidence: 0.8,
        fingerprint: "observed:work_bulk_b",
      });
      addObservedSources(db, "work_bulk_b", ["sum_b1"]);

      const store = new TaskBridgeSuggestionStore(db);
      // Pre-seed `sug_a` so it should come back as "refreshed" on the second
      // pass; `sug_b` is brand new and should come back as "inserted".
      expect(
        await store.upsertSuggestion({
          suggestionId: "sug_a",
          workItemId: "work_bulk_a",
          suggestionKind: "create_task",
          confidence: 0.7,
          rationale: "Initial insert.",
          sourceIds: ["sum_a1"],
        })
      ).toBe("inserted");

      const results = await store.bulkUpsertSuggestions([
        {
          suggestionId: "sug_a",
          workItemId: "work_bulk_a",
          suggestionKind: "create_task",
          confidence: 0.85,
          rationale: "Refreshed via bulk.",
          sourceIds: ["sum_a1", "sum_a2"],
        },
        {
          suggestionId: "sug_b",
          workItemId: "work_bulk_b",
          suggestionKind: "create_task",
          confidence: 0.6,
          rationale: "Brand new via bulk.",
          sourceIds: ["sum_b1"],
        },
      ]);
      expect(results).toEqual(["refreshed", "inserted"]);
      const pending = store.listSuggestions({ status: "pending" });
      expect(pending.map((row) => row.suggestionId).sort()).toEqual([
        "sug_a",
        "sug_b",
      ]);
    });

    it("preserves the result order and reports preserved_reviewed for reviewed rows", async () => {
      const db = makeDb();
      createObservedWorkItem(db, "work_bulk_pres", ["sum_p1", "sum_p2"]);
      const store = new TaskBridgeSuggestionStore(db);
      await store.upsertSuggestion({
        suggestionId: "sug_p1",
        workItemId: "work_bulk_pres",
        suggestionKind: "create_task",
        confidence: 0.7,
        rationale: "Reviewed already.",
        sourceIds: ["sum_p1"],
      });
      expect(
        store.reviewSuggestion({
          suggestionId: "sug_p1",
          status: "accepted",
          reviewedBy: "tester",
        })
      ).toBe(true);

      const results = await store.bulkUpsertSuggestions([
        {
          suggestionId: "sug_p2",
          workItemId: "work_bulk_pres",
          suggestionKind: "create_task",
          confidence: 0.65,
          rationale: "New row arriving first in the array.",
          sourceIds: ["sum_p2"],
        },
        {
          suggestionId: "sug_p1",
          workItemId: "work_bulk_pres",
          suggestionKind: "create_task",
          confidence: 0.95,
          rationale: "Re-scan a reviewed row.",
          sourceIds: ["sum_p1"],
        },
      ]);
      expect(results).toEqual(["inserted", "preserved_reviewed"]);
      const accepted = store.listSuggestions({ status: "accepted" });
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.suggestionId).toBe("sug_p1");
      expect(accepted[0]?.confidence).toBe(0.7);
    });

    it("demotes a row whose source ID does not belong to its work item to skipped", async () => {
      const db = makeDb();
      createObservedWorkItem(db, "work_bulk_ok", ["sum_ok"]);
      const observedWork = new ObservedWorkStore(db);
      observedWork.upsertItem({
        workItemId: "work_bulk_other",
        conversationId: 1,
        firstSeenAt: "2026-04-28T00:00:00.000Z",
        lastSeenAt: "2026-04-28T01:00:00.000Z",
        title: "Other",
        observedStatus: "observed_unfinished",
        kind: "follow_up",
        confidence: 0.8,
        fingerprint: "observed:work_bulk_other",
      });
      addObservedSources(db, "work_bulk_other", ["sum_other"]);
      const store = new TaskBridgeSuggestionStore(db);
      // Middle row has a source ID that exists but does NOT belong to its
      // declared work item — assertSourceIdsBelongToWorkItem throws inside the
      // savepoint, which should demote that single row to "skipped" while the
      // surrounding good rows commit.
      const results = await store.bulkUpsertSuggestions([
        {
          suggestionId: "sug_ok_1",
          workItemId: "work_bulk_ok",
          suggestionKind: "create_task",
          confidence: 0.7,
          rationale: "Good row 1.",
          sourceIds: ["sum_ok"],
        },
        {
          suggestionId: "sug_bad",
          workItemId: "work_bulk_ok",
          suggestionKind: "create_task",
          confidence: 0.8,
          rationale: "Source belongs to a different work item.",
          sourceIds: ["sum_other"],
        },
        {
          suggestionId: "sug_ok_2",
          workItemId: "work_bulk_other",
          suggestionKind: "create_task",
          confidence: 0.6,
          rationale: "Good row 2 on a different work item.",
          sourceIds: ["sum_other"],
        },
      ]);
      expect(results).toEqual(["inserted", "skipped", "inserted"]);
      const pending = store
        .listSuggestions({ status: "pending" })
        .map((row) => row.suggestionId)
        .sort();
      expect(pending).toEqual(["sug_ok_1", "sug_ok_2"]);
    });
  });
});
