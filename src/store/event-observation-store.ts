import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { clampListLimit, escapeLikePattern, placeholders } from "../db/sql-utils.js";
import { withDatabaseTransaction } from "../transaction-mutex.js";

export type EventObservationKind =
  | "primary"
  | "retelling"
  | "memory_injection"
  | "echo"
  | "imported"
  | "operational_incident"
  | "decision";

export type EventObservationInput = {
  eventId: string;
  conversationId: number;
  eventKind: EventObservationKind;
  title: string;
  description?: string;
  queryKey?: string;
  eventTime?: string;
  ingestTime: string;
  confidence?: number;
  rationale: string;
  sourceType: "summary" | "rollup" | "message";
  sourceId: string;
  sourceIds?: string[];
};

export type EventSource = {
  sourceType?: "summary" | "rollup" | "message";
  sourceId: string;
};

export type EventObservation = {
  eventId: string;
  conversationId: number;
  eventKind: EventObservationKind;
  title: string;
  description?: string;
  queryKey?: string;
  eventTime?: string;
  ingestTime: string;
  confidence: number;
  rationale: string;
  sources?: EventSource[];
  createdAt: string;
  updatedAt: string;
};

export type EventEpisode = {
  episodeId: string;
  conversationId: number;
  episodeKind: EventObservationKind;
  topicKey: string;
  title: string;
  firstEventTime: string;
  lastEventTime: string;
  observationCount: number;
  confidence: number;
  sources?: EventSource[];
  createdAt: string;
  updatedAt: string;
};

type EventObservationRow = {
  event_id: string;
  conversation_id: number;
  event_kind: EventObservationKind;
  title: string;
  description: string | null;
  query_key: string | null;
  event_time: string | null;
  ingest_time: string;
  confidence: number;
  rationale: string;
  source_type: "summary" | "rollup" | "message";
  source_id: string;
  source_ids: string;
  created_at: string;
  updated_at: string;
};

type EventEpisodeRow = {
  episode_id: string;
  conversation_id: number;
  episode_kind: EventObservationKind;
  topic_key: string;
  title: string;
  first_event_time: string;
  last_event_time: string;
  observation_count: number;
  confidence: number;
  source_ids: string;
  created_at: string;
  updated_at: string;
};

// `placeholders` and `escapeLikePattern` are now shared from sql-utils
// (issue #30 — see import above).

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

const MAX_EVENT_SOURCE_IDS = 50;
const MAX_EPISODE_SOURCES = 20;
// Cap source_ids JSON blob on write to avoid unbounded growth on hot episodes.
// MAX_EPISODE_SOURCES * 2 leaves headroom over the read-side slice while bounding
// memory + write amplification to O(1) per upsert instead of O(N) over lifetime.
const MAX_PERSISTED_EPISODE_SOURCES = MAX_EPISODE_SOURCES * 2;

function normalizeSourceIds(sourceIds: string[] | undefined, fallbackSourceId: string): string[] {
  return [
    ...new Set(
      [fallbackSourceId, ...(sourceIds ?? [])]
        .map((sourceId) => sourceId.trim())
        .filter((sourceId) => sourceId.length > 0)
    ),
  ];
}

