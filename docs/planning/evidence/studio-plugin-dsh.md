# DSH independent plugin delivery evidence

Date: 2026-10-25. Incremental implementation; complete Studio migration acceptance remains **0/14**.

## Implementation

`plugins/dsh` registers `studio.agent-dsh` / `dsh` through the public SDK. Production sources import only public Studio SDK/driver exports, Node built-ins, YAML and their own plugin modules. They do not import server/client implementations or invoke the legacy host runner.

The plugin owns the DSH-specific Web-profile composition, package/dependency discovery, relative-path anchoring, preset registry/legacy detection, private native ACP adapter and live-stream/usage extension. The source Web backend bundles, plugin dependencies and preset declarations remain available; native Web/UI/server rows are excluded from the conversation profile. ACP preset selection is attached before creation, stored natively and restored from persisted identity. The adapter checks exact required integration seams before writing a private module, records upstream version/hash and retains upstream MIT licensing. Installed native sources are unchanged.

Global mode retains native account/model configuration and native resource roots while private ACP composition and conversation history live under host state storage. Scoped mode replaces root, subagent and auxiliary model selections with the run-bound Responses route. Its gateway token exists only in the child environment. Source native credential files are retained as native snapshots; gateway tokens are not written into those files or overlays. Managed stdio and Streamable HTTP MCP use private patches, retaining source config. Explicitly disabled managed MCP remains disabled.

Live text/reasoning is forwarded from native assistant attempts. Final ACP messages consume only their own streamed prefix. Global usage reports each native root/child/auxiliary call once, with cache-inclusive total input and separate cache/reasoning counters; scoped usage remains authoritative in the host gateway. Native context occupancy is never presented as billable usage.

A prompt is successful only after `session/close` flushes persistence and the owned process exits successfully. Native resume failures never create a replacement conversation. Cancellation and failures clean the owned process and gateway before another turn. The established DSH full-access/never-approval native policy remains; unexpected ACP permission requests are bound to the owning Run and validated against its offered choices.

Management declares fixed `@deepseek-ai/dsh@0.1.7-rc.2`, Node runner and `preferDedupe: true`. Setup includes npm `--prefer-dedupe`. Metadata inspection runs only `--version`, creates no ACP session/history/Run and returns unknown authentication and unsupported model enumeration. There is no fabricated standalone CLI login action: native credentials are configured through DSH Web plugin settings. Resource locations include native settings, instructions, Cordis MCP, source Web composition/manifest and private/shared Skills; shared Skills are read-only.

## Verification

Native installation: `/tmp/studio-dsh-native-qa/node_modules/@deepseek-ai/dsh/lib/bin.js`, fixed `0.1.7-rc.2`, installed with npm `--prefer-dedupe`. All native probes use disposable source Home, workspace, account fixtures and local loopback model responses. They never read the user's native DSH account or call paid/remote inference.

```sh
STUDIO_DSH_REAL_COMMAND=/tmp/studio-dsh-native-qa/node_modules/@deepseek-ai/dsh/lib/bin.js \
python3 /tmp/studio-plugin-run-clean.py /tmp/studio-dsh-plugin-real.log \
npx vitest run tests/server/studio-dsh-plugin.test.ts
```

The suite has 11 deterministic tests plus 2 opt-in real-native tests. It covers global/scoped worker activation, native preset metadata, live/final output deduplication, exact cache usage, source-file preservation, scoped routing/secrets, no-Run inspection, fixed setup hints, shared resource protection, approvals, cancellation/crash recovery, flush failure, resume failure without replacement, unsupported compaction, authorization rejection and incompatible native seams.

Final run: **13/13 passed**, 9.30 seconds total, macOS arm64 / Node 24.22.1. Log: `/tmp/studio-dsh-plugin-real.log`. Public-library type check also passed with exit code 0 in `/tmp/studio-dsh-types.log`. No shared build/bundle/UI/CI file was changed by this subtask.

Each actual-native case runs two turns across separate native processes and performs four local model requests: native preset tool, managed stdio MCP tool, first answer and resumed answer. Assertions verify actual preset tool/Skill presence after resume, MCP arguments/result, valid PNG delivery, model-route identity, restored history and no duplicated output. The response fixture pauses after the first text delta until that delta reaches the coordinator, proving streaming before native model completion. Global first-turn usage includes all three model calls; scoped emits no duplicate runtime usage.

