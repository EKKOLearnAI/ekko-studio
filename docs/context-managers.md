# Context managers

Studio supports `native` and `bili` context management for Hermes and the built-in
Ekko Agent. Each profile selects the two Agents independently under
**Settings > Context Manager**. The default is `native`; changing a profile does
not change other profiles or the upstream Hermes configuration.

## Configuration

Choose **Billion Context** for an Agent, enter the origin of a local bili proxy,
and save. Only HTTP(S) loopback origins are accepted. Paths, credentials, query
parameters and fragments are rejected. The public manifest must expose the five
tools `compress`, `decompress`, `search_context`, `acp_status` and `acp_cache`.
Branching also requires the version-1 public fork and snapshot capability.
A reachable proxy is not necessarily compatible; the settings page reports
reachability and protocol compatibility separately.

Studio can install, start, stop and upgrade a profile-local proxy. Installed
packages and proxy state are isolated from an existing external installation.
Stop a Studio-managed proxy before upgrading. Studio does not stop or upgrade an
externally managed process. The worker observation is read from the Hermes
bridge for the selected profile and includes its process IDs and session counts.
**Unknown** means that observation failed, not that the worker is healthy.
Restarting the worker requires confirmation that idle sessions will reconnect;
Studio refuses a restart while sessions are running or their state is unknown.

Native fallback is disabled by default. Enabling it permits supported integration
paths to fall back when a compatible bili transport is unavailable; it does not
make an unavailable branch recoverable or permit a partial branch to reach the
model. Inspect the reported context manager and availability rather than assuming
that the selected backend is currently active.

## Compression And Usage

There is only one compression owner for a run. Bili-managed runs do not invoke
Studio or Hermes native automatic, manual or overflow summarization. Manual
compression uses the public bili tool against the current conversation revision
and the proxy's live `compressibleRanges`, excluding the first user anchor.
An older proxy without structured ranges cannot safely perform this operation.
A stale revision or missing source history is rejected before rewriting it. If a
committed operation cannot be observed afterwards, Studio reports that failure
without substituting a local estimate or claiming that the operation rolled back.

The context indicator uses the proxy's effective context observation with its
source (`usage` or `estimate`), observation time, model, context window and
generation. It is distinct from cumulative input/output and cache billing.
An invalid, stale or mismatched observation is unavailable, not zero. Local
database history estimates must not replace a fresh effective observation.
Refreshing or resuming a session reads the public proxy status again, including
after Studio restarts. An older proxy without observation provenance cannot
provide an authoritative effective-context indicator. After restart, a native
Hermes or Ekko context remains unavailable until its assembled context is
observed again; the last request's billing record is not a context snapshot.

## Branches And Recovery

Branches use a separate conversation ID and the public version-1 snapshot/fork
protocol. Studio matches an ordered history prefix, checks the parent revision,
and records an idempotent fork request before publishing the child. Pending fork
requests are retried with the same payload after interruption. A failed or
unconfirmed fork prevents the child's first model request.

Inherited state must include the selected original messages and recoverable
compression data without sharing mutable state with the parent or siblings.
An `exact` boundary preserves eligible blocks. An `expanded` boundary restores
original messages where a block crosses the branch point. Missing originals,
unsupported message mappings or a changed parent revision fail closed rather
than substituting a plausible summary. Legacy native summaries are not proof of
recoverable bili originals.

Studio's database history remains the conversation record. Bili compression is
working-context management; it does not replace JEV long-term memory.

## Profile-Scoped API

Authenticated requests use the selected profile through `X-Hermes-Profile`:

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/studio/context-manager/settings` | None |
| PUT | `/api/studio/context-manager/settings` | Partial settings object |
| GET | `/api/studio/context-manager/health` | None |
| POST | `/api/studio/context-manager/lifecycle/:action` | `{ "manager": "hermes" }` or `{ "manager": "ekko" }` |
| POST | `/api/studio/context-manager/worker/restart` | `{ "profile": "<selected-profile>", "confirm": true }` |

Lifecycle actions are `install`, `start`, `stop` and `upgrade`. Worker restart is
separate from proxy lifecycle and rechecks running sessions before acting.
Settings contain
`hermes.manager`, `ekko.manager`, `proxyUrl` and `allowNativeFallback`. Both manager
values are `native` or `bili`; unknown fields and invalid values are rejected.
