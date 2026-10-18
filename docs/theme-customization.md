# Studio theme customization

Theme settings belong to the signed-in Studio user. They are independent of
Agent profiles and remain available after switching profiles. Each named theme
includes brightness, Ink/Comic style, appearance overrides and its wallpaper.
Legacy device preferences are retained until the first edit or theme creation.
Backgrounds support JPEG, PNG, GIF, WebP and APNG files up to 30 MiB. Animated
GIF, WebP and APNG play in both the workspace and background preview. Uploads,
local caching and theme ZIP import/export preserve the original image bytes,
including every frame, frame delay and loop setting. APNG uses the PNG media
type and archive filename while retaining its animation.
Brightness, style, font size, text color and selection color live in the appearance
editor's **Global** scope alongside the other global controls.

## Configuration and inheritance

`packages/shared/theme-appearance.ts` is the validated configuration contract.
The existing `fontSize`, `textColor`, `accentColor` and uploaded background are
preserved. The new sparse `appearance` object contains `global` settings and
overrides for eight regions:

| Region | Surfaces |
| --- | --- |
| `chrome` | Navigation rail, title bar, page header |
| `sidebar` | Page, session, room and workflow sidebars, plus the group member avatar rail |
| `content` | Main page, chat and workflow surfaces |
| `card` | Settings, models, profiles, tasks, tables and other cards |
| `input` | Composer, text inputs, selections, connection view selectors and switch tracks |
| `overlay` | Dialogs, drawers, popovers, menus and notifications |
| `userMessage` | User message bubbles |
| `assistantMessage` | Assistant message bubbles |

Each region can override background color, background opacity, blur, corner
radius, border color and shadow. Resolution is **local override → global
override → preset**. Missing/null properties inherit; zero is a valid explicit
value. Resetting one control removes only that override. Restoring defaults
clears all appearance overrides and the three original color/font controls;
the uploaded background retains its separate removal action.

Global settings additionally control secondary/muted/link colors, background
gradient and image fit/position/dimming, border width, control height, spacing,
chat width, font family, line height and letter spacing. Background opacity
changes the surface color's alpha, never the opacity of its text or children.
Ordinary borders and dividers use the same resolved opacity as their region,
including custom border colors and component-owned table/drawer dividers.
Nested regions resolve their own opacity instead of multiplying their parent's
alpha. Active, focus, warning and error indicators retain their state styling.
Nested translucent surfaces still composite according to normal CSS rules.
The navigation rail, top bar and outer gutters share one continuous chrome
background and blur layer. Their controls stay transparent: independently
filtered surfaces can sample neighboring content differently and leave a visible
seam. Chrome opacity follows global settings until overridden for that region;
sidebar settings do not change the outer frame. Content surfaces composite over
their own base, independently of chrome.
Chat width only constrains outer message rows when explicitly configured;
card appearance changes do not change the alignment of nested tool messages.

## Runtime paths

- `styles/theme-appearance.ts` resolves one configuration into CSS tokens.
- `styles/theme.ts` uses the same resolver for Naive UI overrides.
  Default bordered and borderless tags inherit the card background and opacity,
  including wallpaper glass defaults. Semantic and checkable tag colors retain
  their own states; clearing customization restores the preset tag fills.
  Switch tracks inherit input opacity (0.72 with a wallpaper and no override).
  The inactive track tints the input background; the active track keeps the accent
  hue. Thumbs, focus indicators and disabled behavior remain independent of fill
  opacity. Connection view/source selectors share the input surface and use a
  translucent selection tint instead of an opaque nested button.
- `styles/_theme-surfaces.scss` maps region properties to native and teleported
  surfaces. Property classes exist only while the corresponding override is set.
  Wallpaper defaults cover the same overlay list, including the account popover,
  Profile dialog and select menus. Select labels/tags stay transparent over their
  themed wrapper so they cannot hide or double the configured background alpha.
  Disabled/loading selections keep that surface; muted text/icons and disabled
  interaction still indicate their state without flashing a preset background.
  New card surfaces can opt in with `data-theme-surface="card"`; description
  tables, the shared promotion hero, download platform cards, cloud route cards
  (list and scan dialog), and Petdex summary/pet cards use this scope.
  Petdex keeps its preview checkerboard transparent and lets the parent content
  surface own custom page backgrounds. Promotion/download, cloud route and Petdex
  cards use a translucent wallpaper fallback, and small badges/icons add only a
  tint. QR code backgrounds stay opaque for scanning.
  The card attribute supplies this wallpaper fallback centrally, including for
  new cards that only declare a shared preset background in their scoped CSS.
  Description tables use translucent headers instead of opaque
  fills. When card blur is configured, outer content surfaces paint their own
  background/filter on a pseudo-element so they do not isolate the cards from
  the wallpaper. Blur remains visually hidden behind fully opaque surfaces.
- Data tables, simple Naive tables, description tables, native plugin/usage/runtime
  tables, skill statistics and Markdown tables outside message bubbles use the card region.
  Tables inside message bubbles share the message background, filter and border
  tokens without adding another card surface. Standalone
  tables paint on their wrapper; native tables inside a card reuse that card's
  surface. Headers, striped rows, sorting and hover states add translucent tints
  instead of preset white/black fills. Data table row groups and rows stay
  transparent to avoid applying the same alpha several times, including virtual,
  modal/popover and empty tables. Fixed columns keep a separate 12px backdrop blur
  for legibility when scrolling, even if card blur is zero. Table and enclosing
  settings-card blur paint on sibling layers so they do not block this effect.
  External HTML/Office documents retain their authored table styling.
- Existing pixel spacing/font sizes and radii use optional variables with their
  previous values as fallbacks, preserving the default preset geometry.
