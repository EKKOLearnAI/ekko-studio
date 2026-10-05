# Docker Compose Guide

This repository ships an environment-variable driven Docker Compose setup.

## Quick Start

### Pull pre-built image (Recommended)

```bash
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d
docker compose logs -f hermes-webui
```

Open: `http://localhost:6060`

### Build from source

```bash
docker compose up -d --build
docker compose logs -f hermes-webui
```

## Services

This compose file runs a single service:

- `hermes-webui` — Web UI dashboard with integrated Hermes Agent runtime (pre-built image or built from source)

The Web UI container is built on the `nousresearch/hermes-agent` base image and uses the Hermes CLI / agent bridge runtime for chat execution. By default it performs startup gateway checks/autostart for profiles, but no Hermes gateway ports are exposed by this compose setup.

## Environment Variables

All key runtime settings are configured from compose variables.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6060` | Web UI listen port |
| `BIND_HOST` | `0.0.0.0` | Optional Web UI bind host. Defaults to IPv4 for stable WSL/Windows access. Set `::` explicitly if you want IPv6 listening. |
| `CORS_ORIGINS` | same host only | Comma- or space-separated cross-origin allowlist for HTTP, Socket.IO, and WebSocket requests. Set `*` only when you intentionally need legacy wildcard CORS. |
| `HERMES_LAN_ADVERTISE_URL` | unset | Reachable Docker host origin placed in App LAN QR codes when the browser origin is localhost. Example: `http://192.168.1.20:6060`. |
| `HERMES_APP_ENTITLEMENT_REQUIRED` | `true` | Require an RS256 cloud entitlement for App LAN relay connections. |
| `HERMES_APP_ENTITLEMENT_PUBLIC_KEY` | built in | Optional PEM public-key override for App entitlement verification. |
| `STUDIO_P2P_INTERFACE` | automatic | Container interface for P2P, normally `eth0` in bridge mode. |
| `STUDIO_P2P_UDP_PORT_RANGE` | `50000-50127` | UDP range used by ICE and published with identical host/container ports. |
| `STUDIO_P2P_ADVERTISE_ADDRESSES` | unset | Reachable Docker host LAN/public IP addresses advertised for the published UDP range. |
| `HERMES_BIN` | `/opt/hermes/.venv/bin/hermes` | Path to Hermes CLI binary |
| `HERMES_AGENT_IMAGE` | `nousresearch/hermes-agent:latest` | Hermes Agent base image (used only during build) |
| `WEBUI_IMAGE` | `hermes-web-ui-local:latest` | Web UI image (set to `ekkoye8888/hermes-web-ui` to use pre-built) |
| `HERMES_DATA_DIR` | `./hermes_data` | Hermes runtime data directory |

Override variables directly from shell:

```bash
PORT=16060 docker compose up -d
```

Or create a `.env` file in the project root:

```
WEBUI_IMAGE=ekkoye8888/hermes-web-ui
PORT=6060
```

## Data Persistence

| Path | Description |
|---|---|
| `${HERMES_DATA_DIR}` (`./hermes_data`) | Hermes runtime data (sessions, config, profiles) |
| `${HERMES_DATA_DIR}/hermes-web-ui` | Web UI data (auth token, etc.) |

- Hermes data persists in `./hermes_data`, mapped to `/home/agent/.hermes` in the container.
- Web UI data persists in `./hermes_data/hermes-web-ui/`, mapped to `/home/agent/.hermes-web-ui` in the container.
- The auth token is auto-generated on first run and printed to container logs.
- Deleting the token file and restarting will generate a new one.

### Coding agent installations

Coding agents installed from Studio (Claude Code, Codex, Pi, OpenCode, and Grok)
use npm's global prefix at `/home/agent/.hermes-web-ui/coding-agent/npm`.
The image and Compose put its `bin` directory on `PATH`. With the default
mounts, packages and executable links are saved under
`${HERMES_DATA_DIR}/hermes-web-ui/coding-agent/npm` and remain available after
container recreation or image updates. Studio's Pi MCP adapter and scoped
agent configurations also use the existing Studio data volume.

