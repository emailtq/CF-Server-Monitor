# Agent Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after human approval. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent-driven development is an alternative only if the human explicitly chooses it.

**Goal:** Add opt-in Linux Agent terminals with four independent sessions per node, without SSH credentials or changes to existing monitoring transports.

**Architecture:** One hibernatable TerminalBroker DO per node accepts a separate low-frequency agent control WSS and independent browser/agent session sockets. The agent owns each PTY, Shell, credit window and cleanup lifecycle. D1 stores independent hashed node credentials and terminal-specific administrator authorization; terminal bytes are not persisted.

**Tech Stack:** Node 22, JavaScript ES modules, Vue 3, Workers/D1/SQLite DOs, node:test/Miniflare, the cfsm-agent go.mod toolchain, creack/pty, xterm.js and addon-fit.

**Spec:** D:/Program_code/cloudflare_worker/CF-ssh/CF-Server-Monitor/docs/superpowers/specs/2026-11-05-agent-terminal-design.md

## Global Constraints

- Status: user approved implementation on 2026-11-05. Execute one task per new developer chat; parent independently audits/tests and commits each accepted task to terminal before the next. No push or deployment.
- Resource gate: no D1 per frame, terminal-byte persistence or idle control-only polling; hibernatable inbound sockets and auto-response heartbeats; bounded agent/browser producer and ACK batching without perceptible input latency. No permanent broker intervals for batching.
- Monitor root: D:/Program_code/cloudflare_worker/CF-ssh/CF-Server-Monitor. Agent root: D:/Program_code/cloudflare_worker/CF-ssh/cfsm-agent. Paths below are relative to the stated repository.
- Local and site switches default off; per-node terminal tokens never reuse reporting API_SECRET or enter public data/backups/logs.
- Linux only in V1; preserve all existing monitoring platforms, report schedules, metric/config schema version 7, installations and upgrades.
- Four sessions per node; 16 KiB data frames; 4 KiB controls; 256 KiB credit per direction per session; 30-second ACK/start deadlines; 30-minute user idle; 60-second administrator lease renewed every 45 seconds.
- Dimensions are integers in 1..500; do not replay user input; no detached restoration; hibernation must preserve connected sessions.
- Existing built-in same-origin admin UI only; enforce the custom-frontend/preview gate in the spec instead of claiming built-in markup is an origin boundary.
- Only xterm and addon-fit in the frontend. Validate creack/pty v1.1.24 against all current Linux build targets before pinning it. No SSH stack, broker framework, R2, KV or new runtime language.
- Keep two-space JS style and existing semicolon conventions. Do not edit dist, rewrite old migration tags, copy a whole reference project, run production installers, deploy, push main, or discard pre-existing changes.
- Use failing tests, minimal implementation and verification for each task. Suggested scoped commits are checkpoints, not authorization to commit or push without the user's execution choice.

## Task 1: Protocol and independent authorization foundation

**Monitor files:** Create `src/shared/terminalProtocol.js`, `src/database/terminal.js`, `test/terminal-protocol.test.js`, `test/terminal-auth.test.js`. Modify `src/database/schema.js`, `src/database/updateDatabase.js`, `src/middleware/auth.js`, `src/utils/settings.js`, `package.json`.

**Interfaces:**

```js
// terminalProtocol.js
export const TERMINAL_LIMITS = Object.freeze({
  protocol: 1, maxSessions: 4, dataFrameBytes: 16384,
  controlFrameBytes: 4096, creditBytes: 262144,
  maxDimension: 500, startTimeoutMs: 30000, ackTimeoutMs: 30000,
  userIdleMs: 1800000, authLeaseMs: 60000
});
export function validateTerminalSize(cols, rows) {
  return [cols, rows].every(value =>
    Number.isInteger(value) && value >= 1 && value <= TERMINAL_LIMITS.maxDimension);
}
// Additional exports with the role rules from spec section 5:
// parseTerminalControl(text, role) -> validated control or throws RangeError
// database/terminal.js:
// ensureTerminalSchema(db) -> Promise<void>
// issueTerminalNodeToken(db, serverId, now) -> Promise<{token, version}>
// verifyTerminalNodeToken(db, serverId, token) -> Promise<{serverId, version} | null>
// revokeTerminalNode(db, serverId, now) -> Promise<void>
// revokeTerminalAdmin(db, jti, jwtExpiry, now) -> Promise<void>
// writeTerminalAudit(db, record) -> Promise<void>
// middleware/auth.js:
// getTerminalAdminPrincipal(request, env, sys) -> Promise<{jti, exp} | null>
```

