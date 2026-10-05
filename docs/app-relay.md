# App connection relay

App Relay lets the mobile App reach a Ekko Studio instance without exposing
the Studio HTTP server to the Internet. It is independent from the MCU
`/global-agent` connection.

Studio can use the official `https://api.ekkostudio.xyz` route or the
Cloudflare `https://cn.ekkostudio.xyz` route. The selected route is persisted
locally and included in cloud QR codes as informational metadata. The App keeps
an independent route setting; scanning a cloud QR never changes it.

## LAN authorization

An authenticated Studio user creates a one-time LAN QR code through
`POST /api/app-connections/authorization-codes/lan`. The QR contains the local
backend URL, machine ID, a high-entropy authorization code, and its expiry. It
expires after five minutes, is stored only as a hash, records the user who
created it, and can be consumed once.

The App exchanges it through `POST /api/auth/app-login` together with its
stable installation device code, device name, brand, and model. Studio issues
a device-bound `app_access` token for the authorizing Studio user. App tokens
use the `hermes-studio` audience and expire after 30 days. Manual LAN login may
use an active Studio username and password instead of an authorization code.

## Cloud preconnection and claim

An authenticated Studio user creates a cloud QR through
`POST /api/app-connections/authorization-codes/cloud`. Studio first signs into
the cloud `/app-relay` namespace with its Ed25519 machine identity, then asks
the cloud for a preconnection. The QR contains only:

```json
{
  "t": "hsac",
  "v": 1,
  "c": "cloud",
  "m": "hwui_...",
  "p": "uuid",
  "k": "high-entropy secret",
  "e": 0,
  "r": "official"
}
```

The compact keys represent type, version, connection type, machine ID,
preconnection ID, matching code, expiry, and Studio network route respectively. Compact encoding
reduces QR density without reducing matching-code entropy. The matching code
expires after five minutes. Refresh has a ten-second
cooldown and is limited to three times for a preconnection; every successful
refresh invalidates the previous matching code. An unmatched host connection
has an absolute 15-minute lifetime and is actively disconnected by the cloud.
The Studio UI never automatically refreshes an expired LAN or cloud QR: it
keeps the QR visible with an expired overlay until the user requests refresh.

The signed-in App sends the QR fields and its stable device identity to
`POST /api/app/connections/claim`. The cloud asks that exact Studio socket to
exchange the Studio-side one-time authorization code. Only after both sides
succeed does the cloud create or reactivate the formal connection.

## Cloud data model and isolation

The cloud stores physical phone installations in `app_device` and formal
phone-to-Studio relationships in `app_device_connection`. A formal connection
is unique by `(appDeviceId, machineId)`, allowing one Studio to connect to many
phones and one phone to connect to many Studios. A device code is globally
bound to one App account.

Account limits are checked through dedicated entitlement hooks. They currently
return unlimited values; subscription or plan limits can later be added without
changing the connection tables or claim protocol. Physical-device limits must
count `app_device`, not connection rows.

Cloud App sockets require three independent credentials:

- the App account access token;
- the formal `connectionId` and App device code;
- a random per-connection credential, stored only as a hash in the cloud.

The cloud derives `machineId` from the formal connection row instead of trusting
the App handshake. The local Studio user token remains separate and continues
to enforce normal Studio user/profile permissions on forwarded requests.

## Presence, deletion, and restart

`GET /api/app-connections` reports live LAN presence from the local relay and
live cloud App presence from the cloud connection pool. Studio polls this list
while the page is visible.

The App uses `GET /api/app/connections/:connectionId/status` for an individual
cloud connection. The cloud verifies that the connection belongs to the
authenticated account, then reads `machineOnline` from the Studio host socket
pool and `appOnline` from the formal App-connection socket pool. Socket.IO
heartbeat loss removes the corresponding socket from the pool. The response is
not cacheable and also returns the Hermes Agent and Hermes Web UI versions from
the machine's latest signed registration metadata. This is a presence lookup,
not a new inbound request to the Studio machine.

