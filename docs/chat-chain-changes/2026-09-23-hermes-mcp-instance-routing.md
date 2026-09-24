---
date: 2026-09-23
pr: pending
feature: Hermes managed MCP instance routing
impact: Hermes task plans reach the Studio instance that created their turn context when desktop and development servers share a Hermes profile.
---

## Failure

Studio auto-injection persists managed MCP launch settings in the shared Hermes
profile. Starting a second Studio instance can replace the first instance's URL
and state directory. A later worker in the first Bridge then reads those settings
and sends plan updates to the second server. Per-turn task-plan bindings live in
the owning server's memory, so even a fresh context returns HTTP 409 with
`Task plan context is unavailable or has expired`. Retrying or changing models
does not correct the destination.

## Change

The Bridge manager carries its Studio URL and state directory in a separate
process environment value. Before Hermes initializes tools, the Bridge wraps
the runtime's MCP subprocess environment builder. For entries explicitly marked
`HERMES_WEB_UI_MANAGED_MCP=1`, launches and reconnects use that owner URL/home,
the worker profile and Electron Node mode. A stale explicit managed token is
removed so normal profile token lookup uses the owner's state directory.

The wrapper copies launch arguments without writing the shared YAML. It leaves
user-owned MCP servers and standalone Hermes processes unchanged, and supports
both split and legacy Hermes MCP module layouts. Existing workers need a Studio
restart after installing this fix; already-failed turns are not restored.

Model selection still targets a specific session and its Agent. Switching an
active session queues the switch until the run ends. Plan contexts remain bound
to a session/turn, independently of model selection.

## Validation

- Manager tests cover stale inherited owner settings.
- MCP launch tests cover split/legacy layouts, profile isolation, no YAML/env
  mutation, idempotent installation and unchanged user-owned servers.
- A real MCP subprocess test uses two HTTP servers: the stale launch reproduces
  409, while the same config succeeds against the owner after installing the hook.
- Bridge model-switch regression checks that another running session keeps its
  original model, provider and configuration.
