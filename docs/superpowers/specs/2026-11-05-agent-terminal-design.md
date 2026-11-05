# Agent-Backed Terminal Design

Status: approved for staged implementation on 2026-11-05, Asia/Shanghai. Production deployment remains unauthorized.

Implementation addendum: the user requires low Cloudflare resource consumption without degrading the terminal experience. Audit each stage for hibernation, no idle D1 polling, no per-byte storage, and bounded producer/ACK batching. Batch at the agent/browser edges, not with persistent broker timers; preserve prompt keyboard echo, bounded memory, security checks and failure behavior. Record measured limits and unavailable real-platform checks rather than claiming free or unlimited operation.

## 1. Objective and boundaries

A logged-in administrator opens a server command-line terminal without SSH credentials. The installed cfsm-agent creates the local PTY and Shell. Cloudflare authenticates and relays; it never executes the server commands.

Target repositories:

- D:/Program_code/cloudflare_worker/CF-ssh/CF-Server-Monitor
- D:/Program_code/cloudflare_worker/CF-ssh/cfsm-agent

Read-only references: komari, komari-agent at ddbdbdcdaeb12abc0e68ba5bc2f0a6b914dad3a7, and CloudSSH.

V1 requirements:

- Linux PTY terminal; up to four independent sessions per node, including two on the same node.
- Built-in, same-origin administrator frontend only. Preserve monitoring on all existing platforms.
- Existing HTTP/WSS reporting, report hours, metric schema version 7, installation and upgrade behavior remain compatible.
- Site-level and agent-local terminal switches default to disabled. A node also needs its own terminal credential.
- No SSH client, SFTP, AI assistant, terminal sharing, arbitrary command RPC, terminal recording, or detached-session restoration.
- A real data-connection failure closes that session. Normal DO hibernation is not a connection failure and must preserve working sessions.
- Existing unsupported platforms and legacy script agents keep monitoring; they do not advertise terminal support.

## 2. Architecture

```text
Browser admin UI ------ existing Worker ------ TerminalBrokerDO(node A)
                                              | control WS from agent A
                                              | browser S1 <-> agent WS S1 <-> PTY/Shell S1
                                              | browser S2 <-> agent WS S2 <-> PTY/Shell S2

Agent metrics ---------- existing /update ---- existing MetricsBroadcaster

Node B uses another TerminalBrokerDO.
```

One new DO class, one instance per immutable server ID. Control and terminal WebSockets are incoming connections accepted with the Hibernation API. The broker does not open outbound TCP or WebSocket connections. Do not attach terminal traffic to the global metrics DO.

The agent establishes a separate low-frequency control WSS, independent of reporting mode/hours. This costs one idle connection per opted-in node, but avoids waiting for the next report and avoids an always-running HTTP long-poll loop. Reuse the existing agent WebSocket transport, TLS/DNS dialing and cancellation patterns; do not reuse the reporting read loop or its interval-derived timeout.

Each session uses its own agent data WSS and PTY. Control requests remain small even if one terminal is producing heavy output.

Cloudflare components: existing Workers and D1, one SQLite-backed DO class, incoming WebSockets and DO alarms. No KV, R2, Tunnel, TCP Sockets or Containers are required. Existing independent administrator JWT signing material is reused; no new mandatory service-wide terminal secret is needed for the opaque-token design below.

## 3. Authorization and one-time setup

### Site and node consent

Add site setting `terminal_enabled`, default `false`. Enabling it requires an authenticated administrator and a freshly verified administrator login secret. Reuse login's `validateCredentials` implementation rather than introducing a new comparison/hash implementation.

V1 refuses site activation while `theme_url` selects a third-party frontend. While terminals are enabled, custom-frontend previews are rejected. Saving or importing a third-party frontend must disable terminal admission and invalidate terminal authorization sessions. This restriction is deliberate: built-in terminal markup alone cannot isolate an administrator Cookie from arbitrary scripts on the same origin. Ordinary theme CSS and built-in themes remain supported. Arbitrary external scripts must be trusted as administrator code; origin-isolated administration is outside V1.

For a particular node, an authenticated administrator generates a 32-byte random terminal token, represented as 64 lowercase hexadecimal characters. Return it once over HTTPS after fresh credential verification; do not save it in browser storage. This is a persistent node credential displayed once, not a one-use SSH credential or enrollment protocol.

The operator stores it in a local, owner-only token file and enables the agent with proposed install options `-terminal=1 -terminal-token-file=<absolute local path>`. Do not offer a plaintext token CLI flag. The installer reads a regular, non-symlink file with restricted permissions, validates the token and writes `TERMINAL_ENABLED` and `TERMINAL_TOKEN` to the existing 0600 config via atomic replacement. Do not print or include the token in generated shell commands, summaries, logs or status output. The original token file remains the operator's responsibility.

