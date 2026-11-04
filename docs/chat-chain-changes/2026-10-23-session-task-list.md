# Session task list and chat turn navigation

- Scope: responsive Studio Web UI and Desktop, with a companion native App list.
- Extends: `2026-10-22-session-task-summaries.md`.

The task button in the primary single-chat header opens a right drawer. Its
clipboard icon follows the header's SVG style and is 16px; the drawer title uses
an 18px icon. There is no task entry in the navigation rail. On desktop the drawer
is up to 1200px wide and follows the shared shell header boundary; on mobile it
fills the viewport. The list fills the drawer body with no inset card, outer
margins, statistics or banner. The mobile status filter aligns to the trailing
edge with the same 20px content inset.

Search, status filtering and update-time sorting live in the table header. Tasks
sort by update time only, newest first by default, regardless of status. The time
column toggles oldest first; equal timestamps use task ID for stable pagination. Each
summary is a native details/summary disclosure: it defaults to one line and
expands in place without navigating. The task title and trailing SVG arrow open
the associated chat turn. Expanded summaries use the title's full text width;
the collapse icon sits on the following line without reserving a side column.
Status, disclosure, sort and navigation icons are SVG,
not character substitutes. Below the summary, mobile pairs a 34px agent logo
with a two-line source block: conversation name above the status and update time.

The drawer uses the overlay theme surface once; its table and wrappers remain
transparent. The shared drawer, dropdown and input adapters handle custom colors,
opacity, wallpaper and blur. Keyboard focus is trapped by the drawer and returns
to its header trigger after closing.

`tasks=1` in the chat URL opens the drawer. Filter and pagination state use
`taskSearch`, `taskStatus`, `taskOrder` and `taskPage`, so browser Back from a task
reopens the same filtered drawer. The former `/hermes/tasks` URL redirects to this
chat drawer and translates its old filters. The drawer refreshes on focus and
every 30 seconds while visible; closed drawers do not fetch or intercept search
shortcuts. Reading tasks never changes their status.
Each filtered list is capped at 100 tasks across pagination. Both clients clamp
older server responses too; repository counts and page bounds enforce the same
window without deleting stored goals. Existing session deletion/history clearing
removes task rows in its transaction, with direct database cleanup regressions.

`GET /api/studio/session-tasks` returns tasks, total and has_more. The controller
validates filters/pagination and resolves existing profiles permitted to the
account. SQL applies that scope and pending-deletion exclusions before counting
or paging. Run credentials remain profile-bound. The list includes archived
single-chat sessions; group/workflow/global-agent sessions are excluded.

The returned `session_title` uses the conversation list's display-name rules:
prefer an explicit title, then the stored preview or first user message, with
the same newline handling and 40-character truncation. Studio and App task rows
therefore show the same name for untitled sessions without per-row session
requests or persisted renames. Search also matches this first-message fallback.

Each task title and trailing action link to `/hermes/session/:id?profile=...&message=...`. An open task
uses its recorded request anchor; a completed task uses its completion anchor.
Hidden tool anchors are resolved to the preceding visible user message so the
link lands at the beginning of the associated turn. The persisted ledger still
has the original write-boundary semantics: recovered older tasks are anchored
to the request that recorded them, not retroactively inferred messages. There
is no invented history of per-task progress events.

ChatView carries the explicit message into the existing chat store selection.
The existing history pagination and virtual-list alignment load and highlight
old messages, including messages outside the normal live-chat history cap.
Direct links and reloads use the same flow. Sessions outside the sidebar page,
including archived sessions, are fetched through the existing authorized session
read and then resumed. Missing/deleted message targets fall back to the session
with a warning instead of claiming a successful highlight.

No database schema, model/MCP tools, task-plan lifecycle or group/workflow runtime
changes are introduced. The companion App uses the same list endpoint through its
authenticated relay and passes message_id into its existing matched-message
navigation. Task lists expose only the session goals already maintained by the
primary conversational model.

Live Coding Agent user turns now retain the ID returned by database persistence,
instead of their array position. Task links use those durable IDs; previously a
short live resume could contain the requested turn under a different ID and
report it missing without another history page to load. The companion App also
repairs existing live resumes by matching one persisted user turn by role,
timestamp and displayed content and retaining its local row as an alias. It does
not replace streaming content or accept an ambiguous match. App task buttons
omit press highlights and navigation spinners while still guarding duplicate opens.