function canonicalizeIsoTimestamp(value: string | undefined, field: string): string | null {
  if (value == null) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be a valid ISO-8601 timestamp.`);
  }
  return parsed.toISOString();
}

function normalizeQueryKey(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  const pr =
    /^(?:pr|pull request)\s*#?\s*(\d{1,6})$/.exec(normalized) ??
    /^pr[-\s#]*(\d{1,6})$/.exec(normalized) ??
    /(?:^|\/)pull\/(\d{1,6})(?:\b|$)/.exec(normalized);
  if (pr?.[1]) {
    return `pr-${pr[1]}`;
  }
  return normalized;
}

function parseSourceIds(raw: string, sourceType: "summary" | "rollup" | "message"): Array<{
  sourceType: "summary" | "rollup" | "message";
  sourceId: string;
}> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((sourceId): sourceId is string => typeof sourceId === "string" && sourceId.trim().length > 0)
      .map((sourceId) => ({ sourceType, sourceId }));
  } catch {
    return [];
  }
}

function isEventSourceType(value: unknown): value is "summary" | "rollup" | "message" {
  return value === "summary" || value === "rollup" || value === "message";
}

// Parses an episode source_ids JSON blob, accepting either bare strings (as written
// by lcm_event_observations.source_ids) or {sourceType, sourceId} objects (as written
// by lcm_event_episodes.source_ids).
function parseSources(
  raw: string,
  fallbackSourceType?: "summary" | "rollup" | "message",
): EventSource[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((source): EventSource | null => {
        if (typeof source === "string" && source.trim().length > 0) {
          return {
            ...(fallbackSourceType ? { sourceType: fallbackSourceType } : {}),
            sourceId: source.trim(),
          };
        }
        if (
          typeof source === "object" &&
          source != null &&
          "sourceId" in source &&
          typeof (source as { sourceId: unknown }).sourceId === "string" &&
          (source as { sourceId: string }).sourceId.trim().length > 0
        ) {
          const sourceType = "sourceType" in source ? (source as { sourceType?: unknown }).sourceType : undefined;
          return {
            ...(isEventSourceType(sourceType) ? { sourceType } : {}),
            sourceId: (source as { sourceId: string }).sourceId.trim(),
          };
        }
        return null;
      })
      .filter((source): source is EventSource => source != null);
  } catch {
    return [];
  }
}

function sourcesFromIds(
  sourceType: "summary" | "rollup" | "message",
  sourceIds: string[],
): EventSource[] {
  const seen = new Set<string>();
  const out: EventSource[] = [];
  for (const raw of sourceIds) {
    const sourceId = raw.trim();
    if (!sourceId) continue;
    const key = `${sourceType}:${sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceType, sourceId });
  }
  return out;
}

function compareIso(a: string, b: string, pick: "min" | "max"): string {
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  if (!Number.isFinite(aTime)) return b;
  if (!Number.isFinite(bTime)) return a;
  if (pick === "min") {
    return aTime <= bTime ? a : b;
  }
  return aTime >= bTime ? a : b;
}

