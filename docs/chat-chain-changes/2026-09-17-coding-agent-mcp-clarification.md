---
date: 2026-09-17
pr: 3085
feature: Coding agent MCP user clarification
impact: Headless coding agents can ask a question in the existing Studio/App interface and continue with the user's answer.
---

## Transport and scope

The existing `ekko-studio-plan` MCP now exposes both `ekko_studio_update_plan`
and `ekko_studio_clarify` as direct tools. Task cards and user questions share
one managed MCP server. Claude Code, Codex, Pi, Grok, OpenCode, and
DSH receive it through their existing managed configuration paths. It accepts
`context_id`, a `question`, and optional string `choices`; free-text answers are
allowed even when choices are supplied. There are no new client components.
Ekko keeps its native `clarify` tool, and Pi keeps its native RPC UI support.

The latest input of an interactive coding-agent turn receives a
`studio_interaction_context` instruction. It uses that turn's capability id,
also used for its task card, with a separate interaction binding. Context ids
are excluded from the stored/displayed user input and stable system prompt.
Direct chats and group chats receive bindings; workflows and global background
agents do not. Standalone terminals have no binding. The prompt instructs
delegated subagents not to use the parent interaction tool.

The tool posts to `/api/studio/clarifications/request` with the existing profile
authentication. Studio resolves the session and history turn marker from the
binding instead of accepting caller-supplied session/run ids. Other profiles,
expired contexts, idle/aborting turns, invalid inputs, and simultaneous questions
within one session are rejected. One question can wait up to five minutes.
Managed CLI tool-call budgets are at least six minutes. The HTTP transport has
a 330-second deadline rather than fetch's default response-header deadline.

## Events and lifecycle

`clarify.requested` uses the existing question, choices, requested-at, timeout,
and remaining-time fields. Direct chats answer over `clarify.respond`; group
chats use the existing manager relay. The HTTP request returns the actual answer
and an explicit `reason`: `response`, `dismissed`, `timeout`, or `cancelled`.
An absent response is never approval. Resolution broadcasts `clarify.resolved` and
removes pending replay state, including when a user answers from another client.

Completion, failure, stop, replacement by a new turn, session disposal, and
server shutdown invalidate bindings and settle pending waits. MCP cancellation,
stdio closure, or HTTP disconnection also cancel the waiting question. A client
UI disconnection alone leaves the question available for reconnect/resume.
Bindings are in-memory and intentionally do not survive server restart.

After upgrading, restart Studio and any existing coding-agent processes so they
load the updated plan MCP tool catalog. Tool use depends on the agent following the injected
instructions and the managed plan server being enabled.

## Validation

- Service/controller tests cover choice/free-text replies, dismissal, validation,
  timeouts, cancellation, profile/session isolation, and stale turns.
- Socket tests exercise both direct-chat and group-chat response entrypoints,
  pending replay cleanup, and abort cleanup.
- MCP subprocess tests verify direct discovery, blocking until the HTTP answer,
  response forwarding, and cancellation notifications.
- Configuration tests verify all six CLI families receive the tool and budgets.
- Existing browser clarification tests cover the reused question interface.

These tests simulate agent calls and user replies; they do not depend on a live
model account or establish that every model will choose to call the tool.
