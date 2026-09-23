---
date: 2026-08-19
feature: mobile-locale-toggle-accessibility
pr: 2616
impact: Mobile users gain an in-page language switch on chat home, group chat, history/workflow sidebars, and the shared group chat invite gate; no chat message flow, session chain, or API behaviour changes.
---

# Mobile locale toggle accessibility (iOS)

On phone-width viewports the `LanguageSwitch` component only existed inside
`AppSidebar`, which never renders on the chat home, group chat, history, or
workflow screens — and never at all on the public shared group chat view. Mobile
visitors with a Chinese browser locale were stuck with no way to switch the UI
language.

This PR adds `LanguageSwitch` to:

- `packages/client/src/components/hermes/chat/ChatPanel.vue` — page-sidebar bottom
- `packages/client/src/components/hermes/group-chat/GroupChatPanel.vue` — sidebar bottom and the standalone header
- `packages/client/src/components/hermes/chat/PageSidebarFooter.vue` — history/workflow sidebar footers
- `SharedGroupChatView.vue` — invite card header on the public share entry

All additions are presentational: the switcher writes the same persisted locale
record and calls the same `applyDocumentDirection` logic as the existing
`AppSidebar` instance. No chat session chain, run-chat, group-chat runtime, or
API code paths are touched; messages and session data are unaffected.