Terminal options are local-only: remote configuration cannot enable terminals, replace the credential or change local limits. Reinstall/auto-update preserves them unless explicitly changed. No remote metric/config schema bump is needed.

The agent starts control WSS only when all are true: Linux support, local switch, valid token, a bound server ID, and an HTTPS Worker URL. A missing ID during auto-discovery postpones control startup; it does not break registration or reporting. Startup failures affect terminal availability, not monitoring.

### Independent identities

- Administrator JWT: signed by the existing independent `jwt_secret`, with `sub=admin`, `exp`, and a new random `jti`. Existing tokens without `jti` can continue using existing monitor endpoints but must log in again for terminal access. Terminal authentication rejects the API_SECRET signing fallback.
- Agent credential: node-specific opaque token. Store its SHA-256 hash, version and enabled status in a separate D1 table. Reporting API_SECRET is never a terminal credential.
- Agent session ticket: 32 random bytes, single use, at most 30 seconds, bound to node, session, agent role, control generation and credential version. Only its hash is persisted in the broker. Deliver the plaintext on the authenticated control WSS.
- Browser identity: same-origin Cookie and matching JWT jti/session ownership. Only one browser connection may attach to a session in V1; duplicate attachment is rejected rather than silently replacing another terminal.

A session ID is a locator, never an authorization capability. Nodes cannot request another node's broker by changing a message field. Derive their identity from the validated header credential and compare the server ID and credential version.

### Revocation

Persist terminal-specific administrator authorization records by jti. Logout revokes the current terminal authorization record before clearing Cookies; a stolen old JWT cannot simply reactivate the same revoked jti. Existing general monitoring login semantics are otherwise unchanged.

For the first eligible request from a freshly verified JWT, insert its authorization record with `INSERT ... ON CONFLICT DO NOTHING`, then read/check that record. Never overwrite a revoked record with an active one. The record expires with the JWT, not with a client-supplied timestamp. General monitor endpoints do not need to create these terminal-specific records.

Active terminal leases expire after 60 seconds and renew through an authenticated, same-origin admin request every 45 seconds. Admission/renewal reads terminal authorization and site/node state. Revoked or expired leases are closed by a broker alarm. The frontend closes its local sessions immediately on logout; server-wide logout enforcement is bounded by the 60-second lease, not falsely described as instantaneous across all nodes.

Node disable/delete/credential rotation updates D1 authority first, then tells its broker to close control and data sockets. Report a failed broker notification; lease/credential revalidation supplies bounded cleanup. A failed authority read never grants or renews terminal access. A D1 outage does not stop unrelated metrics collection.

An idle control-only broker does not periodically query D1 just to keep its connection authenticated. Recheck authority when admitting a session and during active-session lease renewal; deliver explicit revocation to the broker. This preserves idle hibernation without an alarm/query every minute on every opted-in node.

## 4. Persistence

Create terminal-only tables through `src/database/terminal.js`, integrated into existing database initialization/update paths:

```sql
CREATE TABLE IF NOT EXISTS terminal_nodes (
  server_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  credential_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS terminal_auth_sessions (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS terminal_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  session_id TEXT,
  actor_jti TEXT,
  event TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS terminal_audit_created_at
  ON terminal_audit(created_at);
```

Do not add credentials to `servers`, site export objects, metrics, notification payloads or public APIs. Regular monitor backups do not include terminal tables or activate terminal access on import. Clean audit records older than seven days, and authorization records after their JWT expiry, in existing scheduled maintenance. Do not record raw input/output or credentials; this is lifecycle auditing, not complete command auditing.

Broker storage holds pending/running session metadata, ticket hashes, deadlines, ownership and credential/control generations. WebSocket attachments hold role and session binding plus bounded counters required after hibernation. Reconstruct peers with `getWebSockets()` and attachments; never rely exclusively on an in-memory Map. Persist metadata on state transitions, not terminal bytes. No terminal-output storage is required.

## 5. API and protocol contract

Administrative actions use the existing authenticated `/admin/api` dispatcher, with additional same-origin and terminal-specific authentication checks:

| action | inputs | result |
| --- | --- | --- |
| terminal_enable_site | freshly verified administrator login secret | global enabled status |
| terminal_authorize_node | serverId, freshly verified administrator login secret | node token displayed once and credential version |
| terminal_revoke_node | serverId | disabled status and broker-close outcome |
| terminal_status | serverId | enabled, connected, protocol, platform, supported, active count; no credential |
| terminal_open | serverId, clientRequestId, cols, rows | sessionId, same-origin browser WS path, lease expiry |
| terminal_renew | serverId, sessionId | new lease expiry |
| terminal_close | serverId, sessionId | closed status; idempotent for an owned session |

