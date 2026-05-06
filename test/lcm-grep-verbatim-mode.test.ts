import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import type { LcmDependencies } from "../src/types.js";

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) return null;
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
}

function makeDeps(overrides?: Partial<LcmDependencies>): LcmDependencies {
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
      autoRotateSessionFiles: {
        enabled: true,
        sizeBytes: 2 * 1024 * 1024,
        startup: "rotate",
        runtime: "rotate",
      },
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(),
    callGateway: vi.fn(async () => ({})),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    ...overrides,
  } as LcmDependencies;
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: true, seedDefaultPrompts: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'agent:main:main')`).run();
  return db;
}

function insertMessage(
  db: DatabaseSync,
  args: {
    messageId: number;
    conversationId?: number;
    role?: string;
    content: string;
    suppressedAt?: string | null;
    createdAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at, suppressed_at, identity_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.messageId,
    args.conversationId ?? 1,
    args.messageId,
    args.role ?? "user",
    args.content,
    Math.ceil(args.content.length / 4),
    args.createdAt ?? new Date().toISOString(),
    args.suppressedAt ?? null,
    `hash_${args.messageId}`,
  );
  // messages_fts is standalone (not contentless) and not auto-synced via
  // triggers in this codebase — we mirror the schema's bulk-seed pattern
  // for test inserts. Without this, FTS5 MATCH queries return 0 hits.
  db.prepare(
    `INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`,
  ).run(args.messageId, args.content);
}

function buildLcmEngine(db: DatabaseSync, timezone = "UTC") {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    timezone,
    getDb: () => db,
    getRetrieval: () => ({
      grep: vi.fn(),
      expand: vi.fn(),
      describe: vi.fn(),
    }),
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn(),
      getConversationBySessionKey: vi.fn(),
      getConversationFamilyIds: vi.fn(async () => [1]),
    }),
  };
}

describe("createLcmGrepTool — verbatim mode", () => {
  it("returns FULL untruncated message content (not snippets)", async () => {
    const db = setupDb();
    const longContent =
      "This is a very long message that exceeds the normal 200-character snippet limit. " +
      "It contains specific phrasing about race conditions in the empty plan body fix that " +
      "Eva would want to quote verbatim — the literal wording matters here for citation purposes, " +
      "and snippet truncation would lose the specific terminology she used.";
    insertMessage(db, { messageId: 1, content: longContent });

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      pattern: "race condition",
      mode: "verbatim",
      conversationId: 1,
    });
    const details = r.details as {
      mode: string;
      totalMatches: number;
      hits: Array<{ messageId: number; content: string }>;
    };
    expect(details.mode).toBe("verbatim");
    expect(details.totalMatches).toBe(1);
    expect(details.hits[0]!.content).toBe(longContent); // FULL content, not snippet
    expect(details.hits[0]!.content.length).toBeGreaterThan(200);

    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("**Mode:** verbatim");
    expect(text).toContain(longContent); // verbatim text inlined in markdown output

    db.close();
  });

  it("hard-caps at 20 results even if user requests more", async () => {
    const db = setupDb();
    for (let i = 1; i <= 30; i++) {
      insertMessage(db, { messageId: i, content: `Race condition message ${i}` });
    }

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      pattern: "race",
      mode: "verbatim",
      limit: 100, // user asks for 100 → still capped at 20
      conversationId: 1,
    });
    const details = r.details as { hits: unknown[] };
    expect(details.hits.length).toBeLessThanOrEqual(20);

    db.close();
  });

  it("filters suppressed_at IS NOT NULL messages", async () => {
    const db = setupDb();
    insertMessage(db, { messageId: 1, content: "race condition visible message" });
    insertMessage(db, {
      messageId: 2,
      content: "race condition suppressed message",
      suppressedAt: new Date().toISOString(),
    });

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      pattern: "race condition",
      mode: "verbatim",
      conversationId: 1,
    });
    const details = r.details as { hits: Array<{ messageId: number }> };
    expect(details.hits).toHaveLength(1);
    expect(details.hits[0]!.messageId).toBe(1);

    db.close();
  });

  it("returns empty result with helpful message when no matches", async () => {
    const db = setupDb();
    insertMessage(db, { messageId: 1, content: "irrelevant content" });

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      pattern: "nonexistent",
      mode: "verbatim",
      conversationId: 1,
    });
    const details = r.details as { totalMatches: number };
    expect(details.totalMatches).toBe(0);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("No verbatim matches");

    db.close();
  });

  it("respects since/before time filters", async () => {
    const db = setupDb();
    insertMessage(db, {
      messageId: 1,
      content: "race condition old",
      createdAt: "2026-01-01T00:00:00Z",
    });
    insertMessage(db, {
      messageId: 2,
      content: "race condition new",
      createdAt: "2026-05-01T00:00:00Z",
    });

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      pattern: "race",
      mode: "verbatim",
      since: "2026-04-01T00:00:00Z",
      conversationId: 1,
    });
    const details = r.details as { hits: Array<{ messageId: number }> };
    expect(details.hits).toHaveLength(1);
    expect(details.hits[0]!.messageId).toBe(2);

    db.close();
  });

  // P6 harness fix (2026-05-06): the 20-result cap was saturating with
  // tool-role messages on common queries, crowding out user/assistant turns.
  // The new `role` param filters at the SQL layer.
  it("role='user' filter restricts to user messages only", async () => {
    const db = setupDb();
    // Insert a mix of roles all matching the same pattern.
    insertMessage(db, { messageId: 1, role: "tool", content: "race condition tool blob 1" });
    insertMessage(db, { messageId: 2, role: "tool", content: "race condition tool blob 2" });
    insertMessage(db, { messageId: 3, role: "user", content: "race condition user query" });
    insertMessage(db, {
      messageId: 4,
      role: "assistant",
      content: "race condition assistant turn",
    });

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      pattern: "race",
      mode: "verbatim",
      role: "user",
      conversationId: 1,
    });
    const details = r.details as { hits: Array<{ messageId: number; role: string }> };
    expect(details.hits).toHaveLength(1);
    expect(details.hits[0]!.role).toBe("user");
    expect(details.hits[0]!.messageId).toBe(3);

    db.close();
  });

  // P7 harness fix: FTS5 chokes on bare dots/brackets/leading-hyphens.
  // The tool now auto-quotes problematic patterns so they don't crash.
  it("auto-sanitizes patterns with dots so FTS5 doesn't crash (e.g. v4.1)", async () => {
    const db = setupDb();
    insertMessage(db, { messageId: 1, content: "v4.1 architecture decision" });

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    // Pre-fix this would throw "fts5: syntax error"; post-fix it auto-quotes
    // to "v4.1" and matches the inserted message.
    const r = await tool.execute("c", {
      pattern: "v4.1",
      mode: "verbatim",
      conversationId: 1,
    });
    const details = r.details as { totalMatches: number; hits: Array<{ messageId: number }> };
    expect(details.totalMatches).toBe(1);
    expect(details.hits[0]!.messageId).toBe(1);

    db.close();
  });
});
