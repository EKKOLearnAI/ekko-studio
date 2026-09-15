# Chat response annotation acceptance evidence

This document records the complete browser acceptance flow for the Rudder-aligned response annotation feature in Hermes Studio. The screenshots were captured from real Chrome runs against the final implementation and are committed as review evidence for PR #2918.

**Coverage:** direct chat, `Add to chat` only, annotation-only send, annotation plus ordinary message, annotation-owned attachment plus ordinary message, immutable sent evidence, and `Show source`.

**Browser verification:**

- `PLAYWRIGHT_CHANNEL=chrome PLAYWRIGHT_PORT=4173 npx playwright test tests/e2e/chat-response-annotations.spec.ts --project=chromium` — 1 passed
- Temporary acceptance flow for the mixed-message and attachment scenarios — 2 passed
- All screenshots are 1440×900 PNG captures from the browser page; no image was composited or manually edited.

## Flow A — annotation-only send

### 1. Initial completed Agent response

The user prompt and completed Hermes response are visible. No annotation is selected and no editor is open.

![01 — Initial response](assets/chat-response-annotations/01-initial-response.png)

### 2. Select an exact excerpt

The user selects `precise response excerpt`. The floating toolbar exposes exactly one action: `Add to chat`. `Ask in side chat` and Side Chat UI are intentionally absent.

![02 — Selection and Add to chat](assets/chat-response-annotations/02-selection-add-to-chat.png)

### 3. Open the annotation editor

After `Add to chat`, the editor shows the selected excerpt, an optional comment field, attachment control, Cancel, and Save.

![03 — Empty annotation editor](assets/chat-response-annotations/03-annotation-editor-empty.png)

### 4. Enter a comment

The optional annotation comment is entered as `Why is this precise?`.

![04 — Annotation comment](assets/chat-response-annotations/04-annotation-editor-comment.png)

### 5. Save the annotation

The response now shows the green source highlight and marker `1`; the composer shows `1 annotation`.

![05 — Saved highlight and marker](assets/chat-response-annotations/05-saved-highlight-marker.png)

### 6. Preview the draft annotation

Hovering the composer chip opens a bounded preview with the selected excerpt and comment.

![06 — Composer hover preview](assets/chat-response-annotations/06-composer-hover-preview.png)

### 7. Expand annotation details

Clicking the composer chip expands the ordered annotation details.

![07 — Expanded composer details](assets/chat-response-annotations/07-composer-expanded-details.png)

### 8. Send an annotation-only message

The user sends with no normal message text. The resulting user turn contains the annotation without an empty normal message bubble, and the composer draft is cleared after acceptance.

![08 — Annotation-only sent message](assets/chat-response-annotations/08-sent-annotation-only-message.png)

### 9. Open immutable sent evidence

The sent annotation evidence shows the selected excerpt, comment, and `Show source` action.

![09 — Immutable sent evidence](assets/chat-response-annotations/09-sent-immutable-evidence.png)

### 10. Restore the source

`Show source` restores and flashes the exact source range in the original Agent response while keeping sent evidence visible.

![10 — Show source](assets/chat-response-annotations/10-show-source.png)

## Flow B — annotation plus an ordinary chat message

### 11. Draft both annotation and normal message

The saved annotation remains attached while the normal Chat input contains `Please explain how this excerpt supports the answer.`.

![11 — Mixed annotation and message draft](assets/chat-response-annotations/11-mixed-annotation-and-message-draft.png)

### 12. Send both in one user turn

The sent user turn contains a normal message bubble and `1 annotation` together. This is not annotation-only and no Side Chat is rendered.

![12 — Mixed annotation and message sent](assets/chat-response-annotations/12-mixed-annotation-and-message-sent.png)

### 13. Inspect mixed sent evidence

The normal message remains visible while the annotation evidence card shows the selected excerpt, comment, and `Show source`.

![13 — Mixed sent evidence](assets/chat-response-annotations/13-mixed-annotation-and-message-evidence.png)

## Flow C — annotation-owned attachment plus an ordinary chat message

### 14. Add a file inside the annotation editor

The annotation editor contains the comment and the annotation-owned file `annotation-notes.txt` before Save. The file is not a generic composer attachment.

![14 — Annotation attachment in editor](assets/chat-response-annotations/14-annotation-attachment-editor.png)

### 15. Draft attachment, annotation, and normal message

The expanded annotation details show the excerpt, comment, and `annotation-notes.txt`; the normal Chat input simultaneously contains `Please use the attached notes when answering.`.

![15 — Annotation attachment and message draft](assets/chat-response-annotations/15-annotation-attachment-and-message-draft.png)

### 16. Send the combined message

The resulting user turn contains the ordinary message bubble and the annotation chip. The annotation-owned file remains associated with the annotation rather than being duplicated as a generic attachment.

![16 — Annotation attachment and message sent](assets/chat-response-annotations/16-annotation-attachment-and-message-sent.png)

### 17. Inspect sent evidence with the attachment

The immutable evidence card shows the selected excerpt, comment, `annotation-notes.txt`, and `Show source`.

![17 — Annotation attachment evidence](assets/chat-response-annotations/17-annotation-attachment-evidence.png)

## Acceptance summary

- Exact rendered excerpt selection: verified.
- Only `Add to chat` action: verified.
- `Ask in side chat`: absent by design and verified absent.
- Optional comment: verified.
- Green highlight and ordered marker: verified.
- Annotation-only send: verified.
- Annotation plus ordinary message: verified.
- Annotation-owned attachment: verified.
- Immutable sent evidence: verified.
- `Show source`: verified.
- No blocking visual defect observed in the captured flows.
