# Configurable ACP startup and discovery budgets

Issue #3616 reports healthy ACP agents exceeding Studio's fixed startup waits.
`EKKO_STUDIO_DSH_ACP_TIMEOUT_MS` and `EKKO_STUDIO_ACP_TIMEOUT_MS` configure DSH and
other native ACP control requests independently, retaining the 60-second defaults.
`EKKO_STUDIO_AGENT_MODEL_DISCOVERY_TIMEOUT_MS` configures the total native discovery
subprocess deadline, retaining its 20-second default and explicit host overrides.
All three environment overrides accept positive integer milliseconds through
Node's maximum timer delay. Resolution uses the first valid value: the Studio
name, its original `HERMES_*` alias (same suffix), then the existing default.
An invalid or empty new value does not mask a valid legacy value. Numeric
conversion retains the existing `Number` semantics. An explicit discovery
`host.timeoutMs` still precedes both names, with its existing semantics.

The original names came from the Issue's request and #3526's
`HERMES_DSH_READY_TIMEOUT_MS` precedent. The new names identify Studio's Coding
Agent ownership; they do not rename Hermes Agent settings. The existing readiness
variable and all other HERMES configuration remain unchanged. Both names are read
from the Studio server's `process.env`, independently of subprocess/profile env.
The npm CLI and Desktop server launcher preserve inherited values; Docker Compose
now forwards both names without supplying numeric defaults that would mask aliases.
See the README and Docker guide for restart/recreation instructions.

The control-request budgets apply to initialization, session creation/restoration
and model/effort selection. Prompt generation still has no request timeout.
DSH's explicit session-close wait stays at 10 seconds. Timeout, process-failure,
write-failure, cancellation and disposal paths retain their existing ownership
and cleanup behavior. The DSH configuration helper's separate readiness budget
and 15-minute idle lifecycle are unchanged.

Controlled-clock transport tests exercise slow successful replies, shorter
cutoffs, range validation, independent budgets, total discovery deadlines,
both naming families, invalid-new/valid-legacy fallback, explicit host precedence
and cleanup. Existing ACP, DSH and discovery suites
continue to own protocol and real subprocess coverage.
