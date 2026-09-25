# Optional JEV memory enhancement

Ekko creates its own JEV client. Hosts pass configuration values, never an SDK
implementation. Persisted `config.jev` is overridden field by field by constructor
and runtime options; explicit false values and empty credentials win. Configuration
schema 13 supplies relevance filtering options to older configs while preserving
their saved switches and thresholds.

```ts
const ekko = new EkkoAgent({
  jev: {
    enabled: true,
    apiKey: 'host-provided-key',
    memoryEnabled: true,
    memoryKindRoutingEnabled: true,
    memoryRelevanceFilterEnabled: true,
    memoryRerankEnabled: true,
    memoryWriteReviewEnabled: true,
    memoryCandidateLimit: 20,
    memoryRecallMinConfidence: 0.5,
    memoryFilterMinConfidence: 0.8,
    memoryMinConfidence: 0.8,
    memoryTimeoutMs: 3000,
  },
})
```

Standalone Ekko's master and all four feature switches default to false. Numeric defaults are
20 candidate cards (range 1–50), a 0.5 recall threshold, a 0.8 relevance-filter
confidence threshold and a 0.8 write-review threshold (all range 0.5–1), and a
3000 ms total deadline (range 100–30000 ms). These are configurable defaults,
not a claim that provider confidence is calibrated for every application.
Studio exposes every option in Models → JEV for the selected Profile, with numeric
fields in Advanced parameters. Studio's memory master defaults to false and its
four child switches default to true; saved explicit values take precedence.
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

1. Compute the original, authorized recall result first. Explicit `key`, `kinds`
   and `valueJson` queries bypass enhancement, as do empty query text and disabled
   features. Exact queries, `memory_search`, `memory_get` and list-all keep their
   original behavior.
2. Prioritize ordinary baseline matches for individual filtering. If category
   routing is enabled, supplement the evaluation pool with up to 500 authorized
   cards after the existing expiry, confidence and conflict resolution. Judge at
   most `memoryCandidateLimit` candidates in the existing order. Baseline cards
   outside this window remain intact.
3. In one provider request, ask category questions and, when filtering is enabled,
   individual relevance questions using actual title, content and value evidence.
   Only judged cards in kinds reaching `memoryRecallMinConfidence` supplement the
   result. Kinds remain controlled; JEV cannot invent categories. The independent
   filter also checks ordinary baseline matches, including automatic kind-rule
   matches in `exact`. It drops a card only for an explicit `irrelevant` judgment
   at or above `memoryFilterMinConfidence`. An uncertain valid judgment keeps that
   card; it does not cancel useful semantic recall. A malformed required answer
   invalidates the whole enhancement. Decisions for categories that are neither
   baseline matches nor selected by routing do not affect the result.
4. Always retain constraints, corrections and the existing always-recalled kinds
   (interaction contract, language, accessibility, communication and hard constraints).
   The filter never judges those cards. If reranking is enabled, score at most
   `memoryCandidateLimit` remaining ordinary candidates in one request, requiring
   valid scores and confidence at least `memoryRecallMinConfidence`. Surviving
   exact matches and required cards retain their priority.
5. Recheck added candidates after evaluation; discard any that were deleted,
   edited, expired or superseded while waiting. Apply the existing result limit,
   token budget, context grouping and diagnostics.

Routing and filtering share the first request; reranking uses the second. All share
one `memoryTimeoutMs` deadline. If either request fails, the entire enhancement
falls back to the original recall result, including any cards already filtered in
an earlier stage. No stage alters a stored card or replaces its confidence or
importance. `MemoryContext`, `MemoryQueryResult` and `MemoryNode` retain their
existing shapes. Removed ids are recorded in JEV diagnostics, without introducing
new public omission reasons or provider fields into results.

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
invalid output and uncertain ranking/review. The filter stage records per-card ids,
decisions, confidence and removed ids, so uncertain retained cards can be distinguished
from confident exclusions. These compact records contain no card
content, query text, credentials or raw provider errors. Logger failures are ignored.
General runtime events remain unpersisted.

To verify recall and filtering, remember a lasting lodging preference (sound
insulation first, mattress comfort second, no view requirement), then use three
fresh sessions without memory tools or additional writes:

- Ask to rank rooms whose noise, mattress comfort and view trade off. The lodging
  card should be in context and determine the ranking.
- Claim that views matter most and noise does not matter. The same card should
  remain in context to correct this false premise.
- Ask “我之前说过自己最喜欢哪种甜点？只依据已有个人信息回答，没有记录就说不知道，不调用记忆工具，也不新增记忆。”
  Without filtering, the broad preference rule can recall lodging because of
  “喜欢”. With a confident irrelevant decision, the lodging card should be absent
  from context and the agent should say that no dessert preference is recorded.

Inspect `memory.jev` filter diagnostics and the recalled card ids as well as the
answer; a correct answer alone does not prove that filtering ran. Switch filtering
or the master off to compare with the original behavior. The regression suite also
covers timeout, malformed output, provider/rerank failure, protected memories and
uncertain per-card decisions. A failed provider preserves baseline context and
normal model execution; it does not make the chat fail.

Candidate selection is bounded, not a vector index or exhaustive search of every
stored memory. A matching older card outside the window can still be missed, and
an unrelated baseline card outside the filter window remains unfiltered. Increase
the exposed candidate limit if needed. Provider quality and latency can vary.