- `useTheme.ts` applies previews synchronously and serializes saves. Older
  responses cannot overwrite a newer preview or another user's active settings.
  A failed final save restores the last committed state. Wallpaper uploads use
  the same queue and update only their own metadata.
- `ThemeAppearanceEditor.vue` previews on `input` and saves on `change`, so
  dragging a range does not write to the server for every frame.

The server stores `appearance_json` in `user_themes` using the existing schema
migration mechanism. Writes reject unknown fields and invalid ranges/colors;
reads tolerate legacy or malformed saved fields. `background_updated_at` is a
separate image cache version: editing appearance does not download the wallpaper
again. Existing wallpaper versions migrate from the prior record timestamp.

## Named themes

The Theme page includes **My themes** with create, duplicate, rename, delete and
activate actions. Existing customization is preserved as the first theme when
its library is first opened. A new theme starts with default customization and
no wallpaper; duplication copies the selected theme. Edits automatically update
the active theme. Deleting the active theme selects the oldest remaining theme;
the last theme cannot be deleted. Names contain 1–80 characters.

`user_theme_presets` stores user-owned snapshots. `user_themes` retains the
current settings for the existing theme and login endpoints, plus
`active_preset_id`, `brightness` and `style`. Active settings and their snapshot
are updated in the same transaction. Creation, migration and deletion are also
transactional. Every lookup includes the authenticated user ID.

- `GET /api/theme/presets`: initialize/read the library.
- `POST /api/theme/presets`: create and activate; optional `sourceId` duplicates.
- `PATCH /api/theme/presets/:id`: rename.
- `POST /api/theme/presets/:id/activate`: restore all settings.
- `DELETE /api/theme/presets/:id`: delete and return the resulting active theme.
- `GET /api/theme/presets/:id/export`: download an owned theme ZIP.
- `POST /api/theme/presets/import`: upload ZIP bytes (`application/zip`), create
  and activate a new theme, and return the updated library and active settings.

**Import ZIP** accepts a theme archive up to 32 MiB. **Export ZIP** packages the
current theme after pending saves complete. A failed pending save prevents export
of stale settings. Import creates an independent theme, even when its name matches
an existing theme, and switches to it. An invalid file leaves the library unchanged.

The versioned ZIP contains `theme.json` and, when present, `background.png`,
`background.jpg`, `background.webp` or `background.gif`. The manifest has
`format: "ekko-studio-theme"`, `version: 1`, `name`, `settings` (brightness, style,
fontSize, textColor, accentColor and appearance) and `background` (null or
`{ file, name }`). It contains no user/preset IDs, server paths or timestamps.
The manifest is limited to 64 KiB and the background to 30 MiB. Both endpoints
accept optional `brightness` and `style` query parameters to preserve legacy
device-only preferences. Import validates paths, file types, sizes, CRCs and
settings before committing a new snapshot. ZIP entries are read into bounded
buffers, never extracted to supplied paths. Failed persistence removes staged
images and rolls back the library and active selection.

Client library operations share the save/upload queue. Controls are disabled
while switching, and failed operations retain the committed theme. Writes pass
an expected `presetId`, rejecting a stale tab with HTTP 409 instead of modifying
a different active theme. Wallpaper reads may target a specific owned preset.
Duplicate themes share immutable image files; replacing or deleting a wallpaper
only unlinks files without remaining references. Image versions are allocated
across the user's themes to prevent cache collisions. Account deletion removes
all preset records and the account's wallpaper directory.

## Special renderers and boundaries

- Xterm has a **Follow Studio theme** choice and updates its palette/font size
  live. Previously selected terminal palettes remain explicit user overrides.
- Monaco updates its theme, foreground/background, cursor, selection, font size,
  line height and letter spacing through the editor API without replacing text.
- Mermaid uses Studio colors and redraws diagrams on theme changes.
- The owned DSH frame receives validated theme tokens alongside brightness.
  Native plugins can consume these tokens; plugin-owned layouts and arbitrary
  third-party styling are not rewritten.
- Voice UI surfaces/text can follow custom backgrounds. Voice artwork, Agent
  cards' decorative illustration, logos, avatars and pet artwork retain their
  authored appearance. Circular markers and pill shapes remain circular/pill.
- Syntax highlighting, diff additions/deletions, graph category colors and
  success/error indicators retain semantic colors. Their surrounding surfaces,
  text sizing and ordinary controls follow the theme.
- External browser pages, document previews and images keep their original
  content styling. Separate native browser/screenshot windows are not DOM
  descendants of Studio and do not inherit these CSS tokens.

When adding a surface, reference its region token with a preset fallback. Do
not set `opacity` on a container to implement surface transparency. If a library
renders into a canvas or isolated document, provide an explicit theme adapter.
The required authoring rules, mechanical checks, legacy inventory and scoped
exception format are in [the frontend UI harness](harness/frontend-ui.md).

## Validation

`theme-appearance.test.ts`, `theme-save-order.test.ts` and `user-theme.test.ts`
cover validation, inheritance, zero values, renderer palettes, ordered saves,
rollback, account isolation, legacy wallpaper migration, theme CRUD and shared
wallpaper lifetimes. Theme switching waits for pending saves and restores modes
and regional settings together. `theme.spec.ts`
checks live CSS in the browser, persistence, reset, popup styling, brightness
presets and mobile layout.
`theme-surfaces.spec.ts` compares rendered wallpaper pixels before/after card
blur and checks Version Preview table/log surfaces in light and dark modes.
Source-level layout tests use
`preset-style-source.ts` to resolve optional overrides to their preset values;
they continue to verify the existing default geometry rather than requiring
literal pixels in production styles.
