# Antigravity independent plugin delivery evidence

Date: 2026-10-25. This is an independently implemented, partially validated
migration increment. It does **not** close Antigravity's complete acceptance or
change the overall **0/14** acceptance count. No commits/pushes were made by the
owning subagent. Build/bundle registration, CI and UI integration belong to the
main thread.

## Implementation and ownership

`plugins/antigravity` imports only the public plugin SDK and agent drivers. It
owns native stream-json framing, exact conversation restoration, a private
Gemini protocol adapter, native configuration, resources and management.
There are no imports of the old server runner, Codex proxy or private host
services in plugin code. The dedicated verification script uses host services as
a test fixture and runs the plugin through a real isolated plugin worker.

Manual installation remains manual: setup returns the official installation URL,
no `prepareInstall`, fake npm package or automatic native installer. Inspection
runs only the bounded `--version` probe and creates neither a native conversation
nor a Studio Run. Authentication remains unknown in global mode; scoped mode
uses Studio credentials. Native model discovery is not claimed by inspection. If native stdout/config does not identify the model, usage uses the explicit `antigravity/unknown` key and does not invent a priced model.

Global execution layers private settings, MCP and instructions over native HOME
and links native state without copying account credentials. macOS keychain paths
retain their original owners. Scoped state uses an instance-owned native HOME
and never links global native account/keychain paths. Existing native settings,
permissions, MCP and skills remain independently owned; generated settings only
add permissions for the explicit managed MCP definitions. Native self-update is
disabled for managed launches.

Native state also includes project indexes and SQLite state outside the old
`antigravity` directory. A stable opaque shadow UUID is therefore saved alongside
the conversation ID in the checkpoint. Recreating the shadow per runtime lease
made actual `agy --conversation` silently start a fresh conversation. The plugin
now restores the same shadow and conversation ID and fails if native IDs change.
Separate fresh runtimes get separate shadow UUIDs.

The launch keeps the existing user-selected `--dangerously-skip-permissions`
policy and does not invent an approval card. A model-step DONE, successful tool
step, zero exit without a final result, unknown result status, invalid framing or
changed conversation ID cannot complete a Run. Completion requires native
`result.status=SUCCESS`, confirmed zero exit, closed local adapter and completed
host gateway accounting. A process that retains itself after its result is
interrupted rather than reported successful.

Global usage counts completed agent-response and checkpoint model steps once, replacing repeated updates, and
uses only fresh single-turn result usage as fallback. Conversation-cumulative
result counters on resume are never counted as a new turn. Scoped execution
emits no native usage; the host gateway owns the authoritative rows.

Images retain the existing path-and-native-tool behavior: the SDK reads only
Run-owned artifacts, the plugin writes per-turn private 0600 files, and the input
instructs the native file/image tool to inspect them. Actual 1.4.x uses
`read_file` with `Path`; this is not a native stream-json image block. Temporary
files are removed after completion, cancellation and errors. Native compaction,
slash-command discovery and interactive permission adapters are not claimed.

## Scoped routing and protocol boundaries

Each Run gets a credentialed loopback Gemini endpoint which converts portable
Gemini requests through the public codecs to the Run-bound host Responses
gateway. Every auxiliary/title and main request is pinned to the selected host
model. The upstream provider key stays in the host. The native bridge accepts
only the two generation routes, requires its own ephemeral key, caps request and
response bytes and concurrent calls, aborts on cancellation and closes before
Run success. It buffers completed provider responses into one Gemini SSE chunk.

Native 1.4.x sends function-call and function-response IDs, including repeated
same-name calls. The main thread updated the public codec to preserve those
identities. Native MCP supports stdio and Streamable HTTP; legacy SSE declarations are explicitly rejected. Unsupported Gemini fields, hosted tools, opaque provider output or
unrepresentable request semantics are rejected rather than discarded.
Fixed native thinking budgets are projected explicitly to portable effort bands:
0 → none, 1–1024 → low, 1025–8192 → medium, 8193–32768 → high. This is an effort
projection, not an exact provider token-budget guarantee. Other budgets are
rejected.

Scoped admission rejects provider/environment routing overrides in managed
native settings/config and recognized workspace `.agents`/`.gemini`
settings/config files, without modifying the files. Host-provided Gemini
credentials/base URL, managed native directory and disabled ADC/Vertex settings
are applied last. The guard does not claim to sandbox native hooks, plugins,
MCP tools or arbitrary workspace code.

## Verification

- Strict standalone plugin TypeScript check passed:
  `/tmp/studio-antigravity-types-final.log`.
