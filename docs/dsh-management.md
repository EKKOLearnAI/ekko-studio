# DeepSeek Harness integration

This page describes the current integration. The proposed next stages for reusing Web Profiles, Agent presets, native plugins and browser plugin runtimes are documented in [DSH 配置复用与插件完整接入规划](planning/dsh-profiles-and-plugins.md); those stages are not implemented by this planning document.

Open **Agent Manager → DeepSeek Harness** to install `@deepseek-ai/dsh`, detect an existing `dsh` CLI, check for updates, or uninstall the CLI. Installation uses the official npm registry and the same global package management path as other Coding Agents. Update checks include prerelease ordering, such as `rc.1` to `rc.2`.

DSH installs and updates use npm's `--prefer-dedupe` option. Duplicate copies of
its native dependencies can register the same FFI types twice and stop plugin
startup even when `dsh --version` succeeds. If opening modes or plugin settings
fails after an update, check whether `dsh web --no-open` also exits with a plugin
load error. A `Duplicate type name 'DSH_STARTUPINFOW'` failure can be repaired with
`npm install -g @deepseek-ai/dsh --prefer-dedupe --registry=https://registry.npmjs.org`.
This repairs the CLI dependency tree without removing the native DSH home.
Studio reports connection failures separately from HTTP authentication rejection;
older builds can show this startup failure as `native authentication failed`.

The Settings button opens the shared Coding Agent configuration pages:

| Page | Native files |
| --- | --- |
| Settings → Preference | `~/.dsh/AGENTS.md` |
| Settings → Configuration | `~/.dsh/settings.yaml` |
| MCP | `~/.dsh/cordis.patch.yml` |
| Skills | `~/.dsh/skills`, followed by shared `~/.agents/skills` |

These are global CLI files, independent of the active Hermes profile. As with the other Coding Agents, `HERMES_CODING_AGENT_GLOBAL_HOME` can override the home used by Studio. DSH runtime and native plugin discovery also honor an explicit `DSH_HOME`; the existing general Settings/Skills/MCP editors still use the global Coding Agent Home.

Settings require a YAML mapping. MCP changes use Cordis plugin patches with `@deepseek-ai/dsh-mcp-client`, preserving unrelated plugins, comments, tags and anchors. Studio accepts stdio and Streamable HTTP connections. It preserves DSH `!!js` expressions as data and refuses to connection-test an MCP whose configuration depends on those expressions. Studio-managed MCP overrides remain in Studio state; they are not inserted into the user's native patch file.

Skills support direct `<name>/SKILL.md` bundles and flat `<name>.md` files. Files must have YAML frontmatter containing a kebab-case `name` and a `description`. Imports accept a skill folder or ZIP and go directly into `.dsh/skills`, without Hermes category directories. The editor can read, edit and delete DSH-private skills, including flat files. Shared `.agents/skills` entries are display-only in every Coding Agent page; the API marks them read-only and rejects edits, deletion and imports into that directory, including symbolic-link aliases. Nested category directories are not scanned. Invocation flags can be edited in frontmatter; the Hermes enable switch is hidden for DSH.

The **Plugins** page has exactly two tabs:

- **Plugin configuration** mounts the native `settings.plugins.tab` configuration contribution in a DSH-owned browser runtime. DSH and installed plugins render their own `settings.plugin.item` cards and own fields, dependencies, credentials, validation and saving. Studio contributes only the root slot container and scoped HTTP/SSE/WebSocket transport. It does not generate forms from schemas or implement plugin-specific APIs. Switching tabs keeps the native frame and its drafts mounted.
- **Plugin list** shows packages installed in the source `web` profile separately from shipped/user preset entries. Package installation, update (installing a new pinned version) and removal run `dsh plugin --profile web` against that source home. The list reports registration/configuration state, not live chat activation. Registry versions and GitHub commits must be pinned.

