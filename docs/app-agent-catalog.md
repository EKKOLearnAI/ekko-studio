# App agent catalog

`config/agents.json` is the canonical public catalog. The website build copies it
to `https://ekkostudio.xyz/agents.json`; App loads that URL once on process launch.
App first uses the last valid local cache, then the bundled fallback. A failed
request, incompatible schema or invalid document leaves the current catalog intact.
The catalog contains public metadata only, never credentials or executable commands.

When adding a Studio runtime, add its metadata here and change `revision`. The
website deployment workflow checks out this Studio repository and copies the
catalog, so App does not need a new release for ordinary runtime additions.
Publish the website/catalog after the Studio change is merged. Existing App
installations receive it on their next launch. This implementation itself needs
one App release, and does not install or implement the six proposed runtimes.

## Schema version 1

| Field | Meaning |
| --- | --- |
| `id` | Studio `/api/coding-agents/:id` runtime ID |
| `name` | Public display name |
| `kind` | `hermes`, `built-in`, or `coding-agent` |
| `aliases` | Additional accepted historical IDs |
| `sessionId` / `groupId` | IDs used in chat sessions and group agents |
| `icon` | Existing App `/static/` asset, or an HTTPS image for a new agent |
| `modes` | Explicit supported modes; first entry is the fallback mode |
| `installation.method` | Installation/management mechanism: `builtin` means Studio owns the entry, `npm` installs a CLI package, and `manual` opens an installation guide. It does not define the Agent family. |
| `installation.docsUrl` | HTTPS installation guide, required for manual installs |
| `installation.updates` / `remove` | Enable Studio-managed update/removal controls |
| `config.skillsTarget` | Skills API target; omit if unsupported |
| `config.skillsWritable` | Enable skill editing/removal; content permissions still apply |
| `config.mcp` | Enable MCP configuration entry |
| `config.memory` / `settings` | Config-file API keys; omit unsupported files |
| `capabilities.context` / `compact` | Enable the respective session commands |
| `capabilities.serverManagedAuth` | Allow Studio-managed OAuth model providers in scoped mode |

IDs and API keys are lowercase identifiers with hyphens, up to 64 characters.
Every agent identity must be unambiguous. Required boolean capability fields must
be present. New agent icons must use HTTPS because older Apps cannot contain new
bundled assets. An unknown agent is displayed with its ID and a generic icon.
Single chat, group chat and workflow availability also require the connected Studio to report
the runtime as installed; adding metadata cannot create a runtime on an old Studio.

For a local website build, the script detects the sibling Studio checkout.
CI uses `AGENT_CATALOG_SOURCE` pointing to the checked-out Studio file. A standalone
website checkout can build from its last copied public catalog. Production should
serve `/agents.json` with `Content-Type: application/json`, a short cache lifetime
or revalidation, and `Access-Control-Allow-Origin: *` for the H5 App. Native uni-app
requests do not depend on browser CORS. Deployments must verify the served JSON,
not an SPA fallback page.

The website repository includes `website/nginx-agent-catalog.conf` as an exact
location snippet for the existing server block. Apply it when enabling H5 access.
The website deployment verifies that the published response matches the release
file; a status-200 HTML fallback fails that check. App requests include a startup
query value to bypass cached copies of an earlier website response.
