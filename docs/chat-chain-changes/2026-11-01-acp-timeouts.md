# Configurable ACP startup and discovery budgets

Issue #3616 reports healthy ACP agents exceeding Studio's fixed startup waits.
`HERMES_DSH_ACP_TIMEOUT_MS` and `HERMES_ACP_TIMEOUT_MS` now configure DSH and
other native ACP control requests independently, retaining the 60-second defaults.
`HERMES_AGENT_MODEL_DISCOVERY_TIMEOUT_MS` configures the total native discovery
subprocess deadline, retaining its 20-second default and explicit host overrides.
All three environment overrides accept positive integer milliseconds through
Node's maximum timer delay; invalid values fall back to the existing defaults.

The control-request budgets apply to initialization, session creation/restoration
and model/effort selection. Prompt generation still has no request timeout.
DSH's explicit session-close wait stays at 10 seconds. Timeout, process-failure,
write-failure, cancellation and disposal paths retain their existing ownership
and cleanup behavior. The DSH configuration helper's separate readiness budget
and 15-minute idle lifecycle are unchanged.

Controlled-clock transport tests exercise slow successful replies, shorter
cutoffs, range validation, independent budgets, total discovery deadlines,
explicit host precedence and cleanup. Existing ACP, DSH and discovery suites
continue to own protocol and real subprocess coverage.
