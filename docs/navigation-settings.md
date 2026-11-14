# Navigation settings

The avatar menu opens **Navigation settings** as a modal over the current page.
Closing it preserves the route, mounted workspace and draft. The dialog only
manages navigation entries. General settings and the plugin center retain their
existing navigation positions; the avatar menu adds only Navigation settings.

The ordered selection belongs to the signed-in Studio user, independently of
Agent profiles and themes. `GET /api/navigation` returns `{items: string[]}`;
`PUT /api/navigation` replaces it. Defaults contain built-in entries only.
An explicitly empty list stays empty. Restoring defaults removes plugin shortcuts.
Built-ins may be removed and re-added; the avatar remains accessible at all times.
The built-in plugin center is included in defaults. Early saved selections that
omitted it are upgraded once by inserting it before the relay entry, or at the
end when no relay is selected. The upgrade preserves all other entries and their
relative order, is persisted per account, and does not override later explicit
customizations.

Startup and login without an explicit destination use `/home` to resolve the
first currently available entry in the user's saved navigation order. This
includes registered, selected plugin pages, and skips disabled plugins and
entries unavailable to the account. Desktop main windows use the same entry.
An empty/unavailable selection or failed initial settings load falls back to
general settings. Explicit page/session links and refreshes retain their target;
changing navigation order does not redirect an already open page.

Plugin entries use `plugin:<pluginId>/<viewId>`. Only active plugins with explicit
`manifest.navigation.main` registrations targeting declared views are offered.
Pages, tools, Agent settings and workspace sidebars do not implicitly register
main navigation. Installation or activation never opts an entry in. Previously
selected unavailable entries are hidden from the rail, remain removable in the
dialog, and recover their original order when their registration becomes active.
The API also rejects new unregistered selections. Saved shortcuts never grant
permissions or bypass the destination's normal access checks.

The dialog uses VueDraggablePlus (SortableJS) for handle-based sorting, with
animated displacement, a visible drop placeholder, a lifted row and edge
auto-scroll. Touch handles use a short hold before dragging; ordinary row content
remains scrollable. Motion follows the system reduced-motion preference.
Reordering saves once on drop and retains entries hidden by account permissions.
Keyboard move buttons remain available, and save failures restore the prior order.
The dialog supports search, a live
preview, immediate account-scoped persistence and rollback on save failure.
Loading failures require a retry before editing, so they cannot overwrite stored
settings with defaults. Authentication changes invalidate pending state. Dialog,
card and input surfaces follow Studio theme tokens; narrow windows use a compact
layout with accessible move controls.
