# BOT roles, projects and execution contracts

BOT conversations define responsibilities. Account execution presets define runtimes and
models. Each background task receives its own execution identity; presets do not need to
be copied for every role. The settings drawer provides role instructions, editable
appearance, a project context and an allowed subset of the account executors. An empty
subset preserves the existing behavior of allowing all configured executors.

Projects register existing canonical directories, confirmed rules and optionally one main
Git repository with a worktree root. Registration neither clones nor migrates directories.
Paths must belong to the account workspace. Repository write tasks must use an existing
independent worktree root and branch from that repository. Non-Git tasks use ordinary
project directories. Branch/workspace creation remains an explicit setup operation.

## Dispatch and scheduling

`bot_task_create` accepts `project_id`, `workspace`, `branch`, `access_mode`, `resources`,
`dependencies`, `acceptance` and `authorization`. The server freezes a contract containing
project and role revisions, their instructions, the executor description and actual model
selection, canonical workspace, Git identity, dependencies and resource claims. Every
follow-up receives that contract again, with attachments preserved. Changing the account
workspace does not retarget a saved contract. A changed preset during dispatch is rejected.

Workspace ancestors/descendants, repository branches and explicit shared resource IDs
conflict when either task is a writer. Read/read claims can coexist. Claims and admission
are transactional; independent tasks continue up to the account concurrency limit and the
service-wide execution ceiling. Dependencies must have completed with evidence in the
same project at admission; later dependency changes require fresh dependent verification. Locks survive expired leases and failed stop requests. Native termination
must be acknowledged before releasing them, including recovery of terminal claims after a
crash. Queued work does not use an execution slot.

This is application scheduling and context separation, **not an OS or container sandbox**.
Read mode is an instruction plus a scheduling policy. Workers can still have their native
filesystem, credential and network capabilities. All processes touching a shared external
resource must participate in the same resource protocol for its scheduling guarantee to
apply. Arbitrary processes and direct shell commands do not acquire these claims.

`authorization` documents an existing authorization; it cannot grant permission. The API
checks account ownership and profile access, not the truth of a natural-language approval.

## Results and acceptance

Tasks with explicit `acceptance` criteria stay open when the worker returns successfully.
Their details expose a pending candidate with an execution-bound output hash and, for Git
projects, a commit ID. The owning controller must inspect evidence, then call
`bot_task_control` with `action=accept`, the exact `candidate` and `evidence`, or continue
for corrections. A changed commit, dirty worktree, newer execution or requirements change
rejects the old acceptance. Worker-question coordinators cannot accept their own tasks.
Acceptance text records the controller's review; it is not an independent test runner or
proof that untracked external services were checked. Non-Git evidence binds returned output,
not every file in the directory.

Legacy tasks and API callers that omit acceptance retain automatic completion for backwards
compatibility. The BOT instructions request concrete acceptance criteria for new work.
Scheduled tasks remain open for future occurrences. Pending candidates block dependencies
and stage advancement until accepted; explicitly closing an abandoned task is distinct
from accepting it.

## Knowledge boundaries

Each registered project has a separate memory database. Project-bound turns retrieve only
that project's history, and their user, partial, tool and final messages receive the project
identity in the same SQLite transaction as persistence. Account coordination history excludes
project-tagged messages. Legacy untagged history and memories remain in the account scope;
rebinding a role does not migrate them. Shared controller tools can intentionally coordinate
account tasks; project-scoped tools reject task, artifact, flow and schedule access outside
their bound project. Assistant schedules retain the project selected at creation.

Task callbacks and flow stages inherit their saved project rather than whichever project a
role later selects. Role changes wait for active replies, executions, flows, deliveries and
unreleased claims. Existing idle task contracts retain their saved instructions. Project
facts should be added with their sources; old account memory is not automatically copied.

## Flow records and migration

Flows are assembled for a goal. There is no required engineering step or fixed six-role
pipeline. New records carry `kind=business|acceptance`; the UI filters these separately.
An authenticated owner can classify an idle completed/stopped record without changing its
route, outputs or history. Existing records default to business until explicitly classified.

New tables and columns are additive. Deploy the code and schema together. Do not roll back
to an older scheduler while contract-bound work is active: it does not understand project
scopes or resource claims. Before rollback, stop workers, confirm native termination and
back up Studio state. The project and role APIs are documented in `docs/openapi.json`.