Deleting a Studio connection creates a local revocation tombstone. LAN Apps are
notified and disconnected directly. Cloud deletions revoke the formal cloud
connection and disconnect its socket. An offline App is rejected with
`app_connection_deleted` on its next connection and removes the device after
showing a confirmation dialog.

If Studio has any active cloud App records, it connects to the cloud at startup.
Socket.IO reconnects indefinitely after transient disconnects. The cloud
restores the formal-connection snapshot; Studio reconciles it against local
revocation tombstones so an offline cloud deletion is eventually propagated.
Development Web UI hosts use a separate persistent Ed25519 identity and also
register as non-preemptive. Starting `npm run dev` therefore creates a distinct
Web endpoint instead of replacing the packaged desktop socket or overwriting its
machine metadata. Packaged production builds keep the legacy machine identity,
so existing desktop connections remain compatible. Production hosts retain the
existing takeover behavior so a restarted desktop can recover stale connections.

## Forwarded protocols

- HTTP RPC accepts Studio `/api/**` and `/health` paths.
- Request headers, methods, paths, and Socket.IO client events are allowlisted.
- Request and response bodies are capped at 20 MiB.
- Socket RPC accepts `/chat-run` and `/group-chat` only.
- Every bridge is bound to one formal App connection and one host socket.
- Formal connection authorization is rechecked before each forwarded request.

LAN and cloud use the same App-facing RPC event shapes. Their transport paths
are:

- LAN: App → Studio local relay → local HTTP or Socket.IO.
- Cloud: App → cloud relay → signed Studio host socket → local HTTP or
  Socket.IO.

## Cloud observability

The cloud writes structured JSON operational logs to stdout. Authentication
material, passwords, matching codes, authorization codes, and connection
credentials are redacted. Critical App-connection lifecycle events are also
stored in `app_connection_audit_log`; device codes are stored there only as
SHA-256 hashes.

Audit rows default to a 30-day retention period and a maximum of 1,000,000
rows. Cleanup runs at startup, every six hours, and after each 1,000 new audit
records, deleting in bounded batches. Super administrators can query the audit
history through `/admin/appConnectionAudit/getList`. Retention and row limits
can be adjusted with `APP_AUDIT_RETENTION_DAYS` and `APP_AUDIT_MAX_ROWS`.

## Direct P2P transport

Authenticated Apps can negotiate a data-only WebRTC channel using the
`p2p.direct.v1` capability. Manual connections negotiate on this Studio's
`/app-relay`; cloud connections forward only `p2p.offer`, `p2p.keepalive`, and
`p2p.close` through the cloud. The cloud derives the session owner and device
identity from the formal connection, never from an App-supplied target.

Studio terminates the DataChannel in its backend using `werift`, including in
CLI/Docker deployments and with the desktop window closed. Each peer has a
separate authenticated loopback `/app-relay` connection, so the existing local
HTTP and namespace dispatcher enforces device revocation, entitlement expiry,
user/profile permissions, header/path allowlists, and request size limits.
Cloud negotiation additionally checks the local token's device, connection
type, and authorizing Studio user against the formal cloud connection.

The channel uses versioned, ordered JSON frames with binary values encoded as
base64. Each frame carries at most 8 KiB of text; complete messages, concurrent
requests, reassembly and send buffers are bounded. File downloads use the
existing chunk protocol. Download sessions stay pinned to their originating
transport. Transport failure rejects pending requests and never automatically
replays a write. Namespace bridges own chat resume and resubscription.

This version enables direct ICE candidates only. Studio verifies the selected
candidate pair before admitting traffic; TURN offers are rejected. Direct
traffic does not pass through the cloud's bandwidth limiter or traffic meter.
Fallback traffic continues through the unchanged cloud relay and its normal
speed/file policies. Local/manual fallback continues using its existing local
policy. File size and memory limits still apply to direct traffic.

