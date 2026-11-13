# 2026-11-13 — Preserve local group discussion during the Ekko merge

Commit/PR: pending integration merge on `codex/merge-ekko-main-20261113`.

The local discussion runner, document-reading pipeline, document registration,
and delivery actions now belong to `modules/studio`. Current clients call
`/api/studio/group-chat/rooms/:roomId/discussion` and the sibling document and
delivery endpoints. Existing `gc_discussions` and document tables keep their
names and data location under the Web UI home.

Discussion runs pause explicit mention routing and automatic room routing,
retain the sequential speaker/judge/report loop, and broadcast discussion and
reading progress through the existing group socket. Discussion tool approvals
use the active executor's existing runtime adapter with one-time permission.

Discussion compaction uses the upstream summary leases and generation checks.
It advances the shared-memory anchor while keeping raw transcript rows in
history. Document report bookkeeping is excluded from Agent context. Uploads
stream with bounded buffering and reject incomplete multipart bodies.

Validation: focused runner, document parser/pipeline, streaming upload, SQLite
persistence, real Socket.IO routing, and summary-compaction tests.
