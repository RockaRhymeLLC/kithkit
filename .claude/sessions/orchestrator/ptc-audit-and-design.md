# PTC Integration — Audit & Design

## Phase 1: Audit Results

### 1. Legacy Beta Headers

**Finding: CLEAN — No legacy headers in project code.**

Searched the entire `daemon/src/` directory for `token-efficient-tools`, `anthropic-beta`, and `betas`. Zero matches in project-authored code.

The Agent SDK's bundled `cli.js` internally uses `anthropic-beta` for its own features (files API, etc.), but this is the SDK's concern, not ours. We don't set any beta headers.

**Token-efficient tool use is built into Claude 4+ models (Sonnet 4.6, Opus 4.6)** — the `token-efficient-tools-2025-02-19` beta header is only needed for Claude 3.7 Sonnet. Since all our worker profiles use Sonnet (which resolves to Sonnet 4.6) or Haiku (4.5), we're already getting token-efficient tool use automatically.

### 2. Worker Token Usage

**Aggregate stats (from daemon API):**
- 2 completed research worker jobs on record
- Total: 2,163 output tokens, $0.39 USD
- Representative job: $0.23, 51 seconds, 2,149 output tokens

**Tracking gaps:**
- `tokens_in` values are suspiciously low (3 and 6) — the SDK's result message likely only reports final-exchange tokens, not cumulative multi-turn input
- No per-turn breakdown, no cache token tracking
- No cost-per-profile aggregation in the API

**Implication for PTC:**
Token usage data is too sparse to establish a reliable baseline before PTC. We should note this gap but not block on it — PTC's value is clear from Anthropic's benchmarks (37% average reduction on research tasks).

### 3. Agent SDK Adapter Architecture

**Key files:**
| File | Role |
|------|------|
| `daemon/src/agents/sdk-adapter.ts` | Core SDK wrapper — spawn, kill, status, token capture |
| `daemon/src/agents/profiles.ts` | Profile YAML parser and validator |
| `daemon/src/agents/lifecycle.ts` | DB persistence, FIFO queue, polling |

**How workers are spawned:**
1. `POST /api/agents/spawn` → `lifecycle.spawnWorkerJob()` → `lifecycle.startWorker()` → `sdk-adapter.spawnWorker()`
2. `spawnWorker()` maps profile fields to SDK options and calls `@anthropic-ai/claude-agent-sdk` `query()` function
3. Tools are **plain string names** (e.g., `'Read'`, `'Grep'`, `'Glob'`) passed as `allowedTools`/`disallowedTools`

**Current SDK options built per worker:**
```typescript
const sdkOptions = {
  abortController,
  systemPrompt: { type: 'preset', preset: 'claude_code', append: profile.body },
  settingSources: ['project'],
  model,              // from profile
  allowedTools,       // string[] from profile
  disallowedTools,    // string[] from profile
  maxTurns,           // from profile
  maxBudgetUsd,       // from spawn call
  cwd,                // from spawn call
  permissionMode,     // from profile
};
```

**Current profiles (`.claude/agents/`):**

| Profile | Model | Turns | Tools | Permission |
|---------|-------|-------|-------|------------|
| research | sonnet | 20 | (all — no filter) | bypassPermissions |
| coding | sonnet | 30 | (all — no filter) | bypassPermissions |
| testing | haiku | 15 | (all — no filter) | bypassPermissions |

None of the profiles set explicit `tools` or `disallowedTools` — they rely on system prompt instructions for behavioral constraint.

### 4. SDK PTC Support Assessment

**SDK version:** 0.2.50
**CLI version:** 2.1.51

**Critical finding: The Claude Agent SDK does NOT expose PTC configuration.**

- The SDK `Options` interface has no `extraToolSchemas` or `allowed_callers` field
- PTC requires adding `code_execution` tool and `allowed_callers` field to tool definitions
- The SDK passes tools as string names only (`allowedTools: string[]`), not full tool schemas
- The `betas` option only accepts `'context-1m-2025-08-07'` — no advanced-tool-use beta
- Internally, `cli.js` has `extraToolSchemas` in its query builder, but this is not exposed publicly

**This means PTC cannot be configured through the Agent SDK's public API today.**

PTC is an **API-level feature** (direct Anthropic Messages API), but the Agent SDK is an abstraction over Claude Code that handles tool definitions internally. We would need one of:
1. The Agent SDK to expose PTC configuration (feature request / SDK update)
2. A way to pass raw tool schemas through the SDK (not currently possible)
3. Bypass the SDK and use the raw Anthropic API for PTC-enabled workers (major architecture change)

---

## Phase 2: Design Proposal

### Recommendation: Two-Track Approach

Given the SDK limitation, here's a practical path forward:

#### Track A: Quick Win — Optimize Worker Profiles Now (No SDK Changes)

These changes reduce token burn immediately without PTC:

1. **Add explicit `tools` lists to profiles** — Currently all profiles allow all tools. The research profile shouldn't have Edit, Write, Bash, NotebookEdit. Restricting tools reduces the tool schema tokens sent to the model on every turn.

   ```yaml
   # .claude/agents/research.md
   ---
   name: research
   tools: [Read, Glob, Grep, WebSearch, WebFetch, Task]
   disallowedTools: [Bash, Edit, Write, NotebookEdit]
   model: sonnet
   permissionMode: bypassPermissions
   maxTurns: 20
   ---
   ```

2. **Lower maxTurns where possible** — 20 turns for research is generous. Consider 12-15.

3. **Add `effort: 'medium'`** — The SDK supports this option. For research workers doing straightforward lookups, `medium` effort reduces thinking tokens.

4. **Add `maxBudgetUsd` per profile** — Set a cost ceiling per worker job (e.g., $0.50 for research, $1.00 for coding).

**Estimated savings:** 10-20% reduction from tool schema pruning + effort tuning. Immediate, no code changes to the adapter.

#### Track B: PTC Integration — Requires SDK Enhancement

**What we need from the SDK:**

A new option to pass additional tool type definitions or tool configuration overrides. Something like:

```typescript
// Hypothetical SDK option
{
  extraTools: [
    { type: 'code_execution_20260120', name: 'code_execution' }
  ],
  toolConfig: {
    'Read': { allowed_callers: ['code_execution_20260120'] },
    'Grep': { allowed_callers: ['code_execution_20260120'] },
    'Glob': { allowed_callers: ['code_execution_20260120'] },
    'WebSearch': { allowed_callers: ['code_execution_20260120'] },
    'WebFetch': { allowed_callers: ['code_execution_20260120'] },
  }
}
```

**What we'd build once the SDK supports it:**

1. **New profile field: `ptc`** — in `profiles.ts`, add an optional `ptc` configuration block:

   ```yaml
   # .claude/agents/ptc-research.md
   ---
   name: ptc-research
   description: PTC-enabled research worker — batches tool calls via code execution
   model: sonnet
   permissionMode: bypassPermissions
   maxTurns: 15
   tools: [Read, Glob, Grep, WebSearch, WebFetch]
   disallowedTools: [Bash, Edit, Write, NotebookEdit]
   ptc:
     enabled: true
     tools: [Read, Grep, Glob, WebSearch, WebFetch]
   ---
   ```

2. **SDK adapter changes** — in `sdk-adapter.ts`, map the `ptc` config to whatever SDK option is available:

   ```typescript
   if (opts.profile.ptc?.enabled) {
     sdkOptions.extraTools = [{ type: 'code_execution_20260120', name: 'code_execution' }];
     sdkOptions.toolConfig = Object.fromEntries(
       opts.profile.ptc.tools.map(t => [t, { allowed_callers: ['code_execution_20260120'] }])
     );
   }
   ```

3. **Profile validation** — add `ptc` to the `AgentProfile` interface and validate in `profiles.ts`.

**Recommended PTC-eligible tools for research workers:**

| Tool | PTC? | Rationale |
|------|------|-----------|
| Read | Yes | High-volume, results can be summarized in code |
| Grep | Yes | Pattern matching, results easily filtered |
| Glob | Yes | File discovery, results easily aggregated |
| WebSearch | Yes | Multiple searches batched and summarized |
| WebFetch | Yes | Fetch + extract in code, only summary returns |
| Task | No | Spawns subagents — not a data tool |

### Alternatives Considered

1. **Use raw Anthropic API instead of Agent SDK** — Would give full PTC control but loses all Claude Code built-in tools, file tracking, permissions, etc. Not viable.

2. **Fork the Agent SDK** — Could expose `extraToolSchemas` from the internal CLI. High maintenance burden. Not recommended.

3. **Patch the SDK at runtime** — Monkey-patch the query builder to inject PTC config. Fragile, breaks on SDK updates. Not recommended.

4. **Wait for SDK support** — Most prudent. The SDK team is actively developing PTC support (the CLI internals already reference it). Track A gives us savings now.

### Next Steps

1. **Implement Track A immediately** — Add explicit tool lists, effort setting, and budget caps to profiles
2. **File a feature request** with the Agent SDK team for PTC/`extraToolSchemas` support
3. **Monitor SDK releases** — when PTC support lands, implement Track B
4. **Improve token tracking** — add cache_creation_input_tokens and cache_read_input_tokens columns to worker_jobs

---

## Summary

| Question | Answer |
|----------|--------|
| Legacy beta headers? | None found — clean |
| Token-efficient tool use active? | Yes, built into Claude 4+ (all our models) |
| Can we add PTC today? | No — Agent SDK doesn't expose the config |
| Immediate savings available? | Yes — profile tool restriction + effort tuning |
| PTC readiness when SDK supports it? | Design is ready, profile format defined |