- [ ] Write Node tests for accepted 80x24 and rejected zero, fractional, string and 501 dimensions, oversized/unknown/role-invalid controls, hash-only node persistence, and a token from node A rejected for node B.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTerminalSize } from '../src/shared/terminalProtocol.js';
test('terminal dimensions are bounded integers', () => {
  assert.equal(validateTerminalSize(80, 24), true);
  for (const value of [0, 1.5, '80', 501]) {
    assert.equal(validateTerminalSize(value, 24), false);
  }
});
```

- [ ] Run `node --test test/terminal-protocol.test.js test/terminal-auth.test.js`; expect failure before new exports exist.
- [ ] Implement the exact three tables from spec section 4; generate opaque tokens with crypto randomness, hash before persistence, validate the owning node and monotonically increment credential versions on rotation. Make schema creation idempotent for old databases without modifying existing rows.
- [ ] Add random jti to new administrator JWTs. Terminal-specific verification requires independent sys.jwt_secret, valid admin sub/expiry/jti and an unrevoked authorization record. Keep legacy checkAuth behavior for non-terminal endpoints; do not allow the API_SECRET fallback for terminals.
- [ ] On the first eligible terminal request, insert the verified jti with JWT expiry using conflict-do-nothing and read it back. Test that a revoked jti cannot be overwritten/reactivated; no authorization expiry comes from client fields.
- [ ] Test missing jti, expired token, reporting-secret signature, revoked jti and duplicate revoke. Add `terminal_enabled` default false, keep it out of import auto-activation, and keep all terminal credentials/tables out of current backup objects.
- [ ] Register both files in package.json's explicit test command; run those tests plus `test/user-agent.test.js`, `test/import-export-settings.test.js`, `test/server-backup-format.test.js` and `test/server-insert-sql.test.js`.
- [ ] Checkpoint: review schema compatibility, no credential return except issuance, and existing auth tests. Suggested scope: `feat(terminal): add protocol and independent node authorization`.

## Task 2: Broker pairing, admission and hibernation

**Monitor files:** Create `src/durable/TerminalBroker.js`, `src/handlers/terminal.js`, `test/terminal-broker.test.js`, `test/terminal-api.test.js`. Modify `src/index.js`, `src/handlers/admin.js`, `src/handlers/frontend.js`, `wrangler.toml`, `.github/workflows/deploy.yml`, `package.json`.

**Interfaces:**

```js
// TerminalBroker.js follows MetricsBroadcaster's state/env constructor pattern.
export class TerminalBroker {
  constructor(state, env) { this.state = state; this.env = env; }
  // fetch(request) -> Promise<Response>: validated internal create/renew/close/admission.
  // webSocketMessage(ws, message), webSocketClose(ws, code, reason),
  // webSocketError(ws, error), alarm(): event-driven coordination.
}
// handlers/terminal.js:
// handleTerminalAdminAction({request, env, sys, data, ctx}) -> Promise<Response | null>
// handleTerminalUpgrade(request, env, sys) -> Promise<Response | null>
```

- [ ] Write Miniflare tests that authorize node A, create two owned sessions, attach their peers, and verify input/output routing only to the matching session. Use fake WebSocket clients; do not execute host commands in Node tests.
- [ ] Add rejection cases: fifth node session, expired/wrong-role/reused ticket, mismatched server ID, wrong owner, cross-origin browser, old control generation, duplicate browser connection, closed-session late attachment, and creation audit write failure.
- [ ] Run `node --test test/terminal-broker.test.js test/terminal-api.test.js`; expect failure because the new Worker routes and DO binding do not yet exist.
- [ ] Export the new DO at the Worker entry and append a new SQLite migration tag and binding named `TERMINAL_BROKER` in both configurations. Keep old MetricsBroadcaster tags/classes unchanged.
- [ ] Implement atomic slot reservation and clientRequestId idempotency before async notification. Bind ownership to verified metadata, not a client-controlled message field. Consume agent tickets atomically. Enable PTY start only after both peers attach; fail/close at the 30-second deadline.
- [ ] Use acceptWebSocket, role/session tags and attachments. Rebuild bindings on constructor wake with getWebSockets. Use storage for state transitions/ticket hashes and alarms for the nearest deadline; do not retain outbound sockets or permanent intervals.
- [ ] Wire only the terminal actions to the authenticated admin dispatcher. Enforce Origin, token freshness and site/node state; do not put terminal actions in PUBLIC_ADMIN_ACTION_HANDLERS. Extend the existing public logout action to revoke an authenticated jti if present, while preserving idempotent Cookie clearing for unauthenticated logout.
- [ ] Gate custom frontend activation/preview as in the spec. Node delete/rotation invalidates its broker; site disable revokes authorization. Do not expose terminal broker internal routes through diagnostics.
- [ ] Force a broker hibernation/reconstruction in the integration tests, send more data, then verify peers and ownership survived without a new PTY-start instruction. Run new tests plus `test/frontend-live-socket.test.js`, `test/metrics-broadcaster-agent-config.test.js` and `test/i18n-runtime.test.js`.
- [ ] Checkpoint: existing monitoring routes/bindings unchanged; denial never reaches an Agent start message. Suggested scope: `feat(terminal): add hibernatable node broker`.

## Task 3: Broker flow control and bounded revocation

**Monitor files:** Modify `src/durable/TerminalBroker.js`, `src/handlers/terminal.js`, `src/handlers/admin.js`, `src/index.js`; create `test/terminal-flow.test.js`, `test/terminal-lease.test.js`; modify `package.json`.

**Interfaces:** Binary input and output have independent cumulative byte counters. `ack.bytes` is the cumulative successfully consumed byte count on the opposite side, not a credit grant. Internal session state includes `forwardedInput`, `ackedInput`, `forwardedOutput`, `ackedOutput`, `leaseUntil`, `lastUserActivity`, `generation`, and `credentialVersion`.

- [ ] Write a boundary test with a 256 KiB window: exactly the window is accepted; more data is stopped; a valid cumulative ACK permits the next frame; a backward or beyond-forwarded ACK closes that session. Test both directions.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_LIMITS } from '../src/shared/terminalProtocol.js';
test('four node sessions have bounded outstanding application data', () => {
  assert.equal(TERMINAL_LIMITS.maxSessions * TERMINAL_LIMITS.creditBytes * 2, 2097152);
});
```