- Real plugin-worker tests: **23 passed**, no skipped cases or retries:
  `/tmp/studio-antigravity-worker-final.log`.
  Coverage includes global/scoped restoration, lifecycle barriers, malformed
  output, terminal failure, bad/late exits, cancellation followed by another
  turn, native identity mismatch, manual setup, metadata without history,
  global/scoped ownership, native cumulative usage, authenticated bridge routes,
  selected model/call IDs, cancellation cleanup, private image files and scoped
  routing-conflict rejection without file changes.
- Official native artifact **1.4.7** was downloaded only into
  `/tmp/studio-antigravity-native/antigravity` using the official manifest:
  `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json`.
  Fixed artifact URL:
  `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.7-5900205422411776/darwin-arm/cli_mac_arm64.tar.gz`.
  Verified SHA-512:
  `0192c9930fc8eccddc7aed96a6afde915f29ee380c81b6b6a835e68e4f1950514d98a596a87fbab9b1d87ba24921e29327af064bac8ced0bb873e78243826de9`.
  The user's installed executable was not replaced.
- Actual 1.4.7 plugin-worker/local-model probe completed **4 Runs** across
  global/scoped modes, two coordinator restarts, exact native ID/history
  restoration and actual PNG model input. Seven local model requests were seen;
  scoped accounting was host-owned (three rows of input 12/output 5), while
  global native step usage was 12/5 and 24/10 on its two Runs. No real provider
  key, Google login or paid inference was used. See
  `/tmp/studio-antigravity-native-delivery.log` and
  `/tmp/studio-antigravity-real-trusted.log`.
- The same four Runs, image path and scoped accounting also passed using the
  existing **1.4.2** binary with disposable HOME and native self-update disabled:
  `/tmp/studio-antigravity-real-1.4.2.log`.

The dedicated native script intentionally **returns failure** because its actual
MCP invocation requirement is still unmet. Its partial Run successes are not a
passing full native acceptance. Reproduce with:

```bash
STUDIO_ANTIGRAVITY_COMMAND=/tmp/studio-antigravity-native/antigravity \
  python3 /tmp/studio-plugin-run-clean.py /tmp/studio-antigravity-native-review.log \
  node scripts/verify-antigravity-plugin-native.mjs
```

## Remaining gaps

The actual Gemini API-key/no-account mode in both 1.4.2 and 1.4.7 recognizes the
private MCP configuration (`agy mcp list` lists it enabled), but did not expose
its tool to the model or start the native MCP process. Explicitly trusted
workspace settings did not change this observation. The strict actual probe
records this as failure; no undocumented native feature flag or synthetic direct
MCP invocation was used to claim success. Native MCP with a real eligible
account remains unverified. Configuration merge alone is not evidence of a real
MCP tool call.

Windows/Linux credential access, Windows links, real accounts, distribution,
full native model/command parity, concurrent conversation stress, provider
translation beyond the local Responses fixture, historical migration and
performance acceptance remain open. The plugin does not replace the old product
route yet; only the main thread may make that integration after review.

