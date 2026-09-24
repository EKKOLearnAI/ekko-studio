# Optional JEV skill enhancement

One `jev.skillsEnabled` switch controls semantic skill matching and background
learning preflight. It is independent of memory JEV and defaults to false in both
standalone Ekko and Studio. JEV must also be enabled with credentials, and Ekko's
existing tools/skills switches still apply. Configuration schema 14 adds these
fields to older files without enabling the feature.

| Studio setting | Standalone `jev` field | Default / range |
| --- | --- | --- |
| `ekkoSkillsEnabled` | `skillsEnabled` | false |
| `ekkoSkillsCandidateLimit` | `skillsCandidateLimit` | 20 / integer 1–50 |
| `ekkoSkillsMinConfidence` | `skillsMinConfidence` | 0.8 / 0.5–1 |
| `ekkoSkillsTimeoutMs` | `skillsTimeoutMs` | 3000 / integer 100–30000 ms |

Studio exposes the switch and shared parameters in Models → JEV. Saving takes
effect on the next run; disabling retains the parameters, and deleting settings
resets them. Studio supplies complete Profile-scoped values, including explicit
false overrides, without writing to Ekko's local configuration. Standalone users
can persist these fields in `config.jev` or override them in constructor/runtime
options. Provider connection settings are shared with other JEV consumers.

## Semantic matching

The existing name/keyword matches remain first. During an actual run, one batch
evaluates the names, short descriptions and keywords of additional enabled,
non-invalid skills in discovery order, bounded by the candidate limit. Skill
bodies and filesystem paths are not sent. Up to three `applicable` decisions at
or above the configured confidence are added, ordered by confidence with stable
ties. All answers must have a valid shape before any additions are accepted.
Low-confidence matches add nothing. Explicit matches are never removed.

The existing `skill_view` execution reads selected instructions and retains its
validation and access rules. The complete enabled skill-name catalog stays in the
system prompt, so the main model can still discover skills outside the candidate
window. This is bounded semantic matching, not an index over every skill.
`estimateContext`, ordinary `resolveSkillRouting` and `matchSkillsForUserMessage`
remain local unless the routing caller explicitly requests semantic enhancement
inside a JEV run context. Context estimates therefore exclude semantic additions
that have not yet been selected; real model requests are estimated after loading.

## Learning preflight

The existing tool-call threshold and background queue remain the trigger for
learning (default 10 calls). Before starting the full model/tool review, one
JEV question checks non-system transcript evidence for reusable procedures,
corrections and verified techniques. Only a `skip` decision at or above the
configured confidence avoids the full review. A skipped review completes with
zero mutations. JEV never writes a skill; accepted and uncertain cases continue
through the existing reviewer and its managed-skill protections.

The complete non-system evidence is assessed when it fits the request limit;
oversized or unserializable evidence retains the full reviewer instead of
allowing a negative judgment on a truncated transcript. Queued work explicitly
captures its originating run's JEV snapshot and diagnostics, even if another
Profile's review delays execution. Cancellation does not start or authorize
learning writes, and propagates through reviewer model/tool requests.

## Bounds, fallback and diagnostics

Each routing or learning decision has one total deadline and at most one provider
request, also limited by the shared provider timeout. Requests over 64,000 UTF-8
bytes fall back intact. Disabled/missing credentials make zero requests. Provider
errors, timeouts and malformed results preserve the original behavior; caller
cancellation propagates. Confidence thresholds need validation on real tasks;
provider confidence is not a measured correctness rate.

Existing Ekko logs record `skill.jev` with `skill_routing` / `skill_review` stages,
run/session/turn correlation, timings, thresholds, counts and sanitized reasons.
They never include skill bodies, transcript text or credentials.
