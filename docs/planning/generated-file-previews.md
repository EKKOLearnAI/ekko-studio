# Generated File Preview Plan

Date: 2026-07-17
Issue: https://github.com/EKKOLearnAI/ekko-studio/issues/2103

## Context

Agent-generated files can be browsed from the Files page and from a chat
session's workspace drawer. The current preview path supports images, rendered
Markdown, and highlighted text only.

HTML and CSV are classified as text, so previewing them shows source content.
PDF, Word, PowerPoint, and Excel files are not classified as previewable.
Session workspace files also expose only a UTF-8 text read endpoint, which
cannot safely transport binary document formats.

Users should be able to inspect common generated artifacts without downloading
each file first.

## Goals

- Preview HTML, PDF, DOCX, PPTX, XLSX, and CSV files inside the existing file
  preview panel.
- Support profile-scoped files, chat session artifacts, and managed group-chat
  workspaces through the same preview UI.
- Keep source and edit access available for text-based formats such as HTML and
  CSV.
- Preserve download as a fallback for unsupported, oversized, malformed, or
  encrypted files.
- Keep document contents local to Hermes Studio; do not upload files to an
  external preview service.
- Apply explicit size and rendering limits so previews cannot freeze the UI or
  exhaust server memory.

## Non-Goals

- Do not execute macros, embedded scripts, or active document content.
- Do not provide pixel-perfect Microsoft Office editing.
- Do not initially preview legacy binary Office formats such as DOC and XLS.
- Do not allow generated HTML to access Hermes Studio APIs, authentication
  state, the parent page, local files, or unrestricted network resources.

## Current Constraints

- `isPreviewableFile()` recognizes only image, Markdown, and text files.
- `previewFile.type` is limited to `image | markdown | text`.
- `FilePreview.vue` has renderers only for those three types.
- Session workspace reads convert every file buffer to UTF-8 text and apply the
  editor size limit.
- The general download route knows common document MIME types but always returns
  `Content-Disposition: attachment` and does not address session workspace
  files.
- No PDF, DOCX, or spreadsheet rendering dependencies are currently installed.

## Proposed Design

### File Kind Detection

Centralize preview-kind detection instead of extending independent extension
sets in multiple components.

```ts
type FilePreviewKind =
  | 'image'
  | 'markdown'
  | 'text'
  | 'html'
  | 'pdf'
  | 'docx'
  | 'presentation'
  | 'spreadsheet'
  | 'csv'
```

Use the normalized extension for the initial decision and validate the response
MIME when binary content is loaded. Unknown or mismatched files fall back to
download.

### Authenticated Binary Read

Add a bounded binary read path for session workspaces, for example:

```text
GET /api/studio/sessions/:id/workspace-file/content?path=<relative-path>
```

The endpoint must reuse the existing session access check and workspace path
containment logic. It should return the correct MIME, content length, no-cache
headers, and a safe filename. It must reject directories, escaped paths, files
above the preview limit, and sessions the current user cannot access.

For profile-scoped files, use a shared authenticated blob-fetch helper over the
existing file provider/download path. The client should consume preview data as
a `Blob` or `ArrayBuffer` instead of navigating directly to an attachment URL.

Group-chat reads use room-management authorization and accept only the room
workspace or a workspace belonging to one of the room's Agent Profiles. Group
workspace browsing and mutations reuse the same contained file operations.

Keep editing and preview reads separate: the text editor can retain its UTF-8
contract, while document preview uses the binary contract.

### HTML Preview

Show a `Preview / Source` switch for HTML. Render preview mode in a sandboxed
iframe created from controlled `srcdoc` or a blob URL.

The sandbox must not include `allow-scripts`, `allow-same-origin`,
`allow-forms`, `allow-popups`, or top-navigation permissions. Inject a restrictive
preview CSP that blocks scripts, network requests, frames, forms, objects, and
navigation. Inline styles and embedded `data:`/blob images may be allowed.

The first implementation should target self-contained HTML. Relative CSS,
images, and fonts can be supported later through explicitly resolved and
bounded workspace assets rather than granting general file or network access.

### PDF Preview

Render PDFs with a client-side PDF renderer such as PDF.js. Fetch the PDF as an
authenticated blob and render pages to canvas. Load pages progressively and
provide page navigation and zoom without placing the full document DOM in the
chat timeline.

Do not rely on the browser's PDF iframe behavior because attachment headers and
frame security policies vary across browsers and desktop shells.

### DOCX Preview

Use a browser-side DOCX renderer. The renderer must not execute active content
or fetch external resources. Render into an isolated preview container and
clean up generated object URLs when the preview closes or changes.

If the document is encrypted, corrupt, unsupported, or above the size limit,
show a clear preview error with a download action.

### PPTX Preview

Use a browser-side OOXML renderer in single-slide mode. Fetch the presentation
through the same authenticated binary path, lazy-load slide and media data, and
apply bounded ZIP parsing limits before rendering untrusted decks. Provide
previous/next navigation and zoom without loading the entire deck into the chat
timeline.