- [ ] Run `node --test test/terminal-flow.test.js test/terminal-lease.test.js`; first capture failure of the credit/lease integration cases, not merely the constant self-check.
- [ ] Enforce spec counters and per-frame bounds before forwarding. Maintain ordered sends per peer without holding a broker-wide async lock; limit work per event. Stall/timeout closure affects only the offending session.
- [ ] Renew owner leases after valid same-origin admin requests and D1 authority checks. Alarm-close at lease expiry; renewals and heartbeat/output ACK do not reset user inactivity. Revalidate node authority and control liveness without persisting terminal output.
- [ ] Do not schedule periodic D1 authentication reads on idle control-only brokers. Test that a control connection with automatic heartbeats and no active session can hibernate without minute-by-minute alarms.
- [ ] Test logout jti revocation, failed renewal read, site/node disable, rotation and server deletion. Simulate advancing time beyond 60 seconds and assert all matching sessions close, including after hibernation. Current UI logout is immediate; this test establishes the bounded server guarantee.
- [ ] Add seven-day lifecycle-audit and expired-authorization cleanup to existing maintenance without adding another cron. Fail closed on admission audit failure; cleanup still executes when a close audit fails.
- [ ] Run all terminal Node tests and `npm test`; checkpoint the resource/revocation invariants. Suggested scope: `fix(terminal): bound flow and authorization leases`.

## Task 4: Agent local opt-in and transport support

