/**
 * Small SQL string helpers shared between stores.
 *
 * Extracted from the duplicate `placeholders` definitions that previously
 * lived in `observed-work-store.ts` and `event-observation-store.ts`.
 */

/** Render `?, ?, ?` for a values array (used for IN-list parameter binding). */
export function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}
