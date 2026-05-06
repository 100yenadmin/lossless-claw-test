# LCM v4.1 Agent Surface — Live-DB Harness Stress Test Report

**Date**: 2026-05-06
**DB**: VACUUM INTO snapshot of Eva's `~/.openclaw/lcm.db` at `/Volumes/LEXAR/lcm-tmp/agent-harness-2026-05-06/lcm-agent-harness.db`
**Backfill**: 3,841 leaves embedded with voyage-4-large (dim 1024), 4.8M Voyage tokens consumed (~$0.50)
**Method**: 5 parallel Sonnet subagents (one per question type A/B/C/D/E) called the 8 v4.1 LCM tools via Bash through `scripts/lcm-tool-call.mjs` against the snapshot DB

---

## Executive Verdict

| Type | PRIMARY claim from THE_FIVE_QUESTIONS.md | Live-harness result |
|------|------------------------------------------|---------------------|
| A. Time-anchored | 5/5 via `lcm_synthesize_around` | **FAIL without synthesize** — surface CAN triangulate via grep+semantic but loses on (a) recent leaves not yet embedded, (b) verbatim hash queries, (c) aggregation questions ("longest workstream") |
| B. Topic-anchored | 5/5 via `lcm_grep --mode hybrid` + `lcm_semantic_recall` | **PASS** — hybrid+describe combination produced citation-accurate answers on all 4. Stumper "first time we worked on Voyage" required 6 calls (semantic returns by distance not chronology) but answer was correct |
| C. Verbatim | 5/5 via `lcm_grep --mode verbatim` (NEW) | **PARTIAL** — verbatim returns FULL untruncated rows correctly, but the 20-result cap saturates with tool messages; summary-only content invisible; FTS5 syntax brittle (`v4.1`, brackets) |
| D. Pattern-anchored | 2/5 PRIMARY (entity); 3/5 fallback | **FAIL on entities, FAIL on procedure fallback** — entity tools return empty silently (coref worker hasn't run on snapshot); D2/D4 fallback via grep hybrid OK; D1 procedure fallback returned 15 unrelated incidents, not a procedure |
| E. Drilldown | 5/5 via `lcm_describe` (with NEW flags) + `lcm_expand_query` | **PARTIAL** — flags work when DAG has data but silent empty expansion ambiguous; default 5-message cap too low (216-msg leaf returns first 2 minutes); distance scaling issue (>1.0 cosine) |

**Net read on the production claim**: The PR claims 22/25 test cases have PRIMARY coverage. Live-harness data shows the actual figure is closer to **14/25 with high confidence + 8/25 with degradation + 3/25 actually broken**. The cuts (themes/procedures/intentions) leave a real felt gap on D1/D3/D5; the new capabilities (verbatim, expandChildren) work but have edge cases that need fixing before merge.

---

## Bug Triage

### REAL PRODUCTION BUGS (must-fix before merge)

These show up in the production code path, not just the harness wrapper.

| # | Severity | Component | Bug | Source agent |
|---|----------|-----------|-----|--------------|
| P1 | HIGH | `runBackfillTick` autostart | Embedding backfill recency gap — leaves written after the autostart's last tick are invisible to `lcm_semantic_recall` and the semantic arm of hybrid grep. Manifested as: queries scoped to May 5–6 returned 1 hit when 15+ existed in FTS. | A, A6, A7 |
| P2 | HIGH | `lcm_semantic_recall` distance metric | Returned distances 1.05–1.08 — impossible for cosine on unit vectors (should be ≤2.0 angular, but clustering at 1.0 strongly suggests un-normalized L2 distance). Any threshold-based downstream logic is broken. | E |
| P3 | HIGH | `lcm_semantic_recall` output shape | No "low confidence" / "no good match" warning when distances are all >0.9. An agent treating the top result as the answer to E1 ("source of +52.5pp claim") is confidently wrong because the actual source isn't in the DB. | E |
| P4 | HIGH | `lcm_describe expandChildren` | Silent empty expansion — agent cannot distinguish (a) node has 0 children (b) all children suppressed (c) terminal condensed. Need explicit signal in the response: `"childrenStatus": "empty\|all-suppressed\|capped"`. | E |
| P5 | MED | `lcm_describe expandMessages` | Default cap of 5 too low for typical 100–250 message leaves. Returns first ~2 minutes of a 2-hour session, agent treats it as representative. Recommend: default 20 + add `messageOffset` for pagination. | E |
| P6 | MED | `lcm_grep --mode verbatim` | 20-result cap saturates with tool-role messages on common queries. No `role` filter parameter. Conversational-recall queries reliably return wrong message type. Add `role: 'user'\|'assistant'\|'tool'\|'all'` parameter. | C |
| P7 | MED | `lcm_grep` FTS5 syntax | `v4.1`, `lcm_recent` (compound), and bracket characters break MATCH. No pre-escape; users hit opaque `fts5: syntax error`. Add automatic FTS5 escape for non-regex modes, or a `phrase: true` flag. | C |
| P8 | MED | `lcm_search_entities` empty silent | Returns empty without distinguishing "0 entities indexed (coref worker not run)" vs "0 results for query." Should expose coverage status. | D |
| P9 | LOW | `lcm_grep --mode regex` 100-hit cap | Pattern-frequency / aggregation questions ("most-mentioned tool") fail because cap blocks counting. Consider: add `count: true` flag that returns count without rows. | D |
| P10 | LOW | `lcm_semantic_recall` no `orderBy` | Returns by distance only. "First time we did X" stumpers required 6 calls walking backward. Add `orderBy: 'distance' \| 'createdAt' \| 'createdAtDesc'`. | B |

### HARNESS-ONLY BUGS (fix in `scripts/lcm-tool-call.mjs`, not blocking PR)

| # | Bug | Source agent |
|---|-----|--------------|
| H1 | `lcm_describe` completely broken — `getConversationFamilyIds` shim takes positional `conversationId` but production passes `({conversationId, sessionKey})`. Object-param signature mismatch. | A |
| H2 | Header docs advertise `scope: 'session_family'\|'all'` and `minScore` for `lcm_semantic_recall` — actual schema uses `allConversations: boolean`. Misleading docs cost subagents calls. | A, D |
| H3 | Header example uses `pattern` for `lcm_grep` but tool description doesn't surface that and doesn't surface required `allConversations` flag for harness session key. | D |

### DOCUMENTATION GAPS (fix in `THE_FIVE_QUESTIONS.md` + `PR_DESCRIPTION.md`)

- "Adequate fallback" claim for D1/D3/D5 (procedures/themes) is **optimistic** based on D1 result (15 unrelated incidents, no actual procedure). Restate as "degraded fallback — knowledge atomized across incidents."
- Type A "5/5 PRIMARY" assumes `lcm_synthesize_around` works, but it requires LLM creds. Acknowledge that the harness CAN'T test it; production end-to-end test needed.
- Type C and Type E PRIMARY claims need caveats about caps and edge cases.

---

## What WORKED (positive findings)

1. **Voyage hybrid + rerank produces real lift on paraphrastic queries**. Type B subagent: B1 "worker_threads heartbeat isolation" → confident negative via regex; B3 "race condition like empty-plan-body" → found the SQLite txn-within-txn bootstrap race [sum_5b65585dd82939b9] with score 0.72 from FTS+semantic fusion. Type D Voyage query: hybrid surfaced sum_85205b121b480ca3 at score 0.816, and the FTS arm caught a March 2026 production state audit that semantic alone pushed to position 10+.
2. **`lcm_grep --mode verbatim` returns full untruncated content**. Confirmed `details.hits[].content` carries unclipped messages; harness wrapper truncates the rendered text but raw content is intact (38KB on a single call).
3. **Citation reliability is high**. Every `sum_xxx` ID returned by grep was traceable via direct DB inspection. No phantom IDs.
4. **`expandMessages` faithfulness check passed** on the leaf we drilled into (sum_0c46837279259f3b — "lcm_recent build session"): the leaf summary accurately captured the parallel subagent dispatch, FTS5 gating bug discovered early, and PR status from the actual messages.
5. **Lineage traversal works correctly**. STUMPER-E6 traversed leaf → parent condensed → grandparent → root and verified content faithfulness all the way up.

---

## Stumper Outcomes

| Stumper | Result |
|---------|--------|
| A6 "longest workstream this month" | UNANSWERABLE — no aggregation tool exists. Triangulated via hit distribution that conv 1866 (LCM upstream PR work, 16 days) was likely longest |
| A7 "April 8, 846 leaves" | The "846 leaves" stat itself is meta about the DB and not stored. Topic dominance ("cache-keep-warm sprint") was correctly recovered via regex |
| B6 "first time we worked on Voyage" | Found 2026-03-09 22:42 UTC [sum_fee66776b06ae4e8] via 6-call backward walk. `lcm_semantic_recall` sort-by-distance failed; required time-windowed regex |
| C6 "Eva's exact words demanding first-principles pass" | UNANSWERABLE — terms `themes`/`procedures`/`intentions` don't co-occur in any message in this snapshot |
| D6 "most-mentioned tool besides lcm_grep" | Required raw SQL; tool surface couldn't aggregate. Answer: `lcm_recent` (438 mentions) — interesting because v4.1 cut it but live DB shows heavy v3-era usage |
| E6 "leaf → describe → expand → walk lineage" | PASS end-to-end. Lineage intact, content faithful, no DAG bugs |

---

## Recommended Next Actions

1. **Fix harness wrapper bugs (H1–H3)** so the harness produces clean signal in subsequent test rounds. ~1 hr.
2. **Fix production HIGH bugs (P1–P4)**:
   - P1 backfill recency: autostart loop should keep ticking when new leaves arrive, not just at startup
   - P2 distance metric: investigate cosine-vs-L2; if vectors aren't unit-normed, fix at write
   - P3 confidence floor: add `confidence: 'high' | 'low' | 'no-match'` based on top-distance threshold
   - P4 expandChildren signal: distinguish empty/suppressed/capped explicitly
   ~3–5 hrs.
3. **Fix MED bugs (P5–P8)**: cap defaults, role filter, FTS5 escape, entity coverage status. ~2 hrs.
4. **Re-run harness** with fixes applied; confirm Type A/C/D pass cleanly.
5. **Run Phase 4 deep adversarial audit** (5–10 Opus 1M-context agents) on post-fix code. Per Eva: "make sure no bugs exist and it's ready for production."
6. **Update PR_DESCRIPTION.md + THE_FIVE_QUESTIONS.md** to reflect honest fallback degradation on D1/D3/D5.

---

## Honest Disclosure for the PR

The "22/25 PRIMARY coverage" headline holds only when:
- `lcm_synthesize_around` is available (requires LLM creds — not in harness)
- Voyage backfill is current to the moment (recency gap is a real bug, P1)
- The query target is in the DB (C4 and C6 unanswerable because never ingested)
- The agent knows when to pivot from entity tool → grep fallback (silent empty entity returns mislead)

The real PR claim should be: **"22/25 PRIMARY coverage in the design; 14/25 verified working on a live-DB harness with the cuts in place; 8/25 work with degraded UX; 3/25 are coverage gaps from cut features (themes/procedures/intentions) that ship in draft #616."**