The App uses native data-only WebRTC on Android/iOS and browser WebRTC on H5.
Missing native modules and failed negotiation preserve the existing relay.
Backgrounding closes the direct channel and restores relay namespace bridges,
preserving Android's native notification transport and iOS push behavior.
The original signaling connection stays open. Studio closes all peers on cloud
disconnect; peers must renew a 45-second lease through authorized signaling.

Set `STUDIO_P2P_ENABLED=0` to disable direct negotiation. Optional
`STUDIO_P2P_STUN_URLS` is a comma-separated list of `stun:` URLs; an empty value
uses host candidates only. Defaults are Cloudflare and Google STUN. TURN is
deliberately unsupported in this version; a later TURN integration must enforce
its bandwidth policy instead of treating a relay candidate as an unlimited
direct connection.

### Network interfaces and containers

Studio binds each ICE UDP socket to a real local address instead of a wildcard
address. IPv4 and IPv6 use their respective default-route interfaces. macOS
reads the routing table, Windows reads `Get-NetRoute`, and Linux reads the
kernel's `/proc/net/route` and `/proc/net/ipv6_route` without requiring
`iproute2` in the image. If route discovery is unavailable, Studio enumerates
usable local interfaces. Automatic selection excludes known tunnel adapters,
host-side container bridges, loopback, link-local and Clash fake-IP addresses.
The container's own `eth0` remains eligible. Selection is refreshed for every
negotiation, including after changing networks.

| Variable | Default | Purpose |
| --- | --- | --- |
| `STUDIO_P2P_INTERFACE` | automatic | Exact local interface name, such as `en0`, `Ethernet`, `Wi-Fi`, or container `eth0`. Explicit selection can also use a deployment-owned VPN interface. |
| `STUDIO_P2P_UDP_PORT_RANGE` | OS-assigned ports; Docker image uses `50000-50127` | Inclusive UDP range, `low-high`, between 1024 and 65535, with at most 4096 ports. Use matching firewall and Docker mappings. |
| `STUDIO_P2P_ADVERTISE_ADDRESSES` | unset | Comma-separated literal host/public IP addresses reachable through the published UDP range. Requires a fixed range and a matching local address family. |

Published addresses add same-port host candidates to the answer; Studio still
binds sockets to its own addresses. They do not open extra sockets or bind an
address that belongs to the Docker host. Keep Docker host and container UDP
port numbers identical. A deployment with multiple containers needs a distinct
range per instance. Invalid network settings reject P2P negotiation and the App
continues using its existing relay.

Source binding keeps this Mac's P2P traffic out of Clash TUN while retaining
the system HTTP proxy. Windows/Linux VPN drivers or policy routing can still
force bound sockets through the VPN. Such deployments need a VPN exclusion
for Studio's UDP traffic; a STUN-only exclusion is insufficient because ICE
checks and DataChannel traffic use peer addresses and the same UDP sockets.
With a configured fixed range, filter by the Studio process and that UDP source
range, preserving the application's TCP/HTTP proxy. Allow inbound UDP through
the OS firewall and, for servers, the cloud security group. Do not disable the
whole firewall or alter global proxy settings to enable P2P.

Docker bridge deployments must publish UDP in addition to the HTTP port. For
LAN connectivity, set `STUDIO_P2P_ADVERTISE_ADDRESSES` to the reachable host LAN
IP; for an explicitly forwarded public range, use the corresponding public IP.
A TCP reverse proxy does not carry this traffic. Linux host networking is an
alternative to bridge publication. Docker Desktop adds a VM/network layer, so
host addresses, UDP publication and the host VPN rules all need to agree.
IPv6 candidates require a usable IPv6 address inside the container as well as
an IPv6 path to the host. NAT or firewall restrictions can still prevent direct
connectivity; the existing authorized relay remains the fallback.

Routing and deployment references: [Windows Get-NetRoute](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-netroute),
[Linux network namespace routing files](https://man7.org/linux/man-pages/man5/proc_pid_net.5.html),
[Docker port publication](https://docs.docker.com/engine/network/port-publishing/).