`clientRequestId` is a random request ID retained only for retrying one create operation. Replaying it with another owner or different parameters is rejected. Do not automatically replay terminal input.

WebSocket endpoints:

- Browser: `/admin/api/terminal/:serverId/:sessionId/ws`; Cookie, exact Origin and owner validation.
- Agent control: `/api/agent/terminal/control`; `Authorization: Bearer <node token>` and `X-CFSM-Server-Id`.
- Agent session: `/api/agent/terminal/session/:sessionId`; the same node authentication plus `X-CFSM-Terminal-Ticket`.

Do not put long-lived credentials in query strings. Do not expose a public internal terminal DO proxy. Strip any incoming headers that pretend to be trusted internal authorization before forwarding validated context.

Version 1 control examples:

```json
{"type":"hello","protocol":1,"platform":"linux","capabilities":["terminal.pty.v1"]}
{"type":"open","protocol":1,"sessionId":"opaque-id","ticket":"opaque-ticket","cols":80,"rows":24}
{"type":"close","sessionId":"opaque-id","reason":"user_close"}
```

Control and data sockets use the exact application heartbeat `{"type":"ping"}` / `{"type":"pong"}`. Agent heartbeat interval is 30 seconds, read-idle timeout 75 seconds. Use DO auto-response, not permanent DO intervals.

Data socket controls:

```json
{"type":"start","cols":80,"rows":24}
{"type":"ready"}
{"type":"resize","cols":120,"rows":40}
{"type":"ack","bytes":4096}
{"type":"exit","code":0}
{"type":"error","code":"pty_start_failed"}
```

All user input and PTY output are binary UTF-8 byte streams, at most 16 KiB per frame. JSON controls are at most 4 KiB, with known types and integer bounds. Rows/cols are integers in 1..500. Never treat typed JSON text as protocol control; keyboard text is encoded into binary data.

After reserving the session, the agent connects with its ticket but waits for `start`. The broker sends `start` only after both authenticated peers are attached. The agent starts the PTY and replies `ready`; only then is input enabled. Creation times out after 30 seconds. A late agent cannot resurrect a closed/expired session.

## 6. State, concurrency and resource bounds

Broker state: `pending -> starting -> running -> closing -> closed`, with explicit errors on denial, timeout, unsupported agent and startup failure. Reserve the slot and creation-id mapping atomically before asynchronous work. Terminal audit admission must succeed before sending `start`. Closure must still release resources if writing a close audit fails.

Agent session manager reserves an ID under a mutex before starting a process. Duplicate starts return an error; do not create a temporary orphan Shell and remove it afterward. Each session owns its process, PTY, data WSS, cancellation, ordered writer and credits. Never hold the shared session lock while dialing, reading/writing network data or waiting for processes.

Limits are fixed V1 defaults, not new user configuration knobs:

| limit | value |
| --- | --- |
| sessions per node | 4 |
| binary frame | 16 KiB |
| JSON control frame | 4 KiB |
| unacknowledged input per session | 256 KiB |
| unacknowledged output per session | 256 KiB |
| aggregate outstanding data for four sessions | at most 2 MiB, excluding bounded transport overhead |
| credit/ACK stall deadline | 30 seconds |
| socket write deadline | 8 seconds |
| create deadline | 30 seconds |
| user-inactivity timeout | 30 minutes |
| terminal auth lease | 60 seconds |

Separate cumulative counters by direction. An ACK must be monotonic and cannot exceed forwarded bytes. Browser output ACK follows the xterm write callback; agent input ACK follows the PTY write. Pause the corresponding producer when credit is exhausted; limit per-frame work and use separate bounded writers so one slow peer does not stall other sessions. After 30 seconds without progress, close only that session. Ping, output, ACK and lease renewal do not reset user-inactivity; input and valid resize do.

Enforce limits at all three boundaries: browser, broker and agent. A client-side limit alone is not protection. Runtime memory is still shared by isolates, so 2 MiB is an application bound, not a platform isolation guarantee.

For Linux, choose bash if available, otherwise /bin/sh; use the current user's home directory, or fail clearly if it cannot be entered. Set TERM and UTF-8 locale without copying credential-bearing environment variables. Do not import the Komari MOTD script execution prelude.

The backend owns one process Wait operation and closes the PTY descriptor on every exit path. Close the PTY, terminate the known Shell and relevant foreground process groups, then force termination after five seconds if necessary. Do not kill an arbitrary stale/reused PID. Tests must check normal Shell/foreground-child cleanup. Intentionally detached jobs cannot be guaranteed to die without stronger OS containment, which V1 does not introduce.

