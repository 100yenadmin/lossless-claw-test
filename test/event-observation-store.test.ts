import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { EventObservationStore } from "../src/store/event-observation-store.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

function createConversation(db: DatabaseSync, conversationId: number): void {
  db.prepare(
    `INSERT INTO conversations (conversation_id, session_id, session_key, title)
     VALUES (?, ?, ?, ?)`,
  ).run(
    conversationId,
    `event-episode-${conversationId}`,
    `agent:main:event-episode-${conversationId}`,
    `Event episode ${conversationId}`,
  );
}

describe("EventObservationStore episode grouping", () => {
  let db: DatabaseSync;
  let store: EventObservationStore;

  beforeEach(() => {
    db = makeDb();
    createConversation(db, 1);
    store = new EventObservationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("groups two observations sharing (conversation, kind, queryKey) into one episode", async () => {
    await store.upsertObservation({
      eventId: "ev_1",
      conversationId: 1,
      eventKind: "primary",
      title: "First merge of PR #531",
      ingestTime: "2026-04-25T10:00:00.000Z",
      eventTime: "2026-04-25T10:00:00.000Z",
      confidence: 0.7,
      rationale: "first observation",
      sourceType: "summary",
      sourceId: "sum_a",
      queryKey: "PR 531",
    });
    await store.upsertObservation({
      eventId: "ev_2",
      conversationId: 1,
      eventKind: "primary",
      title: "Re-merge of PR #531 after revert",
      ingestTime: "2026-04-26T11:00:00.000Z",
      eventTime: "2026-04-26T11:00:00.000Z",
      confidence: 0.9,
      rationale: "second observation",
      sourceType: "summary",
      sourceId: "sum_b",
      queryKey: "pr-531",
    });

    const episodes = store.listEpisodes({ conversationId: 1 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.observationCount).toBe(2);
    expect(episodes[0]?.topicKey).toBe("pr-531");
    // Earliest title wins.
    expect(episodes[0]?.title).toBe("First merge of PR #531");
    // MAX confidence across observations.
    expect(episodes[0]?.confidence).toBeCloseTo(0.9);
    // first/last event time bracket the two observations.
    expect(episodes[0]?.firstEventTime.startsWith("2026-04-25")).toBe(true);
    expect(episodes[0]?.lastEventTime.startsWith("2026-04-26")).toBe(true);
  });

  it("creates separate episodes per (conversation, kind, queryKey)", async () => {
    await store.upsertObservation({
      eventId: "ev_a",
      conversationId: 1,
      eventKind: "primary",
      title: "PR #500 merged",
      ingestTime: "2026-04-25T10:00:00.000Z",
      confidence: 0.7,
      rationale: "ok",
      sourceType: "summary",
      sourceId: "sum_a",
      queryKey: "pr-500",
    });
    await store.upsertObservation({
      eventId: "ev_b",
      conversationId: 1,
      eventKind: "decision",
      title: "Adopt rebase strategy",
      ingestTime: "2026-04-25T10:30:00.000Z",
      confidence: 0.6,
      rationale: "ok",
      sourceType: "summary",
      sourceId: "sum_b",
      queryKey: "pr-500",
    });
    const episodes = store.listEpisodes({ conversationId: 1 });
    expect(episodes).toHaveLength(2);
    const kinds = episodes.map((episode) => episode.episodeKind).sort();
    expect(kinds).toEqual(["decision", "primary"]);
  });

  it("re-bucketing an event into a different episode rebuilds both episodes", async () => {
    await store.upsertObservation({
      eventId: "ev_x",
      conversationId: 1,
      eventKind: "primary",
      title: "Initial PR #800",
      ingestTime: "2026-04-25T10:00:00.000Z",
      confidence: 0.7,
      rationale: "ok",
      sourceType: "summary",
      sourceId: "sum_x",
      queryKey: "pr-800",
    });
    expect(store.listEpisodes({ conversationId: 1 })).toHaveLength(1);

    // Re-upsert same eventId under a different topic; the old episode should be
    // empty afterwards and removed.
    await store.upsertObservation({
      eventId: "ev_x",
      conversationId: 1,
      eventKind: "primary",
      title: "Renamed to PR #801",
      ingestTime: "2026-04-25T10:05:00.000Z",
      confidence: 0.7,
      rationale: "rename",
      sourceType: "summary",
      sourceId: "sum_x",
      queryKey: "pr-801",
    });
    const episodes = store.listEpisodes({ conversationId: 1 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.topicKey).toBe("pr-801");
    expect(episodes[0]?.observationCount).toBe(1);
  });

  it("listEpisodes filters by query, since, before, and respects limit", async () => {
    await store.upsertObservation({
      eventId: "ev_1",
      conversationId: 1,
      eventKind: "primary",
      title: "PR #700 first",
      ingestTime: "2026-04-25T10:00:00.000Z",
      eventTime: "2026-04-25T10:00:00.000Z",
      confidence: 0.7,
      rationale: "ok",
      sourceType: "summary",
      sourceId: "sum_1",
      queryKey: "pr-700",
    });
    await store.upsertObservation({
      eventId: "ev_2",
      conversationId: 1,
      eventKind: "primary",
      title: "PR #701 first",
      ingestTime: "2026-04-26T10:00:00.000Z",
      eventTime: "2026-04-26T10:00:00.000Z",
      confidence: 0.7,
      rationale: "ok",
      sourceType: "summary",
      sourceId: "sum_2",
      queryKey: "pr-701",
    });
    expect(
      store.listEpisodes({ conversationId: 1, query: "PR 701" }).map((episode) => episode.topicKey),
    ).toEqual(["pr-701"]);
    expect(
      store
        .listEpisodes({ conversationId: 1, since: "2026-04-26T00:00:00.000Z" })
        .map((episode) => episode.topicKey),
    ).toEqual(["pr-701"]);
    expect(
      store
        .listEpisodes({ conversationId: 1, before: "2026-04-26T00:00:00.000Z" })
        .map((episode) => episode.topicKey),
    ).toEqual(["pr-700"]);
    expect(store.listEpisodes({ conversationId: 1, limit: 1 })).toHaveLength(1);
  });

  it("includeSources surfaces deduplicated sources from observations", async () => {
    await store.upsertObservation({
      eventId: "ev_src",
      conversationId: 1,
      eventKind: "primary",
      title: "PR #900",
      ingestTime: "2026-04-25T10:00:00.000Z",
      confidence: 0.7,
      rationale: "ok",
      sourceType: "summary",
      sourceId: "sum_a",
      sourceIds: ["sum_a", "sum_b", "sum_b"],
      queryKey: "pr-900",
    });
    const [episode] = store.listEpisodes({ conversationId: 1, includeSources: true });
    expect(episode?.sources?.map((source) => source.sourceId).sort()).toEqual(["sum_a", "sum_b"]);
  });

  it("first=true orders ascending by first_event_time", async () => {
    await store.upsertObservation({
      eventId: "ev_old",
      conversationId: 1,
      eventKind: "primary",
      title: "Older",
      ingestTime: "2026-04-20T10:00:00.000Z",
      eventTime: "2026-04-20T10:00:00.000Z",
      confidence: 0.5,
      rationale: "ok",
      sourceType: "summary",
      sourceId: "sum_old",
      queryKey: "topic-a",
    });
    await store.upsertObservation({
      eventId: "ev_new",
      conversationId: 1,
      eventKind: "primary",
      title: "Newer",
      ingestTime: "2026-04-30T10:00:00.000Z",
      eventTime: "2026-04-30T10:00:00.000Z",
      confidence: 0.5,
      rationale: "ok",
      sourceType: "summary",
      sourceId: "sum_new",
      queryKey: "topic-b",
    });
    expect(
      store.listEpisodes({ conversationId: 1, first: true }).map((episode) => episode.topicKey),
    ).toEqual(["topic-a", "topic-b"]);
    expect(
      store.listEpisodes({ conversationId: 1 }).map((episode) => episode.topicKey),
    ).toEqual(["topic-b", "topic-a"]);
  });
});