The old Studio ACP package store, rollback API, installer and runtime overlays have been removed. There is no migration or compatibility path. Existing old files are never consulted or automatically deleted.

The embedded configuration follows Studio's resolved light/dark mode, including
system-mode changes, through frame-scoped theme messages. The bridge uses native
registered palettes so plugin tokens and controls switch together without
reloading drafts or persisting Studio's choice into DSH's `ui-theme` settings.

The configuration runtime is an owned native Web process on an OS-assigned loopback port, using the source Web dependencies and native settings/credential files. Studio retains the native authentication cookie server-side. A super-admin creates a short-lived frame ticket; every HTTP/WS request checks the ticket and current user authorization, and targets only that owned DSH process. The frame renders the configuration slot without the native chat/navigation shell. Unmount revokes its ticket; shutdown terminates owned processes and transport connections.

Web and desktop continue to build with the existing Vue/Vite and Electron pipelines. DSH's React, Cordis and plugin browser bundles are loaded at runtime from the installed DSH dependency graph, inside the frame; they are not dependencies of Studio's renderer or bundled into its desktop artifacts. DSH must be installed on the Studio backend host. Both transports use Studio's origin, including reverse-proxied HTTPS; no browser access to the backend machine's loopback port is needed. Unknown plugin/runtime combinations still require compatibility verification; this is not a guarantee that every third-party plugin targets only supported native services.

Select **DeepSeek Harness** when creating a single chat, adding a group-chat agent, or configuring a workflow agent node. **Provider and model** mode uses the provider, protocol and model selected in Studio through its local Responses proxy. **Global config** uses the native DSH model configuration. The same settings, Skills and MCP pages serve all three entry points. Workflow-selected DSH skills resolve direct bundles and flat files from the native and shared skill roots.

Studio reads the native Web Profile's bundles, installed dependencies, patches and default Agent preset, and prepares a private `studio-web-<generation>` Profile with an ACP entry point. Official Web server/UI entry points are excluded; backend plugins remain available. New sessions mount the Web default preset in the Agent factory setup; resumed sessions keep their stored preset. Scoped model credentials remain in the local proxy, with only its scoped token passed to DSH. Global mode uses the Web default model. See [implementation details and limits](planning/dsh-plugin-management-implementation.md).

DSH uses `danger-full-access` with approval policy `never`, including after restoring older restricted sessions. This policy is confined to DSH. Its child environment receives Studio's discovered toolchain PATH. Plugin install commands must explicitly target the native source Home and `--profile web`; installing into the conversation's inherited `DSH_HOME` does not update the source. Native plugin configuration interfaces are hosted in the Plugins page.

Each turn initializes ACP, creates or resumes the stored native session, applies the selected model, and sends text/image content. Studio loads a small Cordis plugin from the private runtime home to forward DSH's native `agent/assistant-stream` text and reasoning deltas over a private ACP notification. Only the owned ACP session's live output reaches chat; subagent and auxiliary proxy requests are not forwarded. Committed ACP messages are deduplicated against their live attempt by message ID, while final-only output remains supported. Tools, completion and context updates still come from ACP. This applies to scoped and global runs across single chat, group chat and workflows, without changing the installed DSH package. Scoped billing uses the proxy usage ledger; ACP context occupancy is not counted as billed tokens. Global usage may be estimated. Native `/compact` is not exposed through this integration.

ACP compatibility is checked against the integration points required for preset
selection, restoration, persistence and permissions, rather than a version or
whole-file hash allowlist. A user-installed newer version can run when those points
remain compatible. Unrelated source changes do not block it. A missing or ambiguous
integration point reports its specific capability before the private adapter is
written; it never silently drops presets or resumes an empty replacement session.
The generated copy records its upstream version and source hash for diagnostics.
The installed DSH source remains unchanged. This check does not prove compatibility
with every future semantic change; real native regression tests remain required
when Studio changes its adapter.