Agent control replacement uses a new generation, closes old control/data sessions conservatively, and rejects stale tickets/events. Session data disconnect closes its PTY immediately; no five-minute detached mode and no silent output loss/replay promise.

## 7. Code map and integration boundaries

Monitor additions:

- `src/shared/terminalProtocol.js`: frame limits, dimensions and validation, shared by broker/frontend.
- `src/database/terminal.js`: table initialization and terminal metadata/audit access.
- `src/handlers/terminal.js`: administrative actions and authenticated WebSocket routing.
- `src/durable/TerminalBroker.js`: per-node session ownership, pairing, leases, credits, cleanup and hibernation reconstruction.
- `src/frontend/views/admin/Terminal.vue`: lazy-loaded built-in terminal view.
- `src/frontend/composables/useTerminal.js`: one terminal session's socket, events, credits and disposal.
- `src/frontend/views/admin/components/TerminalAccessModal.vue`: step-up, one-time node-token display and local setup instructions.

Modify existing `src/index.js`, database initialization/update, `src/middleware/auth.js`, admin action dispatch/logout/settings/delete/import, frontend router/admin ServerTable/API utilities, all seven locales, and tests. Do not repurpose `createLiveSocket`: it carries monitor subscriptions and reconnect behavior inappropriate for a V1 terminal. Reuse `adminApi`, `usePasswordVisibility`, clipboard and error/display patterns.

Add only `@xterm/xterm` and `@xterm/addon-fit` as lazy frontend dependencies; omit WebGL, SFTP and other addons. The backend remains JavaScript ES modules. Update local Wrangler bindings and append a migration tag in both `wrangler.toml` and `.github/workflows/deploy.yml`; do not rewrite existing migration tags or edit dist.

Agent additions in `internal/cfprobe`:

- `terminal_protocol.go`: mirrored V1 protocol limits and typed controls.
- `terminal_control.go`: separate WSS worker, authentication, heartbeat and reconnection.
- `terminal_session.go`: reserved session IDs, independent input/output pumps, credit windows and teardown.
- `terminal_linux.go`: Linux PTY lifecycle, using `github.com/creack/pty v1.1.24` as the initial candidate to validate.
- `terminal_unsupported.go`: non-Linux backend returning a defined unsupported error without preventing monitor compilation.

Modify `types.go`, `config.go`, `cli.go`, `install.go`, `agent.go` and the existing WebSocket client. Add bounded binary-write/size-limited read support without weakening the existing reporting limit or behavior. Installation wrappers only change if tests show they do not already forward the new options. Preserve compile targets, auto-discovery, atomic config persistence, reinstall merging and update behavior.

## 8. Verification and rollout

Use Node 22 and the agent's go.mod toolchain. Extend existing node:test/Miniflare tests and register each new monitor test in the explicit npm test command. Run agent tests with the race detector on Linux; compile and run existing tests for the current OS/architecture matrix. Cross-build the existing Linux targets with CGO disabled. Stop rather than silently removing legacy artifacts if a dependency is incompatible.

Must-pass integration cases: two PTYs on one node plus a third terminal on another; directory/env separation; resize/Ctrl+C/exit isolation; duplicate creation; slow browser/high output; cancellation during start; stale control generations; expired/replayed tickets; node-credential confusion; logout/rotation; forced DO hibernation; agent restart; reporting HTTP mode and inactive report-WSS hours; old agent operation; 0600 secret storage and no export/log leak; desktop/mobile and all locales.

Roll out backend additions disabled first, then opt-in Linux agents, then enable a test site and authorize a test node. Use a non-production Worker and non-root test server before production. Rollback revokes/turns off terminal access and removes local opt-in; keep additive tables and migration history. Do not deploy/push main as part of planning or testing without explicit user approval.

## 9. Honest security and availability limits

An authorized Shell can operate with the agent user's privileges. Root-agent access is root access. Multiple terminals isolate I/O and process state, not filesystem/OS authority. Credential theft compromises the corresponding node; a compromised management application or Cloudflare execution account can compromise authorized nodes. TLS terminates at Cloudflare; the relay sees plaintext terminal bytes. Optional hostname-based Cloudflare Access/MFA adds defense but does not replace application authorization, and Agent routes need a machine-compatible policy.

Hibernation does not mean heavy output is free. Incoming messages, active processing and storage consume account-shared quotas. One node DO coordinates all of that node's sessions; duration is not simply multiplied by its socket count. No unlimited-free, zero-latency or uninterrupted-shell guarantee is made.

## 10. Approval checkpoint

Confirm before implementation: Linux-first scope, four sessions per node, local token-file authorization, built-in same-origin frontend restriction, and fail-closed/no-detached-recovery V1 behavior. None of these documents authorizes deployment, installs on real servers, or copies reference repositories into the target repositories.