**Agent files:** Modify `internal/cfprobe/types.go`, `config.go`, `cli.go`, `install.go`, `install_summary.go`, `websocket_client.go`; create `terminal_protocol.go`; extend `config_test.go`, `cli_test.go`, `install_test.go`, `report_transport_test.go`; create `terminal_protocol_test.go`, `terminal_transport_test.go`. Inspect `install.sh`/`install.ps1` and change only if option forwarding needs it.

**Interfaces:**

```go
// Add to Config; remain outside dynamic configuration/MD5.
// TerminalEnabled bool
// TerminalToken string
const terminalProtocolVersion = 1
const terminalMaxSessions = 4
const terminalMaxDataFrameBytes = 16 * 1024
const terminalMaxControlFrameBytes = 4 * 1024
const terminalCreditBytes = 256 * 1024
// validateTerminalSize(cols, rows int) bool
// (c *webSocketConn) WriteBinary(payload []byte, timeout time.Duration) error
// (c *webSocketConn) ReadDataMessageLimit(limit int) ([]byte, byte, error)
// Existing ReadDataMessage retains its current reporting limit and behavior.
```

- [ ] Add compile-failing tests for new config fields, then round-trip enabled/token values through readConfig/writeConfig. Check disabled defaults and legacy files lacking the keys.

```go
func TestTerminalDisabledByDefault(t *testing.T) {
    cfg := defaultConfig()
    if cfg.TerminalEnabled || cfg.TerminalToken != "" {
        t.Fatal("terminal access must be opt-in")
    }
}
```

- [ ] Run `go test ./internal/cfprobe -run 'Terminal|Config|Install'`; expect compile/test failure before fields and behavior are added.
- [ ] Parse `-terminal=0|1` and `-terminal-token-file`. Validate absolute regular non-symlink file, restricted mode and exact token format; reject invalid explicit input before replacing config. Preserve existing values when reinstall does not specify them. Keep token text out of all summaries/debug logs and generated commands.
- [ ] Prove dynamic configuration cannot change either local terminal field, and no terminal key enters metric payloads/config MD5. A normal disabled install needs no token and no terminal-support platform check.
- [ ] Add binary writes through the existing serialized writer. Add size-limited message reads that enforce total fragmented-message size before unbounded allocation while keeping reporting's old reader limit unchanged.
- [ ] Test framing, fragmented controls/data, truncated reads, deadline/cancellation behavior, URL derivation from HTTPS /update, and refusal of HTTP/embedded URL credentials/redirects for terminal authentication. Reuse TLS verification/DNS dialing; never introduce InsecureSkipVerify.
- [ ] Run `go test ./internal/cfprobe`; checkpoint config/transport compatibility. Suggested scope: `feat(agent): add local terminal consent and framing`.

## Task 5: Agent Linux PTYs and independent session lifecycle

**Agent files:** Create `internal/cfprobe/terminal_session.go`, `terminal_linux.go`, `terminal_unsupported.go`, `terminal_session_test.go`, `terminal_linux_test.go`. Modify `go.mod`/`go.sum` through Go dependency tooling only.

**Interfaces:**

```go
type terminalProcess interface {
    Read([]byte) (int, error)
    Write([]byte) (int, error)
    Close() error
    Resize(cols, rows uint16) error
    Wait() error
}
type terminalPeer interface {
    ReadDataMessageLimit(int) ([]byte, byte, error)
    WriteText([]byte, time.Duration) error
    WriteBinary([]byte, time.Duration) error
    SetReadDeadline(time.Time) error
    Close() error
}
type terminalFactory func(cols, rows uint16) (terminalProcess, error)
// newTerminalManager(limit int, factory terminalFactory) *terminalManager
// (*terminalManager).Open(ctx context.Context, id string, peer terminalPeer, cols, rows uint16) error
// (*terminalManager).Close(id string) error
// (*terminalManager).CloseAll(reason string)
// (*terminalManager).Count() int
// newTerminalProcess(cols, rows uint16) (terminalProcess, error)
```