Studio resolves `@deepseek-ai/dsh-acp` from the selected `dsh-acp-app` bundle,
including nested dependencies. The ACP package does not need to be hoisted into
the CLI's top-level `node_modules` or installed separately in the Web profile.

The adapter flushes persistence before resolving a completed ACP prompt. On normal completion Studio closes the ACP session to flush persistence, then closes stdin. The next turn starts a fresh process and resumes the same persisted session. Resume errors are reported without silently creating a replacement conversation. Cancelling a run or exiting Studio cancels ACP and terminates only Studio-owned processes, with forced cleanup if needed. This does not bind the DSH Web port or stop a separately started DSH instance.

Validate the installed CLI without a paid model call with `NODE_ENV=test PORT=8648 DSH_REAL_ACP_E2E=1 npx vitest run tests/server/dsh-acp-real.test.ts`. This opt-in check uses an isolated temporary home and a local Responses fixture to verify model injection, shutdown and cross-process resume. The fixture pauses after its first text delta until Studio receives that delta, proving streaming happens before model completion; it also checks that final ACP output is not duplicated.

Native format reference: [DeepSeek Harness source, dsh-v0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.5-rc.1).

Validate the Web-backed production path with `DSH_WEB_REAL=1 DSH_WEB_COMMAND=/absolute/path/to/dsh npx vitest run tests/server/dsh-web-real.test.ts`. It uses temporary native Web bundles/presets and a local model fixture, including real tool calls and writes outside the workspace; no model credentials or external model requests are needed.

DSH skill format handling lives in `services/dsh/skills.ts` and is registered at bootstrap through Studio’s generic skill-file provider interface. Shared skill write protection belongs to Studio’s common file-access policy.

## Agent presets

The separate **Agent presets** page uses Studio Vue/Naive UI components. It is not
an iframe. It lists the native roster with names, descriptions, default and broken
states; users can view compositions, duplicate a preset, set the default, open a
custom preset directory and delete custom presets with confirmation. Composition
viewing is read-only, matching the native management workflow; custom composition
changes are made in the preset files.

Studio’s DSH-only preset API calls `agentPresets/list`, `read`, `copy`,
`deletePreset` and the native settings methods through the existing management
process. There is no additional service and no standalone preset CLI command in
the validated installation. Native cookies stay server-side. Management routes require
a super administrator. The source bundle/profile/home preset configuration is
preserved; management and ACP share the source user preset root, so authored
presets survive management restarts. Defaults affect new sessions; resumed
sessions retain their original preset. The plugin configuration slot keeps its
native UI service dependencies, including `uiWorkspace` and the directory picker.

### Mode selection for chats, group members and workflows

The new-chat drawer shows a DSH mode selector only for DeepSeek Harness. It loads
names, descriptions, default and availability from the read-only
`GET /api/coding-agents/dsh/session-presets` endpoint. Chat users can read these
choices; native configuration and authoring endpoints still require a super admin.
Unavailable presets are disabled, and a failed roster load blocks creation with a
retry action. Both global and scoped model configurations support preset selection.

The shared chat transport and session record carry only an opaque `agent_preset`
identifier. DSH validates it on the first launch and persists the resolved choice;
subsequent launches keep that stored choice even if the global default or model
changes. The DSH ACP adapter passes it through `session/new` metadata before
mounting the preset. Native resume reads the preset from native session history.
Selecting a mode does not update the Web profile default. Profile-wide plugins
remain global; preset-owned tools and plugins follow the chosen composition.

Group member forms and workflow nodes reuse the same DSH selector. Group member
records, reusable member presets and remote descriptors retain `agentPreset`.
Workflow definitions, exports/imports and run snapshots retain the same identifier.
Both execution paths forward it as `agent_preset` to the coding-agent runner;
DSH remains responsible for resolving and mounting the selected native composition.
Workflow node controls scroll when the selected Agent exposes more settings.