Official references checked during implementation:
[authentication](https://antigravity.google/docs/install?tab=cli),
[headless protocol](https://antigravity.google/docs/cli/headless),
[MCP](https://antigravity.google/docs/mcp),
[settings](https://antigravity.google/docs/settings?tab=cli).

## Cleanup confirmation follow-up

The main thread identified that the original implementation could clear `active`
after failed cleanup and could advance its in-memory checkpoint before process
or image disposal confirmed. Its sticky `cleanupFailure`/retired-runtime guard
is retained and extended here.

All normal completion cleanup now goes through one confirmation barrier:
process, local Gemini bridge, host gateway accounting, then temporary images.
Every stage is attempted, the first failure is retained, and any failed
confirmation permanently retires that runtime. The success path no longer calls
bridge/gateway disposal before `finally`, so a transient first failure cannot be
hidden by a successful second attempt. Checkpoint mutation occurs only after the
entire execution and cleanup barrier resolves successfully. Cancellation waits
for the remaining cleanup attempts and propagates their failure; it cannot
return a successful cancellation receipt after unconfirmed cleanup. When the
Run signal is revoked, gateway cleanup remains owned by the existing host
cancellation/accounting barrier.

Ten focused fault-injection regressions cover each resource independently,
retirement even after a transient disposer later succeeds, gateway/image cleanup
barriers that withhold success/checkpoints, continued execution after confirmed
cleanup, first-error retention with multiple failures, and cancellation error
propagation for all four resource types. These lifecycle tests inject failures
into resource handles; they do not claim additional native CLI acceptance.

- Combined focused result: **33 passed** (23 existing worker cases plus 10 cleanup
  regressions), `/tmp/studio-antigravity-cleanup-focused.log`.
- Strict plugin TypeScript check passed,
  `/tmp/studio-antigravity-cleanup-types.log`.
- No deadlines or assertions were relaxed. The known actual native MCP failure
  matrix was not rerun; its evidence and open acceptance gap remain unchanged.

## Windows CI portability follow-up

The first Windows platform CI reported nine failures in the cleanup suite. The
fault injection and its observations identified an image directory using the
literal POSIX substring `/images/turn-`; Windows supplied backslash paths, so
image failures were never injected and completed cleanup was not observed. This
was a test-path defect, not an observed failure of the cleanup barrier. One
normalized predicate now handles native Windows, POSIX and forward-slash Windows
paths. Five explicit path cases run on every platform, while all ten actual
cleanup/cancellation fault tests and their outcome assertions remain in place.

The remaining Antigravity Windows failure compared synthesized Node `stat.mode`
0666 with POSIX 0600. Windows privacy is controlled by the file's DACL rather than
POSIX group/other bits. Unix still requires exactly 0600. Windows now reads the
actual image file's security descriptor with `Get-Acl`, requires a discretionary
ACL, and rejects a foreign owner or any file-content read grant outside the
current user, LocalSystem and the Windows Administrators group. The test still
reads the attachment bytes and verifies deletion after cancellation. This is an
actual Windows access-control check, not a skipped permission assertion or an
assertion on requested `writeFile` options. Platform-independent negative cases
reject Everyone, Authenticated Users, BUILTIN Users, another account and a missing
DACL. Overly broad inherited permissions will therefore still fail the Windows
test rather than be described as private.

The focused local check now passes **39 tests** (24 base/worker and 15 cleanup/path
cases), `/tmp/studio-antigravity-windows-fix-focused.log`. Strict plugin plus ACL
fixture TypeScript checking passed,
`/tmp/studio-antigravity-windows-fix-types.log`. No deadlines were changed and no
failure assertions were removed. These are macOS local results; the revised
Windows ACL command and full Windows CI still require the main thread's native
Windows rerun. The prior actual MCP gap remains open.

Primary platform references:
[Node file-system permissions](https://nodejs.org/api/fs.html#file-modes),
[Windows Get-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl).

## Windows PowerShell ACL probe follow-up

Native Windows CI at `c9292e9de` confirmed the path/cleanup fixes: the Antigravity
cleanup suite now passed. The sole remaining platform failure occurred before
ACL evaluation: Windows PowerShell could locate `Get-Acl` but could not auto-load
`Microsoft.PowerShell.Security` (`CouldNotAutoloadMatchingModule`). See
`/tmp/studio-fourteen-windows-ci-fix-clean.log`, lines 294–306. The log does not
establish an overly broad file ACL or the underlying cause of that module-load
failure.

The ACL fixture now calls .NET Framework
`System.IO.File.GetAccessControl(path, Access | Owner)` directly. Microsoft
documents this API in `mscorlib.dll` as returning the file's `FileSecurity` object;
it reads the same owner and DACL without requiring a PowerShell Security module.
Rule enumeration, raw security descriptor checks and SID validation are retained.
The script also removes Utility-module cmdlets such as JSON conversion and
pipeline filtering, using only PowerShell language constructs and .NET methods.
Module auto-loading is explicitly disabled, so the native Windows test validates
that the probe can run without those modules. Canonical `SecurityIdentifier.Value`
strings contain no JSON escape characters; the script writes the fixed JSON
shape directly. The current-user/System/Administrators allowlist, foreign-owner
rejection, negative ACL cases, attachment read and cancellation cleanup checks
are unchanged.

Local focused result remains **39 passed**,
`/tmp/studio-antigravity-windows-dotnet-focused.log`; strict plugin plus ACL fixture
types passed, `/tmp/studio-antigravity-windows-dotnet-types.log`. No timeout or
assertion was relaxed, no test was skipped, and no product runtime code changed.
The replacement Windows PowerShell/.NET command still needs the main thread's
actual Windows CI rerun; local macOS results are not represented as Windows proof.

Primary API reference:
[File.GetAccessControl (.NET Framework)](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.getaccesscontrol?view=netframework-4.8.1).

Parent verification: code freeze `517912311` passed the actual Windows, Linux and
macOS Coding agent platforms jobs (run `40160407587`). This includes the Windows
PowerShell/.NET ACL probe, attachment read/cancellation and all cleanup cases.
The earlier Windows module-load failure is therefore resolved; the separate
actual no-account MCP acceptance gap remains open.
