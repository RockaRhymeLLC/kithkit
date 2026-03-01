# Bob Review — Dispositions

## CRITICAL items

1. **Race condition between extraction and curation** → ACCEPT. But: use simpler fix than a processing_lock column. Curation runs at 5am. Extraction runs per-turn. Window for conflict is tiny. Fix: curation task takes a snapshot of memory IDs at start and only operates on those IDs. New memories inserted during curation are ignored until next run.

2. **Vector search unavailability fallback** → ACCEPT. If `store-if-unique` returns non-2xx, fall back to plain `store`. Accept possible duplicates; curation cleans up later.

3. **Embedding generation failure in store-if-unique** → ACCEPT. If embedding fails, store anyway (skip dedup). Log a warning. Non-fatal.

4. **Curation merge verification** → ACCEPT. Verify merged content before deleting. Store merge first, verify it exists, then delete originals in a transaction.

5. **last_accessed batch update** → ACCEPT. Use single `UPDATE ... WHERE id IN (...)` statement.

## IMPORTANT items

1. **Haiku can't call store-if-unique** → ACCEPT. Change approach: keep extraction hook using `/api/memory/store` as before. Add dedup logic INSIDE the store endpoint itself (check similarity before insert). This is simpler — no prompt changes needed.

2. **0.85 threshold configurable** → DEFER. Hardcode for now, make configurable later. Not worth the complexity for v1.

3. **20 merge ops limit** → ACCEPT as-is. Manual trigger via `POST /api/tasks/memory-consolidation/run` covers bulk cleanup.

4. **Memory injection via bash vs Claude** → REJECT. Bash output injection works fine for session-start (already proven pattern). Adding another API call adds latency to session start.

5. **Orchestrator memory search enforced** → ACCEPT. Inject memory results directly into the orchestrator spawn prompt rather than hoping the LLM follows instructions.

6. **Failed orchestrator job memories** → DEFER. Low risk — extraction only fires if session completes normally (Stop hook). Crashed sessions don't trigger Stop.

7. **Memory quality gates** → DEFER. The extraction prompt is already very conservative. Add quality checks in v2 if junk accumulates.

## MINOR items

All noted. Will address:
- #3 (source tracking): Use the hook JSON input which includes session info
- #4 (curation logging): Add summary logging

## Revised approach

Key design change based on Bob's feedback:
- **Dedup at the API level, not the extraction hook level.** Add similarity check inside `POST /api/memory/store` itself (optional, controlled by a `dedup` field in the request body). This is cleaner than a separate endpoint.
- **Phase the work**: extraction + schema + session loading first, curation second. But implement both in this PR since the curation task is mostly self-contained.
