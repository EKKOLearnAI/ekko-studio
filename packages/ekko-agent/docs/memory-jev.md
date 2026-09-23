# Optional JEV memory enhancement

Ekko creates its own JEV client. Hosts pass configuration values, never an SDK
implementation. Persisted `config.jev` is overridden field by field by constructor
and runtime options; explicit false values and empty credentials win. Configuration
schema 12 supplies the independent recall threshold to older configs and preserves
their saved switches and write-review confidence.

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
    memoryRecallMinConfidence: 0.5,
    memoryMinConfidence: 0.8,
    memoryTimeoutMs: 3000,
  },
})
```

Standalone Ekko's master and all three feature switches default to false. Numeric defaults are
20 candidate cards (range 1–50), a 0.5 recall threshold and a 0.8 write-review
confidence threshold (both range 0.5–1), and a
3000 ms total deadline (range 100–30000 ms). These are configurable defaults,
not a claim that provider confidence is calibrated for every application.
Studio exposes every option in Models → JEV for the selected Profile, with numeric
fields in Advanced parameters. Studio's memory master defaults to false and its
three child switches default to true; saved explicit values take precedence.
Switching the master off preserves child settings. Missing credentials still
disable provider calls even when the master is enabled.

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
2. If category routing is enabled, read up to 500 cards within the original Profile
   and scopes, then apply the existing expiry, confidence and conflict resolution.
   Select at most `memoryCandidateLimit` eligible cards using the existing ordering.
   Batch yes/no questions only for kinds present in those cards, supplying their
   actual title, content and value as evidence. Empty sets make no provider request.
   Only judged candidates in kinds whose relevance probability reaches
   `memoryRecallMinConfidence` supplement the original result. Categories remain
   the existing controlled kinds; no new kind is invented.
3. If reranking is enabled, score at most `memoryCandidateLimit` ordinary candidates
   in one request. Require valid scores in the rubric range and confidence at least
   `memoryRecallMinConfidence`.
   Preserve exact matches, always-recalled constraints and corrections at the front.
4. Recheck added candidates after evaluation; discard any that were deleted,
   edited, expired or superseded while waiting. Apply the existing result limit,
   token budget, context grouping and diagnostics.

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

`memoryMinConfidence` applies only to write reviews. Raising or lowering the recall
threshold does not affect writes. Existing saved write thresholds are retained.
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
scores never alter result fields; secrets and raw provider responses are not copied
into memory results or audit records.

Regression tests: `tests/ekko-agent/memory-jev.test.ts`, `memory-service.test.ts`,
`jev.test.ts`, Studio JEV/manager tests, and `tests/e2e/jev-settings.spec.ts`.
The registered integration contract is enforced by `npm run harness:check`.

## Diagnostics and manual verification

With the normal Ekko log writer enabled, `memory.jev` records identify the session,
run and turn, stage, elapsed milliseconds, selected kind count, routing probabilities
and thresholds. Fallback reasons distinguish timeout, sanitized provider error codes,
invalid output and uncertain ranking/review. These compact records contain no card
content, query text, credentials or raw provider errors. Logger failures are ignored.
General runtime events remain unpersisted.

To verify synonym recall, remember a lasting lodging preference (sound insulation
first, mattress comfort second), then ask in a new session, “这次出差怎么选住处？只根据已有上下文回答，不调用记忆工具，也不新增记忆。”
Compare enabled/disabled recall and an unrelated question such as JavaScript closures.
The regression suite models the original 0.52 routing score: it is accepted by the
0.5 recall threshold while write review stays at 0.8. A live isolated probe on
2026-09-23 gave 0.97 for the lodging question and 0.01 for the unrelated question;
this is a two-question smoke check, not a general accuracy benchmark.

Candidate selection is bounded, not a vector index or exhaustive search of every
stored memory. A matching older card outside the candidate window can still be
missed; increase the exposed candidate limit if needed. Both provider stages still
share the configured deadline. Provider quality and latency can vary.
