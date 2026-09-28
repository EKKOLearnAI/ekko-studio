# Built-in browser snapshots

Large-page navigation is a local Desktop browser capability. It works without a
JEV key, with JEV disabled, and when the provider is unavailable. No model service
is needed to find text, scope a region, page the accessibility tree or operate refs.

Discover `ekko_studio_browser_toolset` with `action=list`, then describe the needed
operation. `ekko_studio_browser_snapshot` supports:

- `selector`: a CSS selector for one region in the main document, such as the
  `#form-demo-layout` anchor from a form-demo URL. Only that element's DOM subtree
  is returned; a missing selector gives an explicit error.
- `query`: case-insensitive, Unicode-normalized substring search of accessible
  names, roles and descriptions. Search runs across the selected tree before
  paging. It is literal search, not semantic matching.
- `interactive_only`: return controls and links instead of static text/layout nodes.
- `limit`: nodes per response, default 100 and maximum 300.
- `snapshot_id` and `offset`: continue a cached snapshot at `nextOffset`. Do not
  combine `snapshot_id` with new filters. Omit it to read a fresh tree.

The result reports `totalNodes`, `matchedNodes`, `offset`, `limit`, `hasMore`,
`nextOffset` and `truncated`. The response limit does not discard the rest of the
tree. Refs and snapshot identity stay stable across cached pages; interaction or
navigation invalidates the snapshot, so subsequent work needs a fresh one.
Repeating an unfiltered snapshot or scrolling does not advance its offset.
Offsets count filtered results, not ref numbers or positions in the full tree.
An out-of-range page explains this and suggests restarting at offset zero.

For a form at the end of a large documentation page:

```json
{"tab_id":"tab-1","selector":"#form-demo-layout","interactive_only":true}
```

For a known visible label anywhere in the main document:

```json
{"tab_id":"tab-1","query":"Field A"}
```

For the next page of a snapshot whose result has `nextOffset: 100`:

```json
{"tab_id":"tab-1","snapshot_id":"snapshot-1","offset":100}
```

Use returned refs with that snapshot ID for click/type or a sequential batch.
Batch steps keep the original DOM identity, including targets beyond the first
page. Same-document SKU/query/hash changes can continue; a new document or reload
stops remaining actions. The final snapshot preserves the initial selection and
page options when that region still exists, and falls back to the new document
after navigation or removal of the region.
`checked`, `selected`, `pressed` and `expanded` state is included when provided by the
accessibility tree, so ordinary agents can inspect control state without JEV.

Single actions and batches return `observation` with bounded before/after target
states and changes, including `valueMatches` when the final input can be compared
locally without redacted/protected values. Only completed batch targets are
observed. Input values preserve spaces and line breaks for exact comparison;
redacted, protected or truncated values do not produce `valueMatches`.
A short read-only settling window catches asynchronous updates; it
never replays an action. Background timer throttling is temporarily disabled
during execution and observation, then restored. Pages slower than the observation
window may still need a fresh snapshot.

`completed` means dispatched, not semantic success. No observed change means the
agent should inspect the relevant region or screenshot and choose a new strategy.
It does not prove failure. When an action opens a new tab, `openedTabs` identifies
the destination and the returned `snapshot.tabId` can differ from the original tab.
The observation remains bound to its originating `tabId`.

`target` remains a separate optional JEV recommendation within the returned page.
Use the local filters to expose missing controls before requesting semantic advice.
`include_text` defaults to false to avoid duplicating node labels.
Optional JEV verification also receives control states, operated targets and
locally computed value matches. It still receives no raw input values, URLs or
descriptions, and its independent switch and credential requirements remain in
effect. A low-confidence judgment never retries an action.

Ekko model requests summarize superseded browser snapshots into bounded facts,
retaining all pages of the newest snapshot per tab and action/error metadata.
Studio applies the same projection before context budgeting; current structured
snapshots bypass generic character truncation so refs remain usable. Original
tool events and stored session history stay complete. This projection does not
control history owned by external coding agents. Browser JSON remains compact
through the tool-result sanitizer.

Requests naming the built-in/Studio browser prefer `ekko_studio_browser_toolset`.
The separate Agent browser has its own environment and login state.

The tree is the current document's accessibility tree. CSS scope does not switch
into a separate iframe, and cached pages do not refresh after asynchronous DOM
changes: omit `snapshot_id` to refresh. A missing control alone does not prove an
iframe; inspect the page before making that claim.

Browser automation does not classify action labels or insert business-risk
confirmation dialogs. Agent downloads use the same configured Profile download
preferences as other browser downloads.

Validate with the desktop browser tests, the browser MCP tests, and the local
Electron fixture:

```bash
npm --prefix packages/desktop run build
env -u ELECTRON_RUN_AS_NODE packages/desktop/node_modules/.bin/electron scripts/verify-browser-large-page.cjs
```
