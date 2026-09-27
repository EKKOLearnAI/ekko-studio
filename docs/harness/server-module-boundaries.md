# Server Module Boundaries

This document is the architecture contract for `packages/server/src`. It
separates Studio-owned capabilities from the agent families while
preserving request/response semantics and persisted data. Studio-owned HTTP
operations use `/api/studio/*`; Hermes-owned operations use `/api/hermes/*`.
Old server source trees are not retained. The only old Studio URL aliases are
the centralized compatibility mappings for already-released App and MCU firmware versions in
`modules/studio/middleware/legacy-app-api.ts`.

All server TypeScript source lives under `modules/` or `bootstrap/`, except the
package entrypoint `index.ts`. The boundary harness rejects any source file that
reintroduces a legacy top-level tree.

## Domain Vocabulary

Do not use one `source` or `agent` field for all of these concepts:

| Concept | Allowed values | Meaning |
| --- | --- | --- |
| `AgentFamily` | `hermes`, `ekko`, `coding` | Product/domain owner of an agent implementation. |
| `AgentRuntime` | `hermes`, `ekko`, `claude-code`, `codex`, `pi`, `grok`, `opencode`, `dsh`, `cursor` | Concrete runtime selected for a run. |
| `RunSurface` | `chat`, `workflow`, `group-chat`, `global-agent`, `api` | Studio surface that initiated a run. |
| `RunMode` | `scoped`, `global` | Whether the run is workspace/profile scoped or global. |

Hermes and Ekko are both a family and a runtime. Claude Code, Codex, Pi, Grok,
OpenCode, DSH, and Cursor are seven runtimes in the Coding family. Persist and
transport these concepts separately whenever a schema is introduced or revised.

## Target Directory

The tree below is the ownership target. Feature folders may grow beneath the
listed layers, but new top-level server modules require an architecture change
to this document and its mechanical checker.