Older images installed these CLIs outside the data volume. After upgrading,
reinstall affected agents once from Studio to place them in the persistent
directory. Packages already lost when an old container was removed cannot be
recovered from the new image. A restart of the same container normally retains
its writable filesystem; recreation replaces it.

For custom deployments, persist `/home/agent/.hermes-web-ui`, or set
`NPM_CONFIG_PREFIX` to a directory inside your own persistent mount and include
`$NPM_CONFIG_PREFIX/bin` on `PATH`. Do not mount over `/usr/local`, which also
contains the image's Node.js runtime. Native CLI login/configuration directories
under `/home/agent` are separate from the npm installation; mount those as well
if you use native global logins and need to retain them across recreation.

## Port Mapping

| Port | Description |
|---|---|
| `${PORT}` (6060) | Web UI dashboard |
| `${STUDIO_P2P_UDP_PORT_RANGE}` (`50000-50127/udp`) | App P2P ICE checks and DataChannel traffic |

No Hermes gateway ports are exposed by this compose setup.

### App P2P connectivity

Compose publishes the P2P UDP range in addition to TCP. A standalone
`docker run` needs `-p 50000-50127:50000-50127/udp`; `EXPOSE` alone does not
publish the range. A TCP reverse proxy for the Web UI does not replace this
UDP mapping.

For a host whose LAN IP is `192.168.1.20`, use:

```bash
STUDIO_P2P_ADVERTISE_ADDRESSES=192.168.1.20 docker compose up -d
```

For several Studio containers, assign each container a separate range and
keep its host/container port numbers identical. Allow the configured range
through the host firewall and cloud security group. Linux `network_mode: host`
can use the host's interfaces directly; remove `ports` mappings when using it.
Docker Desktop bridge mode uses the published host address through its VM
network. The host VPN can still intercept the VM's UDP traffic and may need
an exclusion. Containers with no IPv6 uplink use IPv4 candidates only.

See [P2P network configuration](app-relay.md#network-interfaces-and-containers)
for platform behavior, explicit interfaces and relay fallback.

## Code Runtime Behavior

- Hermes CLI binary comes from `HERMES_BIN` env (`packages/server/src/modules/hermes/services/runtime/cli.ts`).
- If `HERMES_BIN` is not provided, code falls back to `hermes` in `PATH`.
- Profile-specific chat runs are handled through the Hermes agent bridge. The selected/requested profile is authorized per account and passed with runtime requests; switching the frontend Hermes Profile does not restart the bridge or clear other running tasks.
- Docker is a managed gateway runtime: Web UI checks profile gateways on startup, but it does not run a periodic gateway recovery loop.

### Optional Hermes startup patches

The image starts through `/app/bin/start-studio-all.sh`. It does not apply
Hermes Agent source patches by default. If a deployment has a compatible,
optional patch script, enable it explicitly with
`HERMES_PATCH_SCRIPT=/path/to/patch.sh`. A missing or failing optional patch is logged and the Web UI still
starts, so a patch written for an older Hermes Agent layout cannot put the
container into a restart loop.

For Compose, mount the deployment-owned script and set `HERMES_PATCH_SCRIPT`
in `.env`; the Compose file passes that variable through without enabling a
patch by default.

For example, keep the script outside the image and add an override file:

```yaml
services:
  hermes-webui:
    volumes:
      - ./hermes_patches:/opt/data:ro
    environment:
      HERMES_PATCH_SCRIPT: /opt/data/apply-hermes-patches.sh
```

Patch scripts are deployment-owned and must be kept compatible with the
installed Hermes Agent version. An entrypoint override that calls a custom
patch script directly is outside the image's startup contract; use the image
entrypoint and `HERMES_PATCH_SCRIPT` when the patch is optional.

## Common Operations

Recreate:

```bash
docker compose up -d --force-recreate
```

View auth token:

```bash
docker compose logs hermes-webui | grep token
# or
cat ./hermes_data/hermes-web-ui/.token
```

Stop:

```bash
docker compose down
```
