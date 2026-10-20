# Native Ekko AI conversation titles

## Problem

Native Ekko direct chats initialize a title from the first user input but do not schedule an AI title request after a successful answer. Hermes bridge runs have a separate title-generation path, which native Ekko never executes.

## Changes

- Schedule tool-free title generation after a successful, nonempty native Ekko reply without awaiting it in the foreground completion path.
- Reuse the authorized session model client in automatic mode. Resolve explicitly configured auxiliary providers through the existing authorized provider runtime, without carrying the session provider's credentials into another provider.
- Track fallback/manual/AI provenance and a persistent two-attempt budget through the Studio-owned schema synchronizer.
- Protect explicit renames, history clears, deletion/recreation, and concurrent turns with history revisions, message anchors, and conditional title updates.
- Publish the existing `session.title.updated` event only after a successful write.
- Bound request deadlines and log sanitized failure reasons rather than provider exceptions or prompts.

## Validation

The focused service and foreground-run regression suites cover asynchronous completion, provider selection, streaming output, bounded retries, deadlines, title provenance, and stale-write races. Real-model service smoke tests also generated and persisted AI titles through the configured Codex Responses provider.

A separate HTTP chat-run end-to-end attempt is not claimed as passed: after correcting its missing `apiMode`, the endpoint returned a Socket.IO authentication failure before a run could start. This is independent of the title-service regression coverage.
