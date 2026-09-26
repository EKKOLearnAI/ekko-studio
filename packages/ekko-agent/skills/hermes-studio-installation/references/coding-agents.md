# Claude Code, Codex, Pi, and Grok installation

Use the Studio Agents page for cross-platform installation. It detects the same executable that chat launches, handles npm prefixes, installs Pi's required adapter, refreshes status, and reports the resolved path.

## Prerequisites

All four coding agents require Node.js and npm. Ekko Studio itself requires Node.js 23 or newer for npm/source installations.

Before installing, inspect:

```bash
node --version
npm --version
npm prefix -g
```

If Node or npm is unavailable, stop and install/fix Node first. Do not report an Agent installation problem as an Agent package failure when the actual problem is the Node environment.

## Packages and commands

Studio installs these global npm packages:

| Agent | Executable | Package |
| --- | --- | --- |
| Claude Code | `claude` | `@anthropic-ai/claude-code` |
| Codex | `codex` | `@openai/codex` |
| Pi | `pi` | `@earendil-works/pi-coding-agent` |
| Grok | `grok` | `@xai-official/grok` |

Pi follows the package's current npm version, like the other coding agents. Its installation is incomplete without `pi-mcp-adapter`, which also follows its current npm version and is installed below:

```text
<HERMES_WEB_UI_HOME>/coding-agent/pi-mcp-adapter
```

The Agents page install action effectively performs the following. The Pi adapter example is POSIX shell syntax; use the Agents page on Windows so Studio resolves its home directory correctly.

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex --registry=https://registry.npmjs.org
npm install -g @earendil-works/pi-coding-agent
npm install -g @xai-official/grok --registry=https://registry.npmjs.org
studio_home="${HERMES_WEB_UI_HOME:-$HOME/.hermes-web-ui}"
npm install --prefix "$studio_home/coding-agent/pi-mcp-adapter" pi-mcp-adapter
```

Run only the line for the requested Agent. For Pi, run both Pi lines, or use the Agents page so Studio installs the packages' current npm versions automatically.

## Success criteria

Studio calls each executable with `--version` using an 8-second timeout. Validate manually as needed:

```bash
claude --version
codex --version
pi --version
grok --version
```

On macOS/Linux inspect executable resolution with `command -v claude`, `command -v codex`, `command -v pi`, or `command -v grok`; on Windows use `where`.

Installation is successful only when:

1. npm completed successfully;
2. the executable resolves in the PATH visible to Studio;
3. `<agent> --version` exits successfully;
4. the Agents page reports the Agent installed after a refresh;
5. for Pi, `<HERMES_WEB_UI_HOME>/coding-agent/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts` exists.

Pi deliberately reports **not installed** when its CLI exists but that adapter entry is missing. Reinstall Pi from the Agents page to repair both pieces.

## Check and apply updates

The Agents page **Check update** action behaves as follows:

- Claude Code: compares the detected version with `npm view @anthropic-ai/claude-code version`.
- Codex: compares the detected version with `npm view @openai/codex version --registry=https://registry.npmjs.org`.
- Pi: compares the detected version with `npm view @earendil-works/pi-coding-agent version`.
- Grok: compares the detected version with `npm view @xai-official/grok version --registry=https://registry.npmjs.org`.

Studio uses the official npm Registry only for Codex and Grok installation and
update checks. Codex depends on platform-specific optional packages that may be
missing from third-party mirrors even when the main package is present; Grok
mirrors can also expose stale, platform-incompatible releases. Per-command
registry arguments avoid modifying the user's npm configuration or the registry
used for other coding Agents.

When an update is available, the update action reruns the same install operation. Revalidate the executable path and version afterward. For Pi, revalidate the adapter too.

## Remove an Agent

Use the Agents page delete action. Studio identifies the npm prefixes that own the command and uninstalls the package from each applicable prefix. Pi removal also uninstalls `pi-mcp-adapter` from the Studio adapter directory and stops matching running Agent processes.

Removal does not authorize deleting native user configuration, authentication, conversation data, or unrelated npm prefixes. After removal, verify that the Agents page reports not installed. If a command is still found, inspect all `command -v`/`where` results and npm prefixes; another user-owned installation may remain.

## PATH diagnosis

Studio builds its command PATH from its current Node directory, npm's global bin location, common NVM paths, the login shell PATH, and common Desktop binary locations. If terminal validation succeeds but Studio still reports not installed:

1. refresh the Agents page to force a new probe;
2. compare `npm prefix -g` with the prefix used during installation;
3. inspect all copies of the executable;
4. fully restart Ekko Studio so it inherits the updated login-shell PATH;
5. reinstall only if the resolved executable or package is genuinely absent.

Do not create Agent model or credential configuration during this installation workflow. Authentication is a separate task after installation succeeds.

## Cursor support boundary

Cursor is a user-installed external CLI, not an npm package Studio installs. The install entry points at https://cursor.com/install. Studio does not install, update, or uninstall it. `deleteCodingAgent('cursor')` returns unsupported and does not stop running Cursor sessions.

Cursor launches in global mode with `agent -p`. It does not receive a Studio provider, base URL, or model API key. `CURSOR_API_KEY` is a Cursor account credential, not a Studio model key. Bring-your-own-key and `agent acp` are outside this release.

Also outside this release: Windows prompts that exceed the command-line length limit, the native `/compact` command, and Cursor skills. A long Windows prompt, a compact request, or a missing skill is unsupported, not a sign that Cursor is fully managed like Claude, Codex, Pi, or Grok.