- [ ] Write tests with test-local fake implementations of the two interfaces: two IDs own different processes, one close leaves the other open, duplicate open does not call the factory twice, fifth open fails, cancellation during startup frees a reservation, and factory failure does not leak capacity.
- [ ] Run `go test ./internal/cfprobe -run 'TerminalSession'`; expect missing-manager failure.
- [ ] Implement reservation before factory execution, a single Wait owner per process, per-session input/output pumps, cumulative ACK validation, bounded windows and write deadlines. Do not hold the manager mutex during factory/network/Wait operations. Error/cancellation cleanup is idempotent and closes peer, PTY and process ownership.
- [ ] Implement Linux backend using the approved pty dependency: bash or /bin/sh, user HOME, TERM/UTF-8 and a credential-free environment. Resize with bounded uint16 values. Close the PTY descriptor and known Shell/foreground groups with the five-second force deadline; return a stable unsupported error in the non-Linux file.
- [ ] On a dedicated Linux test environment, start two real PTYs. Write `cd /tmp` to one and inspect `pwd` in both; verify resize with `stty size`, foreground Ctrl+C, closing one session and no leftover ordinary child/PTY descriptors. These are tests, not system service installs.
- [ ] Add stalled-output/slow-input and byte-bound tests with fake peers; verify one stalled session does not hold another's write lock. Do not add detached session buffering or input replay.
- [ ] Run `go test -race ./internal/cfprobe` on Linux and cross-compile all existing Linux artifacts with CGO disabled. Run the existing non-Linux test matrix without starting a PTY. Checkpoint process cleanup and compatibility. Suggested scope: `feat(agent): add isolated Linux terminal sessions`.

## Task 6: Agent control integration and availability

**Agent files:** Create `internal/cfprobe/terminal_control.go`, `terminal_control_test.go`; modify `agent.go`, `report_context_test.go`, `auto_discovery_test.go`.

**Interfaces:** `(*Agent).terminalWorker(ctx context.Context)` owns reconnect/heartbeat and node generations. It constructs the terminal manager once, waits for local prerequisites, authenticates with headers, consumes open/close controls, dials session peers with role-bound tickets, and closes all sessions on shutdown/control replacement. Session sockets wait for broker start before Open.

- [ ] Write local TLS/WebSocket server tests for disabled startup producing no terminal connection, HTTP reporting mode with active terminal control, missing ID during discovery, and startup after ID binding. Use test credentials only; no real Worker tokens.
- [ ] Run `go test ./internal/cfprobe -run 'TerminalControl|AutoDiscovery|ReportContext'`; expect failure before the new worker exists.
- [ ] Start the terminal worker from Run under the existing cancellation context only when locally eligible; keep its errors/retry state out of reporting pause state. Derive endpoints from the trusted HTTPS origin; send node identity and ticket in headers.
- [ ] Implement 30-second heartbeat, 75-second read deadline, bounded retry delay, typed controls and capability hello. Honor broker start, session close and protocol errors; refuse duplicates and malformed/expired attachments without creating a PTY.
- [ ] Test control loss/replacement closes old sessions and rejects stale start commands. An agent data disconnect closes its session; no automatic replay or session reattachment in V1. Ensure normal stop and auto-update shutdown do not leave terminal goroutines running.
- [ ] Run `go test -race ./...` on Linux plus `go vet ./...`; checkpoint independent reporting/terminal lifecycle. Suggested scope: `feat(agent): connect opt-in terminal control worker`.

## Task 7: Built-in administrator terminal UI

**Monitor files:** Create `src/frontend/views/admin/Terminal.vue`, `src/frontend/composables/useTerminal.js`, `src/frontend/views/admin/components/TerminalAccessModal.vue`, `test/frontend-terminal.test.js`; modify `src/frontend/router/index.js`, `src/frontend/views/admin/index.vue`, `src/frontend/views/admin/components/ServerTable.vue`, `src/frontend/utils/api.js`, all seven files in `src/frontend/locales`, `package.json`/`package-lock.json`. Inspect CSP in `src/utils/csp.js` and Vite proxy routes; only adjust if same-origin test evidence requires it.

**Interfaces:**

