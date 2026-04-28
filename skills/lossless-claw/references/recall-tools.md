# Recall Tools

Use recall tools when the answer depends on historical evidence from compacted conversation history.

## Tool selection

### `lcm_recent`

Use first for time-native episodic recall: when the user asks what happened **today**, **yesterday**, **this week**, **this month**, or inside a local-time window.

Good prompts for `lcm_recent`:

- "What did we do yesterday?" → `period: "yesterday"`
- "What happened yesterday afternoon?" → `period: "yesterday afternoon"`
- "What happened after the restart?" → `period: "last 3h"` or the known clock range
- "What were we doing between 4 and 8pm?" → `period: "yesterday 4-8pm"`
- "What shipped this week?" → `period: "week"` or `period: "7d"`
- "What were the open threads this month?" → `period: "month"`

Why use it:

- It answers timeline-shaped questions without keyword guessing.
- It uses prebuilt day/week/month rollups when available.
- It falls back to bounded source summaries for precise windows.
- It keeps provenance available so you can drill down when exact evidence is needed.

Do not use it for:

- keyword discovery when the time range is unknown
- exact source-level proof by itself; follow with `lcm_describe`, `lcm_expand`, or `lcm_expand_query` when precision matters

### `lcm_grep`

Use for:

- finding whether a term, file name, error string, PR number, customer name, or identifier appears in compacted history
- narrowing the search space when the question is keyword-shaped rather than time-shaped

Do not use it for:

- timeline questions like "what happened yesterday afternoon?"; start with `lcm_recent` instead
- answering detail-heavy questions by itself

### `lcm_describe`

Use for:

- inspecting a specific summary or stored-file record by ID
- reading lineage and content for a known summary node

Do not use it for:

- broad discovery when you do not know the target ID yet

### `lcm_expand_query`

Use for:

- focused questions that need richer detail recovered from summaries
- evidence-oriented follow-up after `lcm_recent`, `lcm_grep`, or `lcm_describe`

This is the best recall tool when the user asks for:

- exact commands
- exact file paths
- precise timestamps
- root-cause chains
- proof or citations from the recovered history

### `lcm_expand`

Treat as a specialized expansion flow for known summary IDs, not the default first step.

### `lcm_rollup_debug`

Use for operator/debugging work only:

- checking whether day/week/month rollups exist for a conversation
- inspecting rollup freshness, source IDs, and provenance chains
- diagnosing why `lcm_recent` fell back to source summaries instead of a prebuilt rollup

Do not use it for normal user-facing recall unless you are debugging the LCM layer itself.

## Recommended workflow

### Time-shaped question

Examples: "what happened yesterday?", "what did we do after lunch?", "what shipped this week?"

1. Start with `lcm_recent` for the smallest useful period/window.
2. If the answer needs proof, inspect the returned source IDs with `lcm_describe` or expand them.
3. Use `lcm_expand_query` only when synthesis across the returned sources is needed.

### Keyword-shaped question

Examples: "find the Eric ENOTEMPTY incident", "where did we mention PR #15?"

1. Start with `lcm_grep` using 1-3 distinctive terms.
2. Use `lcm_describe` when you have a promising summary/file ID.
3. Use `lcm_expand_query` when the answer requires precise recovery rather than a high-level summary.

### Mixed time + topic question

Examples: "what happened with Eric yesterday afternoon?", "what did we decide about LCM this week?"

1. Start with `lcm_recent` to bound the period.
2. If the result is too broad, use `lcm_grep` inside the likely topic terms or expand the returned sources.
3. Finish with `lcm_expand_query` only if the user needs a synthesized answer with exact details.

## Important guardrail

Do not infer exact details from summaries alone when the user needs evidence. Expand first or state that the answer still needs expansion.
