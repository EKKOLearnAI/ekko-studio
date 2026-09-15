# Chat Response Annotations Proposal

**Status:** Accepted for implementation
**Date:** 2026-09-05
**Target:** Hermes Studio direct chat
**Reference:** Rudder `CHAT.RESPONSE.ANNOTATION.001` and the three user-supplied Rudder screenshots

## Goal

Bring Rudder's response-annotation workflow to Hermes Studio: a user can select an exact excerpt from a completed Agent response, add it to the current chat as an ordered annotation, optionally comment on it or attach files, and send the annotation as durable, structured user context.

The interaction and visual hierarchy should follow Rudder. The deliberate Hermes-specific difference is that Hermes Studio has no Side Chat: `Ask in side chat` must not be rendered, focusable, announced, or implemented.

## Research summary

Rudder's current implementation is defined by `CHAT.RESPONSE.ANNOTATION.001` in `doc/product/domains/collaboration/chat-messenger-im.md`, not only by its original July implementation plan. The relevant implementation surfaces are:

- selection anchoring and rendered-text mapping: `ui/src/lib/chat-response-annotation-selection.ts`
- selection toolbar: `ui/src/components/chat/SelectionAnnotationToolbar.tsx`
- draft reducer and limits: `ui/src/lib/chat-response-annotations.ts`
- highlights, numbered markers, editor, draft and sent cards: `ui/src/components/chat/ResponseAnnotations.tsx`
- source navigation: `ui/src/lib/chat-response-annotation-navigation.ts`
- typed payload and validation: `packages/shared/src/types/chat.ts` and `packages/shared/src/validators/chat.ts`
- prompt projection and durable message-owned snapshots: `server/src/services/chat-assistant.annotations.ts` and `server/src/services/chats.annotation-persistence.ts`

Hermes Studio's current direct-chat path provides the seams needed for the same user experience:

- `MessageItem.vue` owns stable assistant and user-message rendering.
- `MarkdownRenderer.vue` produces the selectable rendered DOM.
- `ChatInput.vue` owns composer drafts, files and submission.
- `stores/hermes/chat.ts` owns optimistic messages, upload, queueing and Socket.IO run payloads.
- `display_input` / `storage_message` already support separate user-visible and model-visible persisted representations in Hermes and Ekko runs.
- The coding-agent runtime already supports a storage-input override but needs a small extension to persist a separate display representation consistently.
- SQLite messages already have `display_content`; no schema migration or independent annotation table is required.

## Product and interaction contract

### Eligible source

- A non-empty selection contained in one stable, non-streaming, non-error assistant answer body.
- Selections may span paragraphs, lists, links, inline code, fenced code and CJK text.
- User, system, reasoning, tool-output and cross-message selections are rejected.
- Copy buttons and other renderer chrome are excluded from the semantic text surface.

### Selection action

- Mouse/touch selection shows a floating, collision-aware toolbar near the selection.
- The toolbar contains exactly one action: `Add to chat`.
- A Shift+Arrow/Home/End keyboard selection moves focus into the toolbar; pointer selection does not steal focus.
- Escape, selection collapse, source removal, or an outside action dismisses the toolbar.

### Draft annotation

- `Add to chat` appends one annotation in insertion order and is idempotent for the same source range.
- The exact source range receives a translucent accent highlight and a numbered circular marker.
- Adding or activating a marker opens one floating editor anchored near the source without changing composer height.
- The editor focuses `Add an optional comment...` and provides annotation-owned file attachment, Delete, Cancel and Save actions.
- Cancel restores the prior annotation draft. Save commits local comment/file changes without sending. Delete removes the annotation and renumbers the remainder.
- Limits follow Rudder: 10 annotations per turn, 4,000 selected characters per annotation, 2,000 comment characters, and 10 annotation-owned files in total.

### Composer

- A compact `N annotation(s)` chip appears above the input surface.
- Hover/focus exposes bounded details; explicit activation opens the ordered list.
- Each row separates `N. Selected excerpt` from optional `Your comment`, shows its files, and exposes Edit/Delete.
- The chip's separated clear action removes all annotations but preserves normal composer text and attachments.
- Annotation-only Send is valid in an existing conversation.

### Send, persistence and model context

- The UI sends two representations in one existing run request:
  - **model/storage representation:** an ordered, bounded `<response_annotations>` section followed by the ordinary user body; selected excerpts are explicitly labelled untrusted user-quoted context, comments retain user authorship, and files remain associated with their annotation;
  - **display representation:** a strict versioned JSON envelope containing the ordinary body and immutable annotation snapshots.
- The model/storage representation is written to `messages.content`; the display envelope is written to `messages.display_content`.
- The client parser recognizes only the exact versioned envelope and fails closed to ordinary message rendering for malformed data.
- Queue delivery preserves both representations through the existing `QueuedRun.displayInput` and `storageMessage` fields.
- Hermes, Ekko and coding-agent direct-chat paths must persist the same dual representation.
- A failed upload or pre-dispatch submission retains the body, ordinary files and annotation draft for retry.

### Sent evidence

- The sent user turn renders a read-only annotation count chip above its ordinary body; an annotation-only turn does not render an empty bubble.
- Expanding the chip shows immutable ordered entries with `Selected excerpt`, optional `Your comment`, files and `Show source`; no edit/delete controls appear.
- Expanding a sent set temporarily restores its numbered source highlights.
- `Show source` resolves by exact current message id first and by source hash/context fallback after reload, scrolls the source into view, and briefly emphasizes it. If unavailable, the immutable excerpt remains readable and an explicit unavailable state is shown.

