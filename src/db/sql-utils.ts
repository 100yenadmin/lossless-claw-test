/**
 * Small SQL string helpers shared between stores.
 *
 * Extracted from the duplicate `placeholders` and `escapeLikePattern`
 * definitions that previously lived in `observed-work-store.ts`,
 * `event-observation-store.ts`, `full-text-fallback.ts`, and
 * `summary-store.ts` (issue #30).
 */

/**
 * Render `?, ?, ?` for a values array (used for IN-list parameter binding).
 *
 * Hardened to reject empty input — an empty `IN ()` clause is a SQL syntax
 * error in SQLite, so an early throw turns a latent bug into a loud one
 * (issue #30).
 */
export function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error("placeholders() requires non-empty input");
  }
  return values.map(() => "?").join(", ");
}

/**
 * Escape `%`, `_`, and `\` for use inside a LIKE pattern.
 *
 * The caller is expected to pair the resulting pattern with `ESCAPE '\\'`
 * in the SQL statement.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

/**
 * Coerce a caller-supplied limit into a finite positive integer in `[1, max]`.
 *
 * Guards against `NaN` / `Infinity` / non-number inputs so the value bound to a
 * SQL `LIMIT ?` placeholder is never `NaN` (which throws at bind time on
 * node:sqlite) and never propagates `NaN` through `Math.min`/`Math.max`
 * (those return `NaN` if either operand is `NaN`).
 *
 * Issue #56 — six sites previously used `Math.max(1, Math.min(value, max))`
 * which returns `NaN` for non-finite inputs. Route them through this helper.
 */
export function clampListLimit(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
  // If the fallback itself is non-finite, treat as 1; the caller is misusing
  // the helper but a clamp should never propagate NaN to the SQL layer.
  const safeNumeric = Number.isFinite(numeric) ? numeric : 1;
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.trunc(max) : 1;
  return Math.max(1, Math.min(safeNumeric, safeMax));
}