Remove active links, embedded frames, forms, and external media references from
the rendered slide DOM. Corrupt, encrypted, unsupported, or oversized decks
fall back to download with an explicit preview error.

### XLSX And CSV Preview

Parse spreadsheets in the browser and render a read-only table:

- show worksheet tabs for XLSX;
- show a single table for CSV;
- cap rendered rows, columns, and total cells;
- virtualize larger accepted tables;
- display formulas as values or text without executing them;
- never interpret spreadsheet cells as HTML;
- provide a clear truncation message when the render limit is reached.

CSV should retain a `Table / Source` switch so users can still inspect the raw
delimiter and quoting behavior.

### Preview Lifecycle

- Show a loading state while binary data and lazy renderer chunks load.
- Cancel or ignore stale requests when the selected file changes.
- Revoke blob/object URLs when the preview closes, the file changes, or the
  component unmounts.
- Keep renderer dependencies lazy-loaded so the normal chat and Files page
  bundles do not pay the document-preview cost.
- Show filename, file size, preview mode controls, and download fallback in the
  existing preview header.

## Security Requirements

- Reuse existing authorization, profile scoping, and workspace containment
  checks for every preview request.
- Set `X-Content-Type-Options: nosniff` and return an allowlisted MIME derived
  from the normalized file extension.
- Never insert generated HTML into the Hermes Studio document with `v-html`.
- Never grant generated HTML a same-origin, script-capable iframe.
- Do not resolve arbitrary absolute paths or URLs referenced by documents.
- Do not execute spreadsheet formulas, Office macros, embedded JavaScript, or
  PDF actions.
- Enforce server byte limits and client row/page/render limits.
- Treat parsing failures as preview failures, not as permission to render raw
  active content.

## User Experience

- A single click on the preview action opens the rendered artifact in the
  existing right-side file panel.
- Double-click behavior remains compatible with editing text files.
- HTML exposes `Preview / Source`.
- CSV exposes `Table / Source`.
- PDF exposes page and zoom controls.
- PPTX exposes slide navigation and zoom controls.
- XLSX exposes worksheet tabs.
- All supported formats expose download.
- Unsupported or failed previews show a localized explanation and download
  fallback instead of a blank panel.

## Tests

### Server

- Authorized session workspace binary files return exact bytes and expected
  MIME.
- Managed group-chat files return exact bytes while members without management
  access and paths outside the room/Agent workspaces are rejected.
- Cross-user sessions, missing sessions, directories, traversal paths, and
  oversized files are rejected.
- Profile-scoped binary reads preserve profile access rules.
- Response headers prevent MIME sniffing and caching.

### Client

- Extension-to-preview-kind mapping covers HTML, PDF, DOCX, PPTX, XLSX, CSV,
  and existing formats.
- HTML preview uses a restrictive sandbox and does not render into the parent
  DOM.
- Source/table mode switches preserve the selected file.
- PDF, DOCX, PPTX, and XLSX renderers are lazy-loaded.
- PPTX parsing uses bounded ZIP limits and cleans up the viewer on close.
- Spreadsheet cell limits and truncation messages are enforced.
- Blob URLs and stale requests are cleaned up.
- Renderer failures expose download fallback.

### End To End

- Preview one representative file for each supported format from the Files
  page.
- Preview the same formats from a chat session workspace drawer.
- Verify malicious HTML cannot run script, navigate the parent, submit forms,
  or call Hermes Studio APIs.
- Verify large and malformed documents fail gracefully without blocking the
  rest of the UI.

## Implementation Slices

1. Add shared file-kind detection, binary workspace reads, preview loading/error
   states, and download fallback.
2. Add sandboxed HTML preview plus source switching.
3. Add CSV table preview plus source switching.
4. Add PDF preview with progressive page rendering.
5. Add DOCX, PPTX, and XLSX preview with lazy dependencies and document limits.
6. Add full server, client, security, and end-to-end coverage.

## Acceptance Criteria

- HTML, PDF, DOCX, PPTX, XLSX, and CSV generated by an Agent can be previewed
  without first downloading the file.
- The behavior works from both profile files and session workspace files.
- Text source/edit behavior remains available where appropriate.
- No preview format can execute active content or access Hermes Studio session
  credentials.
- Oversized, malformed, encrypted, or unsupported files fail with an explicit
  message and usable download fallback.
- Existing image, Markdown, text, edit, rename, delete, and file navigation
  behavior remains unchanged.

## Open Questions

- What byte limits should apply per format, especially for large PDFs and
  spreadsheets?
- Should relative assets in generated HTML be part of the first release or a
  follow-up?
- Should PDF text search and copy be included initially, or only page rendering
  and zoom?
- Which DOCX renderer provides the best fidelity while satisfying the bundle,
  privacy, and security constraints?
- Should XLSX preview show formulas, cached values, or both?
