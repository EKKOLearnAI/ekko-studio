# Product screenshots

Captured on 2026-11-03 from Ekko Studio **v0.8.13** source at commit
`1f4d0080673052760056056448686d8f6e316ab2`.

| Image | What it shows | Pixel dimensions |
| --- | --- | --- |
| [new-chat.png](./new-chat.png) | The current Agent carousel with Ekko selected, an empty session list, and the shared composer. | 3200 × 2000 |
| [workflow.png](./workflow.png) | A saved, idle Claude → Codex → Claude example with an approval gate on the review node. | 3200 × 2000 |
| [agent-manager.png](./agent-manager.png) | All 16 Agent cards with actual local installation/version detection and update controls. | 3200 × 2560 |

## Source and capture

These are direct Playwright screenshots using the installed Google Chrome on
macOS, with the English UI, the light theme, a 1600-pixel CSS viewport width,
and 2× device scale. Chat and workflow use a 1000-pixel viewport height; Agent
Manager uses 1280 pixels so the complete catalog, including ZCode, is visible.

The current Vue client ran through Vite at `http://127.0.0.1:18749`, connected to
the current Koa source server at `http://127.0.0.1:18747`. Both used the repository's
existing dependencies. The server was launched with `ts-node/register`, with a
process-only `rootDir` override for TypeScript 6; no application source was
changed for capture. No API fixtures, socket mocks, or replacement UI were used.

To capture again:

1. Use separate `HERMES_WEB_UI_HOME`, `HERMES_WEBUI_STATE_DIR`, `HERMES_HOME`, and
   `WORKSPACE_BASE` directories and unused loopback ports. Do not use personal
   Studio state. Disable Gateway autostart, LAN discovery, and automatic MCP/skill
   injection for the capture instance.
2. Run the source backend and the Vite client, pointing
   `HERMES_WEB_UI_BACKEND_PORT` at that backend. Sign in to the isolated instance
   in a fresh browser context; dismiss first-run notices through the UI.
3. Capture `/#/hermes/chat` with Ekko selected. No model credentials are configured
   in this instance, so the visible “No models” state is intentional.
4. In `/#/hermes/workflow`, create the example through the UI, add and connect three
   nodes, select Claude/Codex/Claude in Global mode, and enable the final node's
   approval gate. Save and reload it to verify persistence. Collapse the workflow
   list and run-history panels, fit the canvas, and clear the node selection.
5. Capture `/#/studio/agents` after inventory loading. Inspect every resulting PNG
   for private content, clipping, missing assets, dialogs, and tooltips.

## Data and privacy

The workflow name, node names, and instructions are documentation examples entered
through the real editor and stored by the isolated backend. **The workflow was
not executed.** All three nodes are Idle; “Source returned normally” labels name
edge conditions, not observed execution results. Global mode and “Agent default
model” describe configuration only and do not establish working CLI authorization.

Agent installation/version fields and available-update labels come from actual
backend detection on this machine. No Agent was installed, updated, or removed
for these screenshots. Hermes is unavailable in the isolated runtime; the status
shown here is not a requirement for other installations. Automatic-update switches
use the isolated instance's defaults.

No personal conversations, model credentials, private provider endpoints, local
executable paths, or authentication state are included in these image assets.
The pictures were not retouched. The old fixture-based conversation and Skills
screenshots were removed from the gallery and this directory.

## Verification

All three PNGs were visually inspected. Capture checks found no browser page
errors, failed HTTP responses, or broken visible images. The saved workflow
restored three Idle nodes, two links, and the enabled review approval gate after
navigation. Agent Manager displayed all 16 cards without clipping the last card.
Both language versions of the repository README share these three relative image
paths; verify them when replacing these assets.
