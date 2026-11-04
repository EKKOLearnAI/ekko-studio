# Remote Studio → Desktop browser

The browser shown by the Desktop client belongs to that computer. A remote
NAS/server cannot read its loopback broker descriptor or validate the desktop
PID. Previously the browser MCP returned an empty tool list in this setup.

## Enable

Both server and Desktop client must include this change. Connect to the remote
Studio through Desktop device management and log in. Open the browser panel,
choose **Allow remote control**. This single action enables sharing without a
second confirmation dialog. The button stays pending until the server accepts
the Socket.IO connection; a connection failure is shown and revokes the local
grant instead of reporting sharing as enabled. The grant lasts for the connection only. Start a new
Agent turn/reconnect its browser MCP if it previously cached an empty catalog.

Desktop startup and device selection allow up to 300 seconds for remote
readiness, with each response bounded by the remaining overall timeout.
The sharing connection and browser relay response budgets are also 300 seconds.
Explicit caller cancellation and shorter configured readiness overrides still
take precedence.

The browser MCP always advertises its compact catalog, even offline. Local
broker access retains its original behavior; without a local broker it calls
the authenticated Studio relay. Missing Desktop authorization reports an error,
not a silent switch to an unrelated browser.

## Security boundary

The Desktop main process issues a separate revocable broker client capability.
Broker secrets are never returned to the renderer or remote server. Only the
main Desktop renderer can ask for consent or invoke the capability. The
connection is outbound Socket.IO; no CDP/listening port is exposed on the LAN.

Relay routing requires an authenticated user and an authorized Profile. Requests
are rechecked for revoked/expired credentials. Model-run credentials must map
to an identified user through the existing HTTP authentication middleware.
Anonymous/server-token calls cannot inherit another user's desktop. The first authorized Desktop is the active owner. A second Desktop remains on
standby until the owner has had no reported human input for 10 minutes. A fresh
trusted pointer/key/wheel event in the visible Studio renderer can then transfer
ownership, but never while a browser request is in flight. Background heartbeat,
focus, visibility and Agent calls do not refresh human activity. Input inside
an embedded external browser page is not currently reported as Studio input.
Each authenticated MCP run is pinned to its first Desktop. After takeover or
disconnection, further calls from that old binding fail rather than following
the new owner. For legacy profile credentials the binding conservatively spans
the MCP process lifetime: reconnect that MCP to intentionally use the new owner.
In-flight work is allowed to finish; it never jumps desktops mid-operation.
Standby activity while busy is not replayed later. Both desktops show active,
standby or busy state. Ownership transfer is not an extra authorization grant;
both devices must already have explicitly enabled sharing.

This grants **account/Profile-level** browser access, not isolation between
individual chat runs in that same Profile.
Agents can read logged-in pages, take screenshots and operate controls. Only
approve a trusted Studio server/account, use HTTPS on untrusted networks, and
stop sharing before another person uses that account/Profile.

Disconnect, logout, Profile switch, renderer navigation/crash or Desktop exit
revokes sharing. Reconnection does not silently restore it. The Desktop
broker's per-tab leases/takeover remain authoritative. Stop sharing also
revokes queued operations for that client. Already completed browser effects
cannot be undone by revocation.

The reverse Socket.IO transport retains the server's existing 2 MB message
limit; oversized screenshots may fail rather than changing that global bound.
No arbitrary JavaScript evaluation, filesystem path or raw broker endpoint is
accepted by the relay API.

## Validation and rollout

Automated coverage includes actual Socket.IO request/ack and user/Profile
authentication rejection, expired authorization, MCP subprocess fallback,
disconnection/late-response discard, explicit consent, and existing broker
leases/takeover. Builds cover the server/client and Desktop TypeScript.

A real Desktop + remote NAS test remains required: enable sharing, list the
visible tabs, open a harmless page, capture it, then stop sharing and verify
further calls fail. This checkout does not update or restart any installed
Desktop/NAS instance automatically.