## Technical design

### Typed annotation envelope

Add client-owned types and pure helpers under `packages/client/src/utils/chat-response-annotations.ts`:

- source identity: message id, source hash, semantic rendered offsets, selected snapshot, bounded prefix/suffix;
- ordered draft/sent annotation fields, including annotation-owned file descriptors;
- validation, deduplication and ordinal normalization;
- strict versioned display-envelope encode/decode;
- escaped model-context projection that cannot terminate its wrapper with selected text.

The annotation is owned by the user message snapshot rather than an independently mutable entity.

### Selection and highlights

Add `packages/client/src/utils/chat-response-annotation-selection.ts` for:

- semantic visible-text collection with block line breaks and ignored chrome;
- DOM Range to semantic offsets and reverse restoration;
- toolbar/editor placement with 8 px viewport gap/padding;
- clipped highlight rectangles and marker placement.

Add `ResponseAnnotationSource.vue` around the final assistant Markdown body. It owns selection observation, the one-action teleported toolbar, non-interactive highlight overlays, numbered markers, resize/scroll recalculation, and source-navigation events.

### Draft state and UI

Add a focused Pinia store `stores/hermes/chat-annotations.ts`, keyed by session id. It owns ordered annotations, active editor/list state, the inspected sent set, validation and versioned local draft persistence. File bytes remain in memory; serializable excerpt/comment/source metadata survives remount.

Add:

- `ResponseAnnotationEditor.vue` for the Rudder-style anchored editor;
- `ResponseAnnotationComposer.vue` for the draft chip/list and edit/delete/clear flow;
- `SentResponseAnnotations.vue` for immutable sent evidence and `Show source`.

All visible strings are added to every locale file. Components use Hermes Studio theme variables and existing Naive/Vue patterns; no UI dependency is added.

### Chat integration

Update `MessageItem.vue` to:

- wrap only stable assistant final-answer Markdown as an annotation source;
- parse strict annotation display envelopes on user messages;
- render the ordinary body normally and sent evidence separately;
- exclude annotation-owned content blocks from the generic attachment gallery.

Update `ChatInput.vue` to:

- show the annotation composer surface;
- permit annotation-only Send;
- merge annotation-owned files into the existing upload path;
- clear the draft only after the run has been synchronously dispatched.

Update `stores/hermes/chat.ts` and `api/studio/chat.ts` to:

- accept an annotation snapshot on `sendMessage`;
- materialize uploaded annotation file descriptors;
- build model, storage and display representations;
- preserve them in optimistic, queued and resumed messages;
- return a submission result so the composer can retain failed drafts.

Extend the coding-agent send path (`handle-coding-agent-run.ts`, coding-agent service facade and run manager) so a user message can store model content plus a distinct `display_content`, matching existing Hermes/Ekko behavior.

## TDD and verification plan

1. **Pure envelope/state tests** — fail first for validation, dedupe, ordering, strict parsing, escaped prompt projection, attachment ownership and annotation-only eligibility.
2. **DOM selection tests** — fail first for paragraphs, links, CJK, inline/fenced code, ignored controls, reverse restoration and cross-source rejection.
3. **Component tests** — fail first for the one-action toolbar, focused editor, marker/highlight, composer chip/list, edit/delete/clear, sent immutable card and source navigation.
4. **Chat transport tests** — fail first for dual representation across Hermes/Ekko queueing and coding-agent persistence.
5. **Playwright flow** — select rich assistant text, add annotation, comment/attach, save, verify numbered highlight, send annotation-only, inspect the emitted run payload, inspect immutable evidence, and use `Show source`; assert `Ask in side chat` is absent.
6. **Responsive/visual checks** — desktop and narrow viewports, dark and light themes, no horizontal overflow, editor/toolbar inside viewport, visible focus states and reduced-motion behavior.
7. **Repository gates** — focused Vitest, focused Playwright, `npm run harness:check`, `npm run test:coverage`, `npm run test:e2e`, and `npm run build` after the final edit.
8. **Independent gates** — separate spec/UX reviewer and adversarial code reviewer must explicitly approve the final diff; timeout or tool failure is not approval.

## Risks and mitigations

- **Markdown source drift:** store the rendered semantic offsets plus source hash and surrounding context; refuse a mismatched source rather than highlighting different text.
- **Streaming rerenders:** annotation eligibility begins only after streaming stops; overlays recalculate on resize, scroll and DOM changes.
- **Optimistic ids differ from SQLite ids:** navigation tries current id, then hash/context fallback.
- **Display envelope spoofing:** require an exact version marker and strict bounded shape; malformed data renders as ordinary text.
- **Prompt injection in selected text:** project annotations as escaped JSON inside an explicitly untrusted user-context section, never as system instructions.
- **Attachment duplication:** annotate uploaded content blocks with ownership metadata and omit those blocks from the generic gallery while keeping them in the annotation card.
- **Baseline test noise:** record pre-existing failures before edits and require zero new failures in changed-path verification.

## Out of scope

- Side Chat and all `Ask in side chat` rendering/logic.
- Annotation of user/system messages, reasoning, raw tool output, workspace files, browser pages or group chat in this PR.
- Collaborative threads, replies, reactions, resolved state, server-side annotation search or automatic semantic re-anchoring.
- A new database table or standalone annotation API.
