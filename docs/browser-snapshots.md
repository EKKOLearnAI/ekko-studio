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
page. The final batch snapshot preserves the initial selection and page options.
`checked`, `selected` and `expanded` state is included when provided by the
accessibility tree, so ordinary agents can inspect control state without JEV.

`target` remains a separate optional JEV recommendation within the returned page.
Use the local filters to expose missing controls before requesting semantic advice.
`include_text` defaults to false to avoid duplicating node labels.

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
