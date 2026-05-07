/**
 * Shared per-tool result-size budget — Wave-12 audit (W1A1 #2 + W1A8 #3).
 *
 * Single source of truth for the operator-tunable env knob
 * `LCM_TOOL_RESULT_TOKEN_BUDGET` (token cap on any single LCM tool's
 * emitted result). Both per-tool MAX_RESULT_CHARS truncation AND the
 * needs-compact gate's HARD_CAP estimator pull from this module so the
 * two stay in lockstep — raising the env knob now raises the estimator
 * ceiling automatically (previously the gate underestimated by up to
 * 3× when the operator raised the env knob, since estimator's
 * HARD_CAP_TOKENS was hard-coded at 10_000).
 *
 * Floor is 2_000 tokens (8K chars) — anything smaller makes most tools
 * useless. Caller-facing default 10_000 tokens (40K chars) matches the
 * behavior before the W1A1 amendment.
 *
 * Resolved ONCE at module load; env changes during process lifetime
 * have no effect (matches prior lcm-grep-tool behavior; documented).
 */

const FLOOR_TOKENS = 2_000;
const DEFAULT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;

function resolveResultTokenBudget(): number {
  const raw = process.env.LCM_TOOL_RESULT_TOKEN_BUDGET?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const tokens = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKENS;
  return Math.max(FLOOR_TOKENS, tokens);
}

/**
 * Resolved token cap. Identity for the estimator's HARD_CAP_TOKENS.
 */
export const MAX_RESULT_TOKENS = resolveResultTokenBudget();

/**
 * Per-tool char-truncation cap. Tools loop their accumulator and emit a
 * truncation notice line when crossed.
 */
export const MAX_RESULT_CHARS = MAX_RESULT_TOKENS * CHARS_PER_TOKEN;

/**
 * Standardized truncation-notice line for tools to emit when they cap.
 * `reasonHint` is a short verb phrase (e.g. "narrow query, lower limit")
 * that's tool-specific. Formatted to mirror the message style established
 * by lcm_grep so agents see consistent guidance across tools.
 */
export function truncationNotice(reasonHint: string): string {
  return `*(truncated at ~${Math.round(MAX_RESULT_TOKENS)} tokens to protect agent context — ${reasonHint}; raise LCM_TOOL_RESULT_TOKEN_BUDGET env to increase the cap)*`;
}

/**
 * For unit tests that need to verify env-knob propagation. Module-level
 * consts are captured at load — exposing this helper lets tests assert the
 * resolution math without importing the env-load itself.
 */
export function __resolveResultTokenBudgetForTesting(): number {
  return resolveResultTokenBudget();
}
