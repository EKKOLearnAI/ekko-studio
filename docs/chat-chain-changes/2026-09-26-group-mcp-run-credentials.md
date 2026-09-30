# Group Coding Agent MCP credentials

Group Coding Agent runs previously entered ChatRunSocket without a socket user.
The shared profile JWT writer therefore skipped them, and managed MCP requests
fell back to a static server token that interaction endpoints reject (#3179).

## Authorization

The run coordinator now issues an opaque capability before native launch. Its
server-side binding contains the local profile, session, room, Agent and current
interaction context. The credential requires the matching run context header
and profile; task-plan and clarification bodies must name that exact context.
Native activity and the group executor's freshness guard are checked on every
request. No fixed one-hour cutoff interrupts a still-active long-running turn.

Local human requests may delegate the authenticated identity stored in the local
room membership, provided that account is active and can access the Agent's
profile. Account status and profile access are rechecked for each request, and
ordinary endpoint authorization still applies. Agent handoffs, unauthenticated
guests, and remote relay executions receive only current-turn task-plan and
clarification permissions. A remote room owner or sender ID is never interpreted
as a user ID on the executor's machine. Remote account API delegation is not
implicitly authorized by pairing an Agent.

## Transport and lifecycle

Each turn gets a private `auth.json` under its own Studio `runtime/mcp-credentials` directory
and a separate group runtime configuration directory. The file path is injected
directly into each of the five bundled managed MCP definitions for all six Coding
Agent runtimes, in scoped and global mode. Group runs use the bundled loopback
transport even when a managed server has a custom transport override; enabled
switches and unrelated custom MCP definitions are preserved. Credentials are
never added to prompts, group messages, relay payloads or shared profile files.
The sensitive basename also prevents local, session-share and remote workspace
file APIs from serving the credential. Client-supplied group metadata cannot
delegate account permissions; the internal coordinator must resolve the requester.

The MCP client reads the bound file for every request. A missing, malformed or
foreign-profile file fails closed, without falling back to environment tokens,
tool-argument tokens or another session's profile token. Ordinary single-chat
token precedence remains unchanged; #3036 is separate.

Completion, failure, interruption, replacement, disposal and server shutdown
revoke the capability and remove its file. Cancellation during asynchronous
file creation also removes the late write. A process restart loses all in-memory
bindings, so files left by an abrupt crash cannot authenticate again. Ending an
old context cannot revoke a newer capability for the same session.

## Validation

- Real MCP subprocesses and the HTTP auth middleware exercise simultaneous
  fresh-profile task-plan updates, clarification, stale environment tokens,
  foreign context/profile rejection and file revocation.
- Coordinator tests exercise the userless group launch and terminal/failure
  cleanup; issuer tests exercise restart invalidation and preparation races.
- Local/remote identity tests cover membership lookup and revoked account access.
- Native configuration tests cover all six runtimes in scoped and global modes,
  including concurrent turns of the same room Agent.

These credentials enforce Studio HTTP authorization. They do not sandbox a
Coding Agent's filesystem or shell access under the local operating-system user.