```text
packages/server/src/
  index.ts                         # package entrypoint; delegates to bootstrap
  bootstrap/                       # only concrete composition root
    app.ts                         # Koa construction and middleware order
    http.ts                        # HTTP server lifecycle
    sockets.ts                     # Socket.IO module registration
    modules.ts                     # concrete module factories and agent adapters
    lifecycle.ts                   # startup and shutdown coordination

  modules/
    studio/                        # common product/platform capabilities
      index.ts
      contracts/
        agents/
          family.ts                # AgentFamily
          runtime.ts               # AgentRuntime
          runner.ts                # runtime-neutral run port
          registry.ts              # registration/resolution port
          events.ts                # runtime-neutral event contract
        runs/
          surface.ts               # RunSurface and RunMode
          session.ts
          usage.ts
          workspace-diff.ts
        files/
        providers/
        voice/
      public/                      # stable facades agents may import
        config.ts
        credentials.ts
        files.ts
        logging.ts
        runs.ts
        sessions.ts
        usage.ts
        workspace.ts
        workspace-files.ts          # shared path, preview, Git status, and file policy facade
        group-chat-agent-runtime.ts # injected concrete Agent adapters for Group Chat
        session-agent-runtime.ts    # injected Hermes/Coding adapters used by Studio session orchestration
      middleware/
        auth.ts
        errors.ts
        legacy-app-api.ts          # temporary released App and MCU firmware URL mapping only
        request-context.ts
      http/
        body.ts
        responses.ts
        validation.ts
      routes/
        auth.ts
        update.ts
        health.ts
        devices.ts
        mcu-devices.ts
        upload.ts                   # /api/studio/uploads
        app-upload.ts               # /api/studio/app-uploads/*
        files.ts                    # /api/studio/files/*
        download.ts                 # /api/studio/files/download
        theme.ts
        api-docs.ts
        app-connections.ts
        app-relay.ts
        social-messages.ts
        sessions.ts                 # cross-agent single-chat session management; /api/studio/sessions/*
        chat-run.ts
        chat-webhooks.ts            # cross-agent event delivery; /api/studio/webhooks/*
        workflows.ts
        group-chat.ts
        global-agent.ts
        pets.ts
        logs.ts
        voice.ts
      controllers/
        auth.ts
        update.ts
        health.ts
        devices.ts
        mcu-devices.ts
        upload.ts
        app-upload.ts
        files.ts
        file-preview.ts
        download.ts
        theme.ts
        api-docs.ts
        app-connections.ts
        app-relay.ts
        social-messages.ts
        sessions.ts                 # Studio session/history orchestration through injected Agent adapters
        chat-run.ts
        chat-webhooks.ts
        workflows.ts
        group-chat.ts
        global-agent.ts
        pets.ts
        logs.ts
        voice.ts
      services/
        agents/
          agent-registry.ts        # stores injected agent runners
          run-coordinator.ts       # dispatches through Studio contracts
        auth/
        config/
        connections/
        credentials/
        files/
          app-image-preview.ts
          app-upload.ts
          file-provider.ts
          path.ts
          file-policy.ts
          file-preview.ts
          workspace-path.ts
          workspace-git-status.ts
        logging/
        notifications/
        providers/
        sessions/
        social-messages/
        chat-run/                    # shared single-chat lifecycle and persistence
        context-compressor/
        webhooks/                    # aggregates events from every AgentFamily and RunSurface
        update/
          studio-updater.ts        # upgrades hermes-web-ui
          studio-restarter.ts
          version-preview-manager.ts
        workflow/
        group-chat/
        global-agent/
        pets/
        voice/
          stt/
          tts/
      repositories/                # Studio-owned application state
        users/
        devices/
        sessions/
        usage/
        workflows/
        group-chat/
        app-connections/
        social-messages/
        settings/
      infrastructure/
        database/
        filesystem/
        network/
        processes/
      sockets/
        chat-run.ts
        group-chat.ts
        global-agent.ts
        pets.ts

    hermes/                        # Hermes Agent-owned API and behavior
      index.ts                     # exposes factory/registration to bootstrap
      public/                      # Hermes adapter exposed only to bootstrap
        runner.ts
      contracts/
      routes/
        profiles.ts
        providers.ts
        models.ts
        skills.ts
        skill-bundles.ts
        plugins.ts
        memory.ts
        terminal.ts
        cron.ts
        journey.ts
        kanban.ts
        mcp.ts
        write-gate.ts
        channels.ts
        runtime.ts
      controllers/
        profiles.ts
        providers.ts
        models.ts
        skills.ts
        skill-bundles.ts
        plugins.ts
        memory.ts
        terminal.ts
        cron.ts
        journey.ts
        kanban.ts
        mcp.ts
        write-gate.ts
        channels.ts
        runtime.ts
      services/
        runner/
        bridge/
        gateway/
        profiles/
        providers/
        models/
        history/                   # adapters for Hermes Agent state.db
        skills/
        plugins/
        memory/
        terminal/
        cron/
        journey/
        kanban/
          kanban-service.ts
          hermes-kanban-cli.ts
          attachments.ts
          session-link.ts
          events.ts
          types.ts
        mcp/
        write-gate/
        channels/
          weixin.ts
        runtime/                   # Hermes runtime download/activation/version
      sockets/
        terminal.ts
        kanban-events.ts

    ekko/                          # Ekko Agent-owned API and behavior
      index.ts
      public/
        runner.ts
      contracts/
      routes/
        chat.ts
        providers.ts
        approvals.ts
        clarifications.ts
        mcp.ts
      controllers/
        chat.ts
        providers.ts
        approvals.ts
        clarifications.ts
        mcp.ts
      services/
        runner/
        runtime/
        providers/
        auth/
        tools/
        memory/
        approvals/
        clarifications/
        mcp/
      sockets/
        chat.ts

    coding-agents/                 # Claude Code, Codex, Pi, Grok, OpenCode, DSH, and Cursor family
      index.ts
      public/
        runner.ts
      contracts/
      protocol/                    # shared only inside the Coding family
        events.ts
        messages.ts
        sse.ts
        tool-calls.ts
      routes/
        agents.ts
        runs.ts
        claude-code-proxy.ts
        codex-proxy.ts
      controllers/
        agents.ts
        runs.ts
        claude-code-proxy.ts
        codex-proxy.ts
      services/
        registry/
        credentials/
        sessions/
        run-manager/
        claude-code/
        codex/
        pi/
        grok/
        opencode/
        dsh/
        cursor/
      sockets/
        runs.ts
```

`public/` does not mean a public HTTP API. It is the stable in-process facade
that another allowed layer can import. Concrete agent `public/runner.ts` files
are consumed by `bootstrap/modules.ts`, which injects them into Studio's agent
registry. Studio orchestration never imports a concrete agent module.

## Ownership Decisions