```js
// api.js: use existing adminApi(data, apiIndex) with spec terminal actions.
// useTerminal.js:
// useTerminal({serverId, apiIndex}) ->
// {status, errorCode, open(container), resize(cols, rows), close(), dispose()}
// open() creates a fresh session; WebSocket reconnect never resends user input.
// A new browser tab can open another session without replacing this one.
```

- [ ] Write Node/browser regression cases for the server-table action, route under `/admin/terminal/:id`, lazy xterm imports, disabled/unsupported states, new session IDs for new tabs, and no use of createLiveSocket or JWT query strings.
- [ ] Run `node --test test/frontend-terminal.test.js`; expect missing route/component behavior.
- [ ] Add only xterm and addon-fit through npm tooling. Load CSS and terminal implementation lazily. Reuse adminApi, HelpTooltip, usePasswordVisibility and clipboard behavior. Do not add a second login system or duplicate generic HTTP wrappers.
- [ ] Implement one-time token display/setup guidance, local consent/root-permission warning, connected-versus-supported status, and terminal-open controls. Do not put credentials in browser storage or install-command text. Route all terminal pages through the built-in admin frontend.
- [ ] Implement binary input/output, output ACK from xterm's write callback, bounded paste, resize observer, focus/IME handling, Ctrl/Alt/Esc/Tab mobile shortcuts, 45-second lease renewal and disposal on page exit. Display disconnected state with explicit reopen; do not silently recreate/replay a Shell session.
- [ ] Add all seven locale entries; test desktop/mobile, two browser tabs, Chinese input, clipboard and virtual-keyboard viewport. Account for the current report API index when constructing same-origin terminal routes; reject unsupported cross-origin configuration rather than silently falling back.
- [ ] Register the UI test; run `npm test`, `npm run build:frontend`, `npm run build:github-page` and verify terminal code is not eagerly loaded by the dashboard. Checkpoint accessibility/locales and existing themes. Suggested scope: `feat(frontend): add opt-in agent terminal UI`.

## Task 8: End-to-end acceptance, documentation and staged release

**Monitor files:** Extend terminal tests and `README.md`, `README-en.md`, `API.md`; review `wrangler.toml` and deployment workflow. **Agent files:** Update `README.md`, install help and only the installation wrappers affected by Task 4; review existing build/release workflows. Add tests to the repositories' existing CI rather than introducing another build system.

- [ ] In a non-production Worker, authorize a non-root Linux test node and run two independent PTYs there plus a third on another node. Verify directory/env isolation, resize, Ctrl+C, exit and closing S1 while S2 remains operational.
- [ ] Saturate S1 output and stop consuming it; prove S2 remains responsive, buffers are bounded and stall cleanup occurs. Test fifth-session rejection and slot reuse after failure/cancel/close.
- [ ] Test report HTTP mode and inactive report-WSS hours, Agent restart, control generation replacement, failed lease renewal, logout, node rotation/delete, expired/reused tickets and forced DO hibernation. Record evidence; a local simulation does not prove real Cloudflare behavior.
- [ ] Test backup/export/import never transports terminal credentials or activates restored terminal access; custom frontend/preview admission gates and unsupported-platform messages match the spec.
- [ ] Run monitor `npm run test:all`, both frontend builds, Agent `go vet ./...`, `go test -race ./...` on Linux and the existing cross-platform/build matrix. On Windows use the existing Agent test matrix; do not pretend it exercised Linux PTYs.
- [ ] Document local opt-in/token-file permissions, new DO migration, login renewal/jti requirement, four-session limit, theme restriction, root privilege, lifecycle-only audit, no detached restoration, failure behavior and rollback.
- [ ] Review all diffs for secrets, unrelated edits and generated dist. Deployment order is backend disabled, updated opted-in test agent, then explicit site/node enable. Production deploy and main push require human approval.
- [ ] Rollback by disabling/revoking terminal access and local opt-in. Keep additive database tables and immutable migration tags; metrics continue. Suggested release scopes: `docs: document agent terminal rollout` and a coordinated agent/monitor release.

## Completion gate

The feature is complete only after all security, two-same-node-session, flow-control, hibernation, ordinary-process cleanup, monitoring compatibility and platform-preservation cases pass with recorded evidence. Planning/document validation alone does not constitute feature implementation or verification.
