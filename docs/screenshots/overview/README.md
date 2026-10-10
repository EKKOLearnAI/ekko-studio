# Product screenshots

Captured on 2026-10-10 from the Ekko Studio **v0.7.33** client at commit
`05b4e1bd84d7430ec3fa85247282cf68235e76c8`.

| Image | What it shows | Pixel dimensions |
| --- | --- | --- |
| [new-chat.png](./new-chat.png) | Responsive Agent cards with Ekko selected and the shared chat composer. | 2880 × 1920 |
| [workspace.png](./workspace.png) | A fictional release-planning conversation, completed task card, and example per-turn usage. | 2880 × 1920 |
| [workflow.png](./workflow.png) | An idle Ekko → Codex → Claude demonstration workflow with an approval gate on the review node. | 2880 × 1920 |
| [agent-manager.png](./agent-manager.png) | All 16 Agent cards, local CLI versions, and automatic-update controls. | 2880 × 2436 |
| [skills.png](./skills.png) | Ekko Skills with a demonstration GitHub skill and category/source controls. | 2880 × 1920 |

These are direct Playwright screenshots from the system Chrome channel, at a
1440-pixel CSS viewport width and 2× device scale. Agent Manager uses a 1218-pixel
viewport height to include the entire catalog; the others use 960 pixels.
The workflow list and run-history panels were collapsed through their UI controls,
then the canvas was fitted to the three nodes. No UI elements were painted into
the images.

Capture used an isolated Vite client on port 18473, a separate dependency cache,
and the repository's Playwright API, Socket.IO, and native WebSocket fixtures.
Conversations, the `studio-demo` model, usage figures, workflows, skills, and
update-policy values are demonstration data, not live execution results.
Agent installation/version fields came from a read-only local status snapshot;
the Ekko badge reflects the captured client version. Local executable paths were
replaced with demonstration paths before supplying the fixture.

Demo conversations and workflows stayed in the capture browser. Authentication
state, credentials, private conversations, and local executable paths are not
included in this directory.

All five images were inspected after capture. The capture check reported no
browser page errors or broken images; it also verified the restored task card,
usage summary, review approval switch, and visibility of the final Agent card.
The English and Chinese README galleries use the same repository-relative images.