| Capability | Owner | Reason |
| --- | --- | --- |
| Studio update and Version Preview | Studio | Upgrades/restarts `hermes-web-ui`, not Hermes Agent. |
| Auth, users, devices, files, app connections, relay, social messages | Studio | Product/platform capabilities shared across agents. |
| Single Chat (Chat Run), Workflow, Group Chat, Global Agent | Studio | Cross-agent run and orchestration surfaces; dispatch through agent contracts. |
| Pets/Petdex and aggregate logs | Studio | Stored or presented as Studio product state. |
| Common config, credentials, provider contracts, voice, run/session/usage helpers | Studio | Shared capabilities exposed through `studio/public` or `studio/contracts`. |
| Studio SQLite tables and repositories | Studio | Application state owned by the Web UI. |
| Hermes profiles, bridge, gateway, skills, plugins, memory, terminal, cron | Hermes | Direct Hermes Agent behavior or state. |
| Journey | Hermes | Invokes Hermes and reads a Hermes profile. |
| Kanban | Hermes | Uses `hermes kanban`, Hermes profiles, and Hermes history. It is not a common scheduler. |
| Hermes MCP and Write Gate | Hermes | Operate through Hermes Bridge/Python and Hermes memory/skills approvals. |
| Weixin channel configuration | Hermes | Mutates Hermes profile environment and restarts the Hermes gateway. |
| Hermes Agent history adapters | Hermes | Read `~/.hermes/.../state.db`; they are separate from Studio repositories. |
| Hermes runtime download/activation/version | Hermes | Manages the Hermes runtime; split it from Studio Web UI updating. |
| Ekko runtime, provider handling, tools, memory, approvals, clarification, MCP | Ekko | Concrete Ekko Agent behavior. |
| Claude Code, Codex, Pi, Grok, OpenCode, DSH, Cursor, and their shared protocol | Coding Agents | Shared by runtimes in one family, not by all Studio agents. |

If a feature can dispatch multiple agents, that alone does not make its data
and business rules common. Ownership follows the state, command, and rules that
the feature controls. Kanban is therefore Hermes; Single Chat, Group Chat,
Workflow, and Global Agent are Studio orchestration. Hermes session history is
still exposed through a Hermes adapter, but Studio owns the chat-run lifecycle.

## Allowed Dependency Matrix

An arrow means the row may import the column.

| From / To | Studio | Hermes | Ekko | Coding Agents |
| --- | ---: | ---: | ---: | ---: |
| `bootstrap` | yes | yes | yes | yes |
| Studio | yes | no | no | no |
| Hermes | contracts/public | yes | no | no |
| Ekko | contracts/public | no | yes | no |
| Coding Agents | contracts/public | no | no | yes |

Additional layer rules:

- Routes import their own controllers plus Studio HTTP, middleware, contracts,
  or public facades. Routes do not call services or repositories directly.
- Controllers do not import routes. They delegate reusable behavior to their
  own services and may consume Studio contracts/public facades.
- Services do not import routes, controllers, or sockets.
- Agent modules do not import one another. Cross-agent execution goes through
  a Studio-owned port registered by `bootstrap`.
- Agent code does not reach into Studio internal `services`, `repositories`, or
  `infrastructure`; Studio exposes a narrow facade under `public`.
- Studio never imports a concrete agent. This keeps the module graph acyclic.

## Migration Contract

Preserve behavior while moving ownership:

1. Studio-owned HTTP operations use `/api/studio/*`; Hermes-owned operations
   use `/api/hermes/*`. Client API modules must use the matching owner folder.
2. Do not combine a module move with a database schema or state-location
   change. Studio state and Hermes Agent state remain physically separate.
3. Introduce Studio contracts/public APIs before removing a cross-module
   import. `bootstrap` supplies concrete agent implementations.
4. Move a complete vertical feature slice: route, controller, service,
   repository/adapter, socket, Client API, and focused tests.
5. Do not add compatibility re-exports or legacy source trees. Old HTTP aliases
   are allowed only in `modules/studio/middleware/legacy-app-api.ts` for released
   App and MCU firmware versions; current clients must migrate to canonical URLs in the same change.

## Mechanical Harness

Run:

```bash
npm run harness:check
```

The unified harness invokes `scripts/server-module-boundaries.mjs`, which enforces:

- only the four declared module roots under `modules/`;
- no server TypeScript outside `modules/`, `bootstrap/`, and the package
  entrypoint `index.ts`;
- the dependency matrix and route/controller/service layer rules;
- no imports from modules back into legacy server source;
- no Studio dependency on concrete agent modules;
- no direct dependency between concrete agent modules.
- no file, download, preview, or App upload implementation under Hermes;
  these capabilities are mechanically reserved for Studio.
- legacy Studio URLs are declared only in the centralized App compatibility middleware.

Resolve cross-module behavior through Studio contracts/public APIs and inject
concrete runtime adapters from `bootstrap`.