The initial image extension probe correctly rejected an invalid hard-coded PNG fixture. It also exposed that registry releases persist volatile default-model selections in the Web profile composition rather than settings alone. The fixture was corrected to a valid PNG and both native configuration layouts. Assertions and native execution deadlines were not weakened; temporary diagnostic writes were removed. An earlier diagnostic failure remains in `/tmp/studio-dsh-plugin-real-diagnostic.log`.

Type checking uses the installed public library declarations and Node types:

```sh
python3 /tmp/studio-plugin-run-clean.py /tmp/studio-dsh-types.log \
npx tsc --ignoreConfig --noEmit --types node --target ES2022 --module Node16 \
  --moduleResolution Node16 --esModuleInterop --skipLibCheck plugins/dsh/src/index.ts
```

## Parent integration verification

The parent added DSH to production plugin builds, explicit bundled setup, the mobile management browser flow and three-platform worker CI. A broader actual-native matrix initially exposed two integration failures: the ACP socket was listening before Cordis loader/MCP discovery completed, and a resumed native session still referenced a gateway model identity removed after the selected Studio model changed. The private adapter now awaits the native loader's completion at ACP initialize, and scoped native configuration uses a stable `studio-model` alias while each Run's gateway remains pinned to its actual selected host model. Neither change rewrites the source native installation or account files.

Final actual-native matrix: **14 turns / 19 local model requests / 5 real Studio MCP calls passed**, including both modes, selected-model changes, Chat Completions/Anthropic translations, images/Skills, configuration updates, provider/coordinator restart and two-chat isolation. Log: `/tmp/studio-dsh-real-native-matrix-v3.log`. The strengthened worker suite now has 12 deterministic plus 2 opt-in actual-native cases; combined with bundled setup and package boundaries, **23 tests passed**, log `/tmp/studio-parallel-dsh-barrier-final-focused.log`. The first model request is asserted to already contain the managed MCP tool; no retry or delayed second-turn discovery substitutes for it.

## Explicit remaining gaps

- Native Plugins iframe, inventory/package mutations and preset CRUD/default-selection management remain on the existing DSH routes. The public plugin management contract currently cannot expose those HTTP/WS/native UI contributions. Generic resource locations do not replace these workflows.
- Native ACP `/compact` and SSE MCP remain explicitly unsupported, matching the previous DSH ACP boundary. No compact command is registered.
- ACP `usage_update` context occupancy needs a separate public context event and presentation consumer. It is currently unknown in the new runtime, not fabricated as zero or conflated with billing.
- No real account, newer installed release, Windows/Linux, cross-platform history, App/UI, performance, distribution/default installation, migration/rollback or complete entry-point acceptance is claimed by these local tests.
- The parent integration owns bundled/build lists, shared verifier, UI, CI and final commits. This subtask does not remove the old execution path.

## Windows ACP source line endings

Windows worker CI on `969ce5f09` failed before native launch: the private adapter found zero `new-session preset selection` seams. Other DSH failures were downstream effects (no trace or completed checkpoint). The first single-line startup seam was still found. Recreating the Git fixture with CRLF on macOS reproduces the failure; the same exact multiline seam occurs once in LF and zero times in CRLF. The failing regression before the fix is recorded in `/tmp/studio-dsh-crlf-before.log`.

Adapter revision 6 normalizes CRLF only in its in-memory private copy, after computing the original-source SHA-256. Exact capability-seam counts remain required. The installed ACP module is never rewritten, and its diagnostic hash continues to identify the original bytes rather than the normalized copy.

The new LF/CRLF worker cases each create and resume a conversation, require both native close acknowledgements, compare the installed file byte for byte, and check that the private adapter retains its original hash plus preset, startup and flush seams. The fixed `0.1.7-rc.2` actual-native cases remain enabled in the local focused run. Windows CI itself must be rerun by the parent; local CRLF reproduction does not claim execution on Windows.

After the fix: **17/17 passed**, including both actual-native modes, in `/tmp/studio-dsh-windows-crlf-native-focused.log` (20.61 seconds total). Public-library type checking passed in `/tmp/studio-dsh-windows-crlf-types.log`; the scoped diff passes `git diff --check`. No assertions, skips or deadlines were weakened.