function rowToEvent(row: EventObservationRow, includeSources: boolean): EventObservation {
  return {
    eventId: row.event_id,
    conversationId: row.conversation_id,
    eventKind: row.event_kind,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    ...(row.query_key ? { queryKey: row.query_key } : {}),
    ...(row.event_time ? { eventTime: row.event_time } : {}),
    ingestTime: row.ingest_time,
    confidence: row.confidence,
    rationale: row.rationale,
    ...(includeSources
      ? { sources: parseSourceIds(row.source_ids, row.source_type) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEpisode(row: EventEpisodeRow, includeSources: boolean): EventEpisode {
  return {
    episodeId: row.episode_id,
    conversationId: row.conversation_id,
    episodeKind: row.episode_kind,
    topicKey: row.topic_key,
    title: row.title,
    firstEventTime: row.first_event_time,
    lastEventTime: row.last_event_time,
    observationCount: row.observation_count,
    confidence: row.confidence,
    ...(includeSources
      ? { sources: parseSources(row.source_ids).slice(0, MAX_EPISODE_SOURCES) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class EventObservationStore {
  // Cascade contract (issue #31): the link table
  // `lcm_event_episode_observations` declares ON DELETE CASCADE on its
  // event_id FK to `lcm_event_observations`, so deleting an observation row
  // wipes its link rows. BUT the parent episode's aggregate columns
  // (observation_count, first/last_event_time, confidence, source_ids) are
  // NOT auto-recomputed — they are only refreshed via `rebuildEpisode()`,
  // which runs as part of `upsertObservation()`.
  //
  // Today, observation deletion only happens via `conversations` ON DELETE
  // CASCADE (which removes the entire episode row through the same path,
  // so the staleness window is invisible). Any future code path that
  // deletes an observation directly without removing its conversation MUST
  // call `unlinkObservation()` (the canonical helper below) instead of
  // raw SQL, otherwise the parent episode aggregates go stale.
  constructor(private readonly db: DatabaseSync) {}

  async upsertObservation(input: EventObservationInput): Promise<void> {
    if (!Number.isFinite(input.confidence ?? 0.5) || (input.confidence ?? 0.5) < 0 || (input.confidence ?? 0.5) > 1) {
      throw new Error("confidence must be between 0 and 1.");
    }
    if (input.title.trim().length === 0) {
      throw new Error("event title is required.");
    }
    if (input.rationale.trim().length === 0) {
      throw new Error("event rationale is required.");
    }
    const sourceId = input.sourceId.trim();
    if (sourceId.length === 0) {
      throw new Error("event source ID is required.");
    }
    const sourceIds = normalizeSourceIds(input.sourceIds, sourceId);
    if (sourceIds.length > MAX_EVENT_SOURCE_IDS) {
      throw new Error(
        `sourceIds must not exceed ${MAX_EVENT_SOURCE_IDS} entries (received ${sourceIds.length}).`
      );
    }
    // Range filtering and ordering downstream use lexicographic comparisons on
    // `coalesce(event_time, ingest_time)`. Persist canonical ISO-8601 UTC so
    // a non-canonical caller can't sort outside its real window or evade
    // since/before filters; reject unparseable timestamps loudly.
    const eventTime = canonicalizeIsoTimestamp(input.eventTime, "eventTime");
    const ingestTime = canonicalizeIsoTimestamp(input.ingestTime, "ingestTime");
    if (ingestTime == null) {
      throw new Error("ingestTime is required.");
    }
    const queryKey = normalizeQueryKey(input.queryKey) ?? "uncategorized";
    // Route through `withDatabaseTransaction` so concurrent callers serialize
    // on the per-DB async mutex (issue #260). When invoked from inside an
    // outer transaction (e.g. ObservedWorkExtractor's processConversation),
    // this function reuses the held lock and wraps the upsert in a savepoint
    // — which is required because a raw `BEGIN IMMEDIATE` here would throw
    // with "cannot start a transaction within a transaction".
    //
    // Episode bookkeeping (lcm_event_episodes + lcm_event_episode_observations)
    // runs in the same transaction so a crash mid-sequence cannot leave orphan
    // link rows or stale observation_count.
    await withDatabaseTransaction(this.db, "BEGIN IMMEDIATE", () => {
      const previousEpisodeIds = (
        this.db.prepare(
          `SELECT episode_id
           FROM lcm_event_episode_observations
           WHERE event_id = ?`,
        ).all(input.eventId) as Array<{ episode_id: string }>
      ).map((row) => row.episode_id);
      this.db.prepare(
        `INSERT INTO lcm_event_observations (
          event_id, conversation_id, event_kind, title, description, query_key,
          event_time, ingest_time, confidence, rationale, source_type, source_id,
          source_ids, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(event_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          event_kind = excluded.event_kind,
          title = excluded.title,
          description = excluded.description,
          query_key = excluded.query_key,
          event_time = excluded.event_time,
          ingest_time = excluded.ingest_time,
          confidence = excluded.confidence,
          rationale = excluded.rationale,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          source_ids = excluded.source_ids,
          updated_at = datetime('now')`,
      ).run(
        input.eventId,
        input.conversationId,
        input.eventKind,
        input.title.trim(),
        input.description?.trim() || null,
        queryKey,
        eventTime,
        ingestTime,
        input.confidence ?? 0.5,
        input.rationale.trim(),
        input.sourceType,
        sourceId,
        JSON.stringify(sourceIds),
      );
      const episodeId = this.upsertEpisodeFromObservation({
        eventId: input.eventId,
        conversationId: input.conversationId,
        eventKind: input.eventKind,
        title: input.title.trim(),
        queryKey,
        eventTime: eventTime ?? ingestTime,
        confidence: input.confidence ?? 0.5,
        sourceType: input.sourceType,
        sourceIds,
      });
      const staleEpisodeIds = [...new Set(previousEpisodeIds)]
        .filter((previousEpisodeId) => previousEpisodeId !== episodeId);
      if (staleEpisodeIds.length > 0) {
        this.db.prepare(
          `DELETE FROM lcm_event_episode_observations
           WHERE event_id = ? AND episode_id != ?`,
        ).run(input.eventId, episodeId);
      }
      this.rebuildEpisode(episodeId);
      for (const staleEpisodeId of staleEpisodeIds) {
        this.rebuildEpisode(staleEpisodeId);
      }
    });
  }

  private upsertEpisodeFromObservation(input: {
    eventId: string;
    conversationId: number;
    eventKind: EventObservationKind;
    title: string;
    queryKey: string;
    eventTime: string;
    confidence: number;
    sourceType: "summary" | "rollup" | "message";
    sourceIds: string[];
  }): string {
    const episodeId = hashId(
      "ep",
      `${input.conversationId}:${input.eventKind}:${input.queryKey}`,
    );
    const existing = this.db.prepare(
      `SELECT episode_id, conversation_id, episode_kind, topic_key, title,
              first_event_time, last_event_time, observation_count, confidence,
              source_ids, created_at, updated_at
       FROM lcm_event_episodes
       WHERE episode_id = ?`,
    ).get(episodeId) as EventEpisodeRow | undefined;
    // Cap on write: prefer the freshest sources (incoming first, then existing
    // newest-first) so the persisted JSON stays bounded as observations stream
    // into a hot episode. rebuildEpisode uses the same cap downstream.
    const incoming = sourcesFromIds(
      input.sourceType,
      input.sourceIds.length > 0 ? input.sourceIds : [input.eventId],
    );
    const existingSources = existing ? parseSources(existing.source_ids) : [];
    const merged: EventSource[] = [];
    const mergedSeen = new Set<string>();
    for (const source of [...incoming, ...existingSources]) {
      const key = `${source.sourceType ?? ""}:${source.sourceId}`;
      if (mergedSeen.has(key)) {
        continue;
      }
      mergedSeen.add(key);
      merged.push({
        ...(source.sourceType ? { sourceType: source.sourceType } : {}),
        sourceId: source.sourceId,
      });
      if (merged.length >= MAX_PERSISTED_EPISODE_SOURCES) {
        break;
      }
    }
    const sources = merged;
    const firstEventTime = existing
      ? compareIso(existing.first_event_time, input.eventTime, "min")
      : input.eventTime;
    const lastEventTime = existing
      ? compareIso(existing.last_event_time, input.eventTime, "max")
      : input.eventTime;
    this.db.prepare(
      `INSERT INTO lcm_event_episodes (
        episode_id, conversation_id, episode_kind, topic_key, title,
        first_event_time, last_event_time, observation_count, confidence,
        source_ids, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))
      ON CONFLICT(episode_id) DO UPDATE SET
        title = CASE
          WHEN julianday(excluded.first_event_time) < julianday(lcm_event_episodes.first_event_time)
          THEN excluded.title
          ELSE lcm_event_episodes.title
        END,
        first_event_time = excluded.first_event_time,
        last_event_time = excluded.last_event_time,
        confidence = max(lcm_event_episodes.confidence, excluded.confidence),
        source_ids = excluded.source_ids,
        updated_at = datetime('now')`,
    ).run(
      episodeId,
      input.conversationId,
      input.eventKind,
      input.queryKey,
      input.title,
      firstEventTime,
      lastEventTime,
      input.confidence,
      JSON.stringify(sources),
    );
    this.db.prepare(
      `INSERT OR IGNORE INTO lcm_event_episode_observations (
        episode_id, event_id, ordinal
      ) VALUES (
        ?,
        ?,
        COALESCE((SELECT MAX(ordinal) + 1 FROM lcm_event_episode_observations WHERE episode_id = ?), 0)
      )`,
    ).run(episodeId, input.eventId, episodeId);
    const count = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM lcm_event_episode_observations
       WHERE episode_id = ?`,
    ).get(episodeId) as { count: number };
    this.db.prepare(
      `UPDATE lcm_event_episodes
       SET observation_count = ?, updated_at = datetime('now')
       WHERE episode_id = ?`,
    ).run(count.count, episodeId);
    return episodeId;
  }

  private rebuildEpisode(episodeId: string): void {
    // O(1) aggregate: COUNT, MIN/MAX time, MAX confidence — no row scan into JS.
    const aggregate = this.db.prepare(
      `SELECT
         COUNT(*) AS count,
         MAX(eo.confidence) AS max_confidence
       FROM lcm_event_episode_observations link
       JOIN lcm_event_observations eo ON eo.event_id = link.event_id
       WHERE link.episode_id = ?`,
    ).get(episodeId) as { count: number; max_confidence: number | null };
    if (aggregate.count === 0) {
      this.db.prepare(
        `DELETE FROM lcm_event_episodes
         WHERE episode_id = ?`,
      ).run(episodeId);
      return;
    }
    // Chronologically first row: drives episode-level metadata (conversation,
    // kind, query_key, title) and first_event_time. Single LIMIT 1, not O(N).
    const first = this.db.prepare(
      `SELECT
         eo.conversation_id,
         eo.event_kind,
         eo.title,
         eo.query_key,
         eo.event_time,
         eo.ingest_time
       FROM lcm_event_episode_observations link
       JOIN lcm_event_observations eo ON eo.event_id = link.event_id
       WHERE link.episode_id = ?
       ORDER BY
         julianday(coalesce(eo.event_time, eo.ingest_time)) ASC,
         link.ordinal ASC,
         eo.event_id ASC
       LIMIT 1`,
    ).get(episodeId) as {
      conversation_id: number;
      event_kind: EventObservationKind;
      title: string;
      query_key: string | null;
      event_time: string | null;
      ingest_time: string;
    };
    // Chronologically last row: only needs the time pair for last_event_time.
    const last = this.db.prepare(
      `SELECT
         eo.event_time,
         eo.ingest_time
       FROM lcm_event_episode_observations link
       JOIN lcm_event_observations eo ON eo.event_id = link.event_id
       WHERE link.episode_id = ?
       ORDER BY
         julianday(coalesce(eo.event_time, eo.ingest_time)) DESC,
         link.ordinal DESC,
         eo.event_id DESC
       LIMIT 1`,
    ).get(episodeId) as {
      event_time: string | null;
      ingest_time: string;
    };
    // Newest-first slice for source_ids JSON. Each observation's source_ids
    // blob is itself capped (cap on write at upsertEpisodeFromObservation), so
    // pulling MAX_PERSISTED_EPISODE_SOURCES rows is enough to fill the dedup'd
    // output cap. Keeps rebuild cost O(MAX_PERSISTED_EPISODE_SOURCES), not O(N).
    const sourceRows = this.db.prepare(
      `SELECT
         eo.source_type,
         eo.source_ids
       FROM lcm_event_episode_observations link
       JOIN lcm_event_observations eo ON eo.event_id = link.event_id
       WHERE link.episode_id = ?
       ORDER BY
         julianday(coalesce(eo.event_time, eo.ingest_time)) DESC,
         link.ordinal DESC,
         eo.event_id DESC
       LIMIT ?`,
    ).all(episodeId, MAX_PERSISTED_EPISODE_SOURCES) as Array<{
      source_type: "summary" | "rollup" | "message";
      source_ids: string;
    }>;
    // Walk newest-first and stop once we have enough unique sources, then
    // reverse to restore chronological order. Bounds the JSON blob written to
    // source_ids regardless of how many observations the episode accumulates,
    // avoiding O(N) memory + write amplification on hot episodes.
    const sourcesNewestFirst: EventSource[] = [];
    const sourceSeen = new Set<string>();
    for (const row of sourceRows) {
      for (const source of parseSources(row.source_ids, row.source_type)) {
        const key = `${source.sourceType ?? ""}:${source.sourceId}`;
        if (sourceSeen.has(key)) {
          continue;
        }
        sourceSeen.add(key);
        sourcesNewestFirst.push(source);
        if (sourcesNewestFirst.length >= MAX_PERSISTED_EPISODE_SOURCES) {
          break;
        }
      }
      if (sourcesNewestFirst.length >= MAX_PERSISTED_EPISODE_SOURCES) {
        break;
      }
    }
    const sources = sourcesNewestFirst.reverse();
    const confidence = aggregate.max_confidence ?? 0;
    this.db.prepare(
      `UPDATE lcm_event_episodes
       SET conversation_id = ?,
           episode_kind = ?,
           topic_key = ?,
           title = ?,
           first_event_time = ?,
           last_event_time = ?,
           observation_count = ?,
           confidence = ?,
           source_ids = ?,
           updated_at = datetime('now')
       WHERE episode_id = ?`,
    ).run(
      first.conversation_id,
      first.event_kind,
      first.query_key ?? "uncategorized",
      first.title,
      first.event_time ?? first.ingest_time,
      last.event_time ?? last.ingest_time,
      aggregate.count,
      confidence,
      JSON.stringify(sources),
      episodeId,
    );
  }

  listObservations(input?: {
    conversationId?: number;
    eventKinds?: EventObservationKind[];
    query?: string;
    since?: string;
    before?: string;
    first?: boolean;
    includeSources?: boolean;
    limit?: number;
  }): EventObservation[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (input?.conversationId != null) {
      where.push("conversation_id = ?");
      args.push(input.conversationId);
    }
    if (input?.eventKinds?.length) {
      where.push(`event_kind IN (${placeholders(input.eventKinds)})`);
      args.push(...input.eventKinds);
    }
    const query = normalizeQueryKey(input?.query);
    if (query) {
      const likeQuery = `%${escapeLikePattern(query)}%`;
      // INVARIANT: query_key is stored already lowercased+normalized via
      // normalizeQueryKey() at insert time (see insertObservation). So we
      // compare directly against the column rather than wrapping in
      // lower(coalesce(...)) — that wrapper would prevent SQLite from
      // using lcm_event_observations_query_time_idx and force a scan.
      //
      // The title/description LIKE clauses are inherently full-scan, but
      // their cost is bounded by the time-window filters (since/before)
      // appended below, which select on (event_time, ingest_time).
      where.push(
        "(query_key = ? OR lower(title) LIKE ? ESCAPE '\\' OR lower(coalesce(description, '')) LIKE ? ESCAPE '\\')"
      );
      args.push(query, likeQuery, likeQuery);
    }
    if (input?.since) {
      where.push("coalesce(event_time, ingest_time) >= ?");
      args.push(input.since);
    }
    if (input?.before) {
      where.push("coalesce(event_time, ingest_time) < ?");
      args.push(input.before);
    }
    const limit = clampListLimit(input?.limit, 20, 100);
    const order = input?.first ? "ASC" : "DESC";
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT event_id, conversation_id, event_kind, title, description, query_key,
              event_time, ingest_time, confidence, rationale, source_type, source_id,
              source_ids, created_at, updated_at
       FROM lcm_event_observations
       ${whereSql}
       ORDER BY coalesce(event_time, ingest_time) ${order}, confidence DESC, event_id ASC
       LIMIT ?`,
    ).all(...args, limit) as EventObservationRow[];
    return rows.map((row) => rowToEvent(row, input?.includeSources === true));
  }

  listEpisodes(input?: {
    conversationId?: number;
    eventKinds?: EventObservationKind[];
    query?: string;
    since?: string;
    before?: string;
    first?: boolean;
    includeSources?: boolean;
    limit?: number;
  }): EventEpisode[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (input?.conversationId != null) {
      where.push("conversation_id = ?");
      args.push(input.conversationId);
    }
    if (input?.eventKinds?.length) {
      where.push(`episode_kind IN (${placeholders(input.eventKinds)})`);
      args.push(...input.eventKinds);
    }
    const query = normalizeQueryKey(input?.query);
    if (query) {
      const likeQuery = `%${escapeLikePattern(query)}%`;
      where.push(
        "(topic_key = ? OR lower(title) LIKE ? ESCAPE '\\')"
      );
      args.push(query, likeQuery);
    }
    if (input?.since) {
      where.push("last_event_time >= ?");
      args.push(input.since);
    }
    if (input?.before) {
      where.push("first_event_time < ?");
      args.push(input.before);
    }
    const limit = clampListLimit(input?.limit, 20, 100);
    const order = input?.first ? "ASC" : "DESC";
    const orderColumn = input?.first ? "first_event_time" : "last_event_time";
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT episode_id, conversation_id, episode_kind, topic_key, title,
              first_event_time, last_event_time, observation_count, confidence,
              source_ids, created_at, updated_at
       FROM lcm_event_episodes
       ${whereSql}
       ORDER BY ${orderColumn} ${order}, confidence DESC, episode_id ASC
       LIMIT ?`,
    ).all(...args, limit) as EventEpisodeRow[];
    return rows.map((row) => rowToEpisode(row, input?.includeSources === true));
  }

  /**
   * Canonical path for deleting a single observation outside of a
   * conversation cascade (issue #31).
   *
   * Looks up every episode the observation participates in, deletes the
   * observation row (which cascades through the link table via the FK), and
   * then refreshes each affected episode's aggregate columns by calling
   * `rebuildEpisode()`. If an episode has no remaining observations it is
   * removed by `rebuildEpisode()` itself.
   *
   * No callers today — this exists purely to keep the contract documented
   * in code and to give future call sites a single safe entry point.
   */
  async unlinkObservation(eventId: string): Promise<void> {
    await withDatabaseTransaction(this.db, "BEGIN IMMEDIATE", () => {
      const episodeIds = (
        this.db.prepare(
          `SELECT episode_id
           FROM lcm_event_episode_observations
           WHERE event_id = ?`,
        ).all(eventId) as Array<{ episode_id: string }>
      ).map((row) => row.episode_id);
      // Delete the observation; FK ON DELETE CASCADE wipes link rows.
      this.db.prepare(
        `DELETE FROM lcm_event_observations WHERE event_id = ?`,
      ).run(eventId);
      // Refresh aggregates on every episode that referenced it.
      for (const episodeId of [...new Set(episodeIds)]) {
        this.rebuildEpisode(episodeId);
      }
    });
  }
}
