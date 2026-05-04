import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";

export type LcmConversationScope = {
  conversationId?: number;
  conversationIds?: number[];
  allConversations: boolean;
  /**
   * All conversation IDs under the same session_key as the resolved
   * conversationId, ordered newest-first by created_at. Includes
   * `conversationId` itself plus any archived/rotated predecessors.
   *
   * Used by lcm_recent and other read-side tools to span /new and /reset
   * boundaries — the whole point of LCM is being lossless across session
   * lifecycle events.
   *
   * Empty array if no session_key was used for resolution (eg. explicit
   * `conversationId` parameter).
   */
  relatedConversationIds: number[];
};

type ConversationScopeStore = ReturnType<LcmContextEngine["getConversationStore"]> & {
  getConversationForSession?: (input: {
    sessionId?: string;
    sessionKey?: string;
  }) => Promise<{ conversationId: number; sessionKey?: string | null } | null>;
  getConversationBySessionKey?: (
    sessionKey: string,
  ) => Promise<{ conversationId: number; sessionKey?: string | null } | null>;
  listConversationsBySessionKey?: (
    sessionKey: string,
  ) => Promise<Array<{ conversationId: number }>>;
  getConversationFamilyIds?: (input: {
    conversationId?: number;
    sessionId?: string;
    sessionKey?: string;
  }) => Promise<number[]>;
};

async function lookupConversationForSession(input: {
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ conversationId: number; sessionKey?: string | null } | null> {
  const store = input.lcm.getConversationStore() as ConversationScopeStore;

  if (typeof store.getConversationForSession === "function") {
    return store.getConversationForSession({
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
    });
  }

  const normalizedSessionKey = input.sessionKey?.trim();
  if (normalizedSessionKey && typeof store.getConversationBySessionKey === "function") {
    const byKey = await store.getConversationBySessionKey(normalizedSessionKey);
    if (byKey) {
      return byKey;
    }
  }

  const normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId) {
    return null;
  }

  return store.getConversationBySessionId(normalizedSessionId);
}

/**
 * Parse an ISO-8601 timestamp tool parameter into a Date.
 *
 * Throws when the value is not a parseable timestamp string.
 */
export function parseIsoTimestampParam(
  params: Record<string, unknown>,
  key: string,
): Date | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${key} must be a valid ISO timestamp.`);
  }
  return parsed;
}

/**
 * Resolve LCM conversation scope for tool calls.
 *
 * Priority:
 * 1. Explicit conversationId parameter
 * 2. allConversations=true (cross-conversation mode)
 * 3. Current session's LCM conversation
 */
export async function resolveLcmConversationScope(input: {
  lcm: LcmContextEngine;
  params: Record<string, unknown>;
  sessionId?: string;
  sessionKey?: string;
  deps?: Pick<LcmDependencies, "resolveSessionIdFromSessionKey">;
}): Promise<LcmConversationScope> {
  const { lcm, params } = input;

  const explicitConversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? Math.trunc(params.conversationId)
      : undefined;
  if (explicitConversationId != null) {
    return {
      conversationId: explicitConversationId,
      conversationIds: [explicitConversationId],
      allConversations: false,
      relatedConversationIds: [],
    };
  }

  if (params.allConversations === true) {
    return {
      conversationId: undefined,
      conversationIds: undefined,
      allConversations: true,
      relatedConversationIds: [],
    };
  }

  const normalizedSessionKey = input.sessionKey?.trim();
  if (normalizedSessionKey) {
    const bySessionKey =
      await lcm.getConversationStore().getConversationBySessionKey(normalizedSessionKey);
    if (bySessionKey) {
      const familyIds = await collectFamilyConversationIds({
        lcm,
        conversationId: bySessionKey.conversationId,
        sessionKey: normalizedSessionKey,
      });
      const effectiveFamily = familyIds.length > 0 ? familyIds : [bySessionKey.conversationId];
      return {
        conversationId: bySessionKey.conversationId,
        conversationIds: effectiveFamily,
        allConversations: false,
        relatedConversationIds: effectiveFamily,
      };
    }
  }

  let normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId && normalizedSessionKey && input.deps) {
    normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(normalizedSessionKey);
  }
  if (!normalizedSessionId && !input.sessionKey?.trim()) {
    return {
      conversationId: undefined,
      conversationIds: undefined,
      allConversations: false,
      relatedConversationIds: [],
    };
  }

  const conversation = await lookupConversationForSession({
    lcm,
    sessionId: normalizedSessionId,
    sessionKey: input.sessionKey,
  });
  if (!conversation) {
    return {
      conversationId: undefined,
      conversationIds: undefined,
      allConversations: false,
      relatedConversationIds: [],
    };
  }

  // Resolve a session_key for cross-conversation aggregation. We try the
  // explicit input.sessionKey first, then fall back to the session_key on the
  // resolved conversation row itself — this matters when the lookup happened
  // via sessionId and we still want to span /new and /reset boundaries under
  // the same agent. The whole point of LCM being lossless is crossing
  // conversation lifecycle events.
  const resolvedSessionKey =
    normalizedSessionKey ?? conversation.sessionKey?.trim() ?? undefined;
  const familyIds = await collectFamilyConversationIds({
    lcm,
    conversationId: conversation.conversationId,
    sessionId: normalizedSessionId,
    sessionKey: resolvedSessionKey,
  });
  const effectiveFamily = familyIds.length > 0 ? familyIds : [conversation.conversationId];
  return {
    conversationId: conversation.conversationId,
    conversationIds: effectiveFamily,
    allConversations: false,
    relatedConversationIds: effectiveFamily,
  };
}

/**
 * Resolve the full conversation family (active + archived siblings sharing a
 * stable session identity). Prefers PR #338's `getConversationFamilyIds`
 * (which works for both session_key and session_id paths), and falls back to
 * v0.9.4's `listConversationsBySessionKey` when the new helper is absent
 * (eg. test mocks that only stub the older shim).
 *
 * Returns an empty array when neither helper is available — callers must
 * fall back to the singleton `[conversationId]` themselves.
 */
async function collectFamilyConversationIds(input: {
  lcm: LcmContextEngine;
  conversationId?: number;
  sessionId?: string;
  sessionKey?: string;
}): Promise<number[]> {
  const store = input.lcm.getConversationStore() as ConversationScopeStore;
  if (typeof store.getConversationFamilyIds === "function") {
    return store.getConversationFamilyIds({
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
    });
  }
  const sessionKey = input.sessionKey?.trim();
  if (sessionKey && typeof store.listConversationsBySessionKey === "function") {
    const records = await store.listConversationsBySessionKey(sessionKey);
    return records.map((record) => record.conversationId);
  }
  return [];
}
