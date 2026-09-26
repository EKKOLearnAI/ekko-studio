---
date: 2026-06-06
pr: 1110
feature: Session outline Q&A pairs and load-all button
impact: Outline panel now shows Q&A pairs instead of markdown headings. Added load-all button in chat and history views. Exported mapHermesMessages for outline panel use.
---

- `OutlinePanel.vue` — rewritten to display user/assistant Q&A pairs as expandable items instead of markdown heading extraction. Supports both ChatView (chatStore-managed) and HistoryView (local ref) contexts. CRON command messages are shown as questions.
- `ChatPanel.vue` — added "Load All Messages" button using `fetchHermesSession` API for loading full conversation messages.
- `MessageList.vue` — strips leading command/system messages before the first user message so loaded sessions don't show phantom init content at the top.
- `HistoryView.vue` — added load-all button support for outline panel since new pagination only loads 300 messages.
- `chat.ts` — exported `mapHermesMessages` for use in OutlinePanel. Added `hasRuntimeToolPayload` / `runtimePayloadText` / `runtimeToolOutputHasError` helpers.
