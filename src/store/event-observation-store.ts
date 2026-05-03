import type { DatabaseSync } from "node:sqlite";

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
  sources?: Array<{ sourceType: "summary" | "rollup" | "message"; sourceId: string }>;
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

const MAX_EPISODE_SOURCES = 20;

// Cap source_ids JSON blob on write to avoid unbounded growth on hot episodes.
// MAX_EPISODE_SOURCES * 2 leaves headroom over the read-side slice while bounding
// memory + write amplification to O(1) per upsert instead of O(N) over lifetime.
const MAX_PERSISTED_EPISODE_SOURCES = MAX_EPISODE_SOURCES * 2;

// Monotonic counter for SAVEPOINT identifiers. Avoids interpolating user/row
// data into SQL identifiers and isolates nested savepoints from each other.
let upsertObservationCounter = 0;

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}


function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (part) => `\\${part}`);
}

function normalizeSourceIds(sourceIds: string[] | undefined, fallbackSourceId: string): string[] {
  return [
    ...new Set(
      [fallbackSourceId, ...(sourceIds ?? [])]
        .map((sourceId) => sourceId.trim())
        .filter((sourceId) => sourceId.length > 0)
    ),
  ];
}

function normalizeQueryKey(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  const pr =
    /^(?:pr|pull request)\s*#?\s*(\d{1,6})$/.exec(normalized) ??
    /^pr[-\s#]*(\d{1,6})$/.exec(normalized);
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

export class EventObservationStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertObservation(input: EventObservationInput): void {
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
    const queryKey = normalizeQueryKey(input.queryKey) ?? "uncategorized";
    // Wrap all writes atomically so concurrent ingestion of two events into the
    // same (conversationId, eventKind, queryKey) cannot race on MAX(ordinal)+1
    // or the rebuildEpisode UPDATE, and a crash mid-sequence cannot leave orphan
    // link rows with stale observation_count. Use BEGIN IMMEDIATE when not
    // already in a transaction (e.g. direct store callers); use a SAVEPOINT
    // when nested inside withSummarySavepoint (extractor path).
    const nested = this.db.isTransaction;
    const savepoint = nested ? `lcm_upsert_obs_${++upsertObservationCounter}` : null;
    if (nested) {
      this.db.exec(`SAVEPOINT ${savepoint}`);
    } else {
      this.db.exec("BEGIN IMMEDIATE");
    }
    try {
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
        input.eventTime ?? null,
        input.ingestTime,
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
        eventTime: input.eventTime ?? input.ingestTime,
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
      if (nested) {
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else {
        this.db.exec("COMMIT");
      }
    } catch (error) {
      try {
        if (nested) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.db.exec("ROLLBACK");
        }
      } catch {
        // ignore rollback failure (e.g. when already rolled back); rethrow original
      }
      throw error;
    }
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
    const rows = this.db.prepare(
      `SELECT
         eo.event_id,
         eo.conversation_id,
         eo.event_kind,
         eo.title,
         eo.query_key,
         eo.event_time,
         eo.ingest_time,
         eo.confidence,
         eo.source_type,
         eo.source_ids
       FROM lcm_event_episode_observations link
       JOIN lcm_event_observations eo ON eo.event_id = link.event_id
       WHERE link.episode_id = ?
       ORDER BY
         julianday(coalesce(eo.event_time, eo.ingest_time)) ASC,
         link.ordinal ASC,
         eo.event_id ASC`,
    ).all(episodeId) as Array<{
      event_id: string;
      conversation_id: number;
      event_kind: EventObservationKind;
      title: string;
      query_key: string | null;
      event_time: string | null;
      ingest_time: string;
      confidence: number;
      source_type: "summary" | "rollup" | "message";
      source_ids: string;
    }>;
    if (rows.length === 0) {
      this.db.prepare(
        `DELETE FROM lcm_event_episodes
         WHERE episode_id = ?`,
      ).run(episodeId);
      return;
    }
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    // Walk rows newest-first and stop once we have enough unique sources, then
    // reverse to restore chronological order. This bounds the JSON blob written
    // to source_ids regardless of how many observations the episode accumulates,
    // avoiding O(N) memory + write amplification on hot episodes.
    const sourcesNewestFirst: EventSource[] = [];
    const sourceSeen = new Set<string>();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
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
    const confidence = Math.max(...rows.map((row) => row.confidence));
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
      rows.length,
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
      where.push("julianday(coalesce(event_time, ingest_time)) >= julianday(?)");
      args.push(input.since);
    }
    if (input?.before) {
      where.push("julianday(coalesce(event_time, ingest_time)) < julianday(?)");
      args.push(input.before);
    }
    const limit = Math.max(1, Math.min(input?.limit ?? 20, 100));
    const order = input?.first ? "ASC" : "DESC";
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT event_id, conversation_id, event_kind, title, description, query_key,
              event_time, ingest_time, confidence, rationale, source_type, source_id,
              source_ids, created_at, updated_at
       FROM lcm_event_observations
       ${whereSql}
       ORDER BY julianday(coalesce(event_time, ingest_time)) ${order}, confidence DESC
       LIMIT ?`,
    ).all(...args, limit) as EventObservationRow[];
    return rows.map((row) => rowToEvent(row, input?.includeSources === true));
  }
}
