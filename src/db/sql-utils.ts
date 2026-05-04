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
