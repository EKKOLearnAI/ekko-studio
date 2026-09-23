# JEV integration and configuration contract

Every Studio business feature that uses JEV must identify its integration point,
provide its own persisted switch, and expose user-adjustable settings in the
frontend. An API key only makes the provider available; the memory master switch
must still be enabled before its configured child features can use JEV.

## Required behavior

- Register the feature in `scripts/jev-integrations.json`: a stable id, purpose,
  concrete source files, independent boolean `enabledKey`, additional `options`,
  implementation status, and regression test files.
- Each feature switch is scoped to the selected Profile and has a labeled
  frontend `NSwitch`. Studio defaults to `false` unless its registration explicitly
  declares `studioDefaultEnabled: true`. The checker requires the persisted default
  to match this declaration; standalone switches still default to `false`.
  Reusing another feature's switch or the provider credential as its activation
  condition is not allowed.
- Expose every user-adjustable JEV option through the settings API and an editable
  frontend control. This includes feature-specific thresholds, candidate limits,
  per-feature models or timeouts if introduced. Do not add backend-only knobs or
  editable controls whose values are omitted from the save request.
- Shared provider configuration (`baseUrl`, `model`, `apiKey`, `timeoutMs`) may be
  inherited. Do not duplicate it per feature unless independent overrides are
  needed. An empty `options` list explicitly means no extra feature knobs exist.
- The UI must explain the feature and any non-obvious option semantics using all
  locales. Reuse `SettingRow`, shared input sizes and theme variables. Users must
  be able to find the controls on the registered settings page.
- An active integration must check its feature switch before evaluation. Turning
  it off must stop that feature's JEV requests and preserve its original flow.
  Missing credentials and optional provider failures must preserve that flow as
  well; cancellation must still propagate. Other JEV features remain independent.
- Apply saved settings at the documented run boundary, respect Profile isolation,
  and preserve explicit `false` overrides. For standalone agents, provide the
  corresponding local config/constructor option and document the Studio mapping.
- Use Studio's public facade or the agent-owned evaluator. Business modules must
  not instantiate the provider SDK or introduce an unregistered HTTP bypass.

## Current integration

| Integration | Implementation | Studio setting | Standalone setting | Frontend entry |
| --- | --- | --- | --- | --- |
| `ekko-memory` | Active: run context and fallback, `memory/jev-policy.ts` | `ekkoMemoryEnabled` | `jev.memoryEnabled` | Models → JEV → Use JEV for Ekko memory |
| `ekko-memory-kind-routing` | Active: `memory/jev-routing.ts` | `ekkoMemoryKindRoutingEnabled` | `jev.memoryKindRoutingEnabled` | Memory options → Semantic category routing |
| `ekko-memory-rerank` | Active: `memory/jev-rerank.ts` | `ekkoMemoryRerankEnabled` | `jev.memoryRerankEnabled` | Memory options → Candidate reranking |
| `ekko-memory-write-review` | Active: `memory/jev-write-review.ts` | `ekkoMemoryWriteReviewEnabled` | `jev.memoryWriteReviewEnabled` | Memory options → Review memory writes |

Agent source paths above are relative to `packages/ekko-agent/src`. Studio's memory
master defaults to false; its three child switches default to true. Existing saved
values, including explicit false, take precedence. Standalone Ekko retains false
defaults for every switch. Studio reads the selected Profile before each normal/isolated run;
the runtime snapshots the values for all subsequent memory operations. Shared memory
services never store a mutable JEV client or Profile configuration. No runtime
setting is written back to Ekko's local file.

The parent integration owns the decision threshold and per-operation time budget.
Reranking owns the candidate limit. All three options have editable advanced controls.
See [memory JEV behavior](../../packages/ekko-agent/docs/memory-jev.md) for the
behavioral contract. Keep `MemoryContext`, `MemoryQueryResult`, `MemoryNode` and
write result shapes compatible. Evaluation scores must not overwrite stored fields.

The settings screen's connection test and the authenticated manual evaluation
API are explicit caller actions, rather than automatically enabled business
features. Core settings, transport, exports and SDK adapters are narrowly listed
as infrastructure in the checker; this list is not a place to exempt new features.
Runtime/setup files are exempt only while they perform configuration wiring. A
new evaluation call there must be registered as a business integration as well.

## Mechanical checks

`npm run harness:check` runs `scripts/jev-harness.mjs` in the existing Build CI.
It reads TypeScript and Vue syntax, including real template bindings, and checks:

1. JEV imports/calls, runtime evaluator access and known HTTP entry points in
   server, client and standalone agent source have a registered owner.
2. Each integration declares its own boolean switch, matching Studio default and
   concrete source/test paths; a configuration-only integration cannot directly evaluate.
3. Settings declared by defaults and server/client interfaces are registered,
   accepted by the save API, returned by the read API, bound to editable controls,
   included in the frontend save request, and labeled in every locale. The form
   must also remain mounted on its declared host page.
4. Feature options have an integration owner, and the current standalone switch
   retains its disabled default and explicit Studio-to-agent mapping.

This is a structural architecture check, not whole-program data-flow analysis.
It does not prove that an arbitrary runtime branch correctly gates every request,
that a conditional UI control is reachable for every user, or that a declared test
covers its feature. Keep the following behavioral tests and review requirements.
If a legitimate refactor changes the checked syntax, update the checker and its
positive/negative fixtures together instead of exempting the business module.

## Adding an integration

1. Add the persisted switch and any new options to server validation/defaults and
   the non-secret settings response, plus the frontend settings type.
2. Add controls and save wiring on the JEV page, with locale labels. Register their
   component types, bindings and label keys under `settings.fields`; give every
   non-shared field an integration owner.
3. Register the integration's source files, switch, options and tests. Implement
   the switch check at the evaluation boundary and preserve the existing fallback.
4. Test disabled/no-credential behavior with zero upstream requests; enabled
   behavior; optional provider failure; explicit disabling after enabling; saved
   setting refresh; Profile isolation; and overrides without write-back where
   applicable. Verify frontend save/reload and Profile switching in Playwright.
5. Run `npm run harness:check`, `npm run test -- tests/server/jev-harness.test.ts`,
   feature tests, and the relevant browser tests/build. The PR must describe the
   configuration entry point, defaults, effective timing, and fallback behavior.

The harness test suite deliberately removes switches, save fields, controls,
locale labels and runtime mappings, and introduces unregistered/aliased callers,
to verify that these regressions fail the check. Filesystem discovery is tested
against a small isolated repository. The full repository scan runs in the separate
`npm run harness:check` CI step, keeping coverage tests independent of repository
size and avoiding a duplicate full scan under their per-test timeout.
