# Optional JEV memory enhancement

Ekko creates its own JEV client. Hosts pass configuration values, never an SDK
implementation. Persisted `config.jev` is overridden field by field by constructor
and runtime options; explicit false values and empty credentials win. Configuration
schema 11 supplies disabled feature defaults to older configs.

```ts
const ekko = new EkkoAgent({
  jev: {
    enabled: true,
    apiKey: 'host-provided-key',
    memoryEnabled: true,
    memoryKindRoutingEnabled: true,
    memoryRerankEnabled: true,
    memoryWriteReviewEnabled: true,
    memoryCandidateLimit: 20,
    memoryMinConfidence: 0.8,
    memoryTimeoutMs: 3000,
  },
})
```

The master and all three feature switches default to false. Numeric defaults are
20 candidate cards (range 1–50), a 0.8 decision threshold (range 0.5–1), and a
3000 ms total deadline (range 100–30000 ms). These are configurable defaults,
not a claim that provider confidence is calibrated for every application.
Studio exposes every option in Models → JEV for the selected Profile, with numeric
fields in Advanced parameters. Switching the master off preserves child settings.

## Runtime boundary

`AgentRuntime.run` captures a private JEV client snapshot in an async run context.
Automatic recall and foreground memory tools use that context, including parallel
tools. Updating the runtime client affects later runs, not in-flight operations.
Nested runs establish their own snapshot. Memory services can remain shared without
storing mutable credentials or feature settings. Direct `MemoryService` CRUD outside
a runtime retains its original deterministic behavior.

Studio reads the complete selected Profile settings before each run. Missing keys
or settings read errors explicitly disable JEV; another Profile or local credentials
cannot substitute. This does not write back to the standalone configuration file.

## Recall

1. Compute the original, authorized recall result first.
2. If category routing is enabled, batch yes/no questions for the existing 20
   controlled kinds. Only probabilities at or above the configured threshold add
   categories. Additional candidates stay within the same Profile and scopes.
3. If reranking is enabled, score at most `memoryCandidateLimit` ordinary candidates
   in one request. Require valid scores in the rubric range and adequate confidence.
   Preserve exact matches, always-recalled constraints and corrections at the front.
4. Apply the existing result limit, token budget, context grouping and diagnostics.

Routing and reranking share one `memoryTimeoutMs` deadline, with at most two provider
requests in total. If either stage fails, the entire enhancement falls back to the
original recall result. No stage alters a stored card or replaces its confidence or
importance. `memory_search`, `memory_get`, exact recall and list-all do not use JEV.
`MemoryContext`, `MemoryQueryResult` and `MemoryNode` retain their existing shapes.

## Foreground write review

Deterministic validation runs first, including controlled kinds, authorized scopes,
canonical keys, source ids and expected revisions. Before committing, batch the
prepared create/update/supersede cards into one JEV request. Each card includes only
user-role evidence referenced by its source ids in the current session. Evidence
is read from at most the most recent 500 messages; unavailable evidence falls back
to the existing validated write path.

The evaluator chooses accept, unsupported, transient, or wrong_kind. A reliable
negative answer rejects the entire batch using its existing failure shape and an
operation index. The foreground model receives corrective feedback; the evaluator
cannot rewrite content, invent a kind, change ids or partially commit a batch.
All answers must validate before any negative decision is applied. Low-confidence
or malformed answers fall back for the entire batch. Existing database transactions,
unique active slots and revision checks still govern the final commit.

Delete, expire and noop operations do not need JEV approval. A mixed batch remains
atomic: if a reviewed write is rejected, its associated mutations are also withheld.
There is no background review queue, pending-memory table or approval UI.

## Failure and cancellation

Disabled or unconfigured JEV makes no upstream requests. Provider errors, timeout,
malformed/unreliable output and input over the internal 64 KB serialization guard
use the original flow. Oversized evidence is never silently truncated for judgment.
Each recall or write batch has its own total deadline; the provider timeout also
applies to individual requests. There are no automatic retries.

Caller cancellation propagates and is checked before committing. It never becomes
an empty recall, a fallback write permission, or a provider failure message. Provider
scores and raw responses remain internal; secrets and provider errors are not copied
into memory results or audit records.

Regression tests: `tests/ekko-agent/memory-jev.test.ts`, `memory-service.test.ts`,
`jev.test.ts`, Studio JEV/manager tests, and `tests/e2e/jev-settings.spec.ts`.
The registered integration contract is enforced by `npm run harness:check`.
