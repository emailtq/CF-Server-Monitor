# Unified per-node Agent credentials implementation plan

> For developer chats: use superpowers:executing-plans for your assigned task only. The user explicitly requires visible child chats, not subagents. Do not commit, push, release, deploy, or continue to the next task; the primary owns acceptance and commits.

**Goal:** One independent node token for monitoring and terminal Agent connections, without old shared-secret compatibility.

**Architecture:** Reuse terminal_nodes as the one token store, with separate token_version and terminal credential_version epochs. Authenticate reporting in transport headers with bounded revocation leases, preserve browser/local terminal authorization, and replace shared-secret discovery with short-lived registration.

**Tech Stack:** Cloudflare Workers/D1/Durable Objects, JavaScript ES modules, Vue 3, Node 22/node:test/Miniflare, Go 1.27.3, existing shell/PowerShell installers.

**Spec:** D:/Program_code/cloudflare_worker/CF-ssh/CF-Server-Monitor/docs/superpowers/specs/2026-11-12-node-token-design.md

## Global constraints

- No secret fallback in the final Agent protocol. Preserve existing nodes/history; old Agents require reinstall.
- One token, 32 random bytes / 64 lowercase hex characters. Terminal-only disable never rotates it or stops monitoring.
- Preserve administrator login, exact Origin checks, local terminal opt-in, tickets/epochs/leases, bounds, and trusted-theme policy.
- New ordinary command credential is -token (installer may privately stage --install-node-token); Docker uses NODE_TOKEN. No SECRET or TERMINAL_TOKEN fallback.
- No unrelated refactoring, new dependencies, UI redesign, editing generated dist, real credentials, main pushes, releases, or deployments.
- Work locally in the existing codex/admin-ui-refactor branches. Primary and developer are sequential; unrelated untracked .planning/, AGENTS.md and prior docs remain untouched.
- Developer writes an evidence ledger in .planning/2026-11-12-node-token-2026-11-12/task-N-report.md; do not edit the primary task_plan.md, findings.md, or progress.md.
- Use TDD: add a focused failing regression, show RED, implement, show GREEN, run related suites. Do not update expectations just to hide a regression.
- Primary inspects the whole diff and adjacent callers, reruns scoped tests, records acceptance, and commits explicit files only before dispatching the next task.

## Runtimes

Worker root W = D:/Program_code/cloudflare_worker/CF-ssh/CF-Server-Monitor.
Agent root A = D:/Program_code/cloudflare_worker/CF-ssh/cfsm-agent.
Node 22 = W/.planning/2026-11-05-agent-terminal-proposal/tools/node-v22.23.4-win-x64/node.exe.
Go = W/.planning/2026-11-05-agent-terminal-proposal/tools/go/bin/go.exe.
Git Bash = D:/Extra_Downloads/APPs/Git/bin/bash.exe.
Set NODE runtime PATH for npm subprocesses. Do not use ambient Node 24 as acceptance for Node 22.

## Task 1: Canonical node credentials and independent terminal permission

**Files:** Create src/database/nodeCredentials.js and test/node-credentials.test.js. Modify src/database/terminal.js, src/handlers/terminal.js, src/database/schema.js, src/database/updateDatabase.js, package.json, and connected terminal tests/harnesses.

**Consumes:** Existing terminal_nodes storage, generateRandomSecret, AES-GCM server-ID binding, existing terminal broker credential_version behavior.

**Produces:** ensureNodeCredentialSchema(db); readNodeToken(db, serverId, encryptionSecret); ensureNodeToken(db, serverId, encryptionSecret, now=Date.now()); issueNodeToken(db, serverId, now=Date.now(), encryptionSecret=''); verifyNodeToken(db, token, requestedId=undefined) -> null or {serverId, tokenVersion, version}. read/ensure return {token, version, tokenVersion, enabled, needsRotation}; enabled means terminal permission only. General credential verification ignores terminal enabled but joins a live server.

- [ ] Add a D1-backed regression asserting a token for a terminal-disabled live node authenticates monitoring, while verifyTerminalNodeToken/current terminal admission still denies terminal; missing/deleted/cross-node credentials deny.
- [ ] Run Node 22 `--test test/node-credentials.test.js` and record failure before implementation.
- [ ] Extract one canonical credential implementation, migrate token_version idempotently, preserve old ciphertext/hash and terminal epoch semantics, and update terminal callers to share it. General reads remain readable when enabled=0. New generic issuance does not implicitly enable terminal; existing terminal prepare/enable actions explicitly enable permission. Reset increments both epochs; terminal disable does not increment token_version. Remove redundant terminal credential aliases once callers are updated.
- [ ] Add concurrency/stable-read, ciphertext tampering/wrong node binding, hash-only explicit reset, no-silent-rotation, terminal-disable token preservation, and reset-version tests. Example invariant:

```js
const before = await readNodeToken(db, id, encryptionSecret)
await revokeTerminalNode(db, id)
assert.equal((await verifyNodeToken(db, before.token, id)).tokenVersion, before.tokenVersion)
assert.equal((await readNodeToken(db, id, encryptionSecret)).token, before.token)
```

- [ ] Run new tests and related terminal-install-credentials/auth/api/disable/broker/lease tests. Record exact commands, results, migration behavior, and changed files. Stop for primary acceptance.
- [ ] Primary accepts and commits `feat(auth): add canonical per-node credentials`.

## Task 2: Strict Worker reporting, lifecycle, and independent administrator auth

**Files:** src/handlers/update.js, src/durable/MetricsBroadcaster.js, src/handlers/admin.js, src/middleware/auth.js, src/index.js, relevant utils/cache and agentConfig callers, test/node-report-auth.test.js, existing update/agent-config/terminal-report/admin/import-export/auth tests, package.json.

**Consumes:** Task 1 verifyNodeToken/read/ensure/issue and token_version. Terminal permission is independent from token validity.

**Produces:** HTTP/WSS header-based node authentication; <=60-second reporting authorization leases and proactive invalidation; admin actions node_read_install and node_reset_token with dedicated no-store token responses. Add/import provision credentials, delete invalidates live channels. No reporting API_SECRET requirement or JWT signing fallback.

- [ ] Write failing HTTP and actual WSS tests for Authorization bearer success, secret-only denial, missing/wrong tokens, mismatching ID, and terminal-disabled monitoring. Register the new test file.
- [ ] Run Node 22 `--test test/node-report-auth.test.js` and preserve RED evidence.
- [ ] Authenticate HTTP per request and WSS before upgrade, deriving the node ID from the verified token. Remove secret/body/query credential acceptance and first-message shared-secret authentication. Frame identity must match the authenticated node. Preserve metrics, config acknowledgements, batching, sampling, schedule gating, and authenticated terminal observations.
- [ ] Add version/lease checks to reporting message, config-push, and alarm paths; no plaintext token in attachments. An outage never renews an expired lease. Internal invalidation requests require a fresh trusted DO request and cannot be invoked by public headers. D1 revocation commits before notifications.
- [ ] Wire node creation/import/download/reset/deletion to the canonical store. Remove api_secret from admin responses. Remove startup Agent-secret requirement and JWT fallback while retaining API_SECRET only as optional first-admin-password bootstrap. A configured site without API_SECRET must load/admin-login/report correctly; missing persisted signing authority fails closed.
- [ ] Write clock-controlled tests for live and idle WSS reset/deletion/expiry, config pushes after revocation, outage inside/outside lease, stale cache/attachments, public forged invalidation, and no credential leakage in lists/exports/public config. Example negative request:

```js
const old = new Request('https://example.com/update', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({id: nodeId, secret: 'old-shared-secret', metrics})
})
assert.equal((await worker.fetch(old, env, ctx)).status, 401)
```

- [ ] Run scoped new/affected suites and terminal-report-state tests; record all behavioral changes and stop for primary acceptance.
- [ ] Primary accepts and commits `feat(auth): require node tokens for Agent reporting`.

## Task 3: Secure auto-registration without shared reporting secrets

**Files:** src/handlers/agentRegistration.js (new), src/database/nodeCredentials.js or dedicated registration storage, src/utils/autoDiscovery.js, src/handlers/admin.js, src/index.js, test/agent-registration.test.js, test/auto-discovery.test.js, package.json.

**Consumes:** Canonical node issuance and existing partitioned node insertion; auto_discovery setting controls registration only.

**Produces:** Admin action node_prepare_registration -> {key, expiresAt}; POST /api/agent/register with Authorization Bearer key -> {serverId, token}. Fixed 15-minute expiry, replacement invalidates prior key, maximum 100 registrations per key, hashed storage, no-store responses. Shared-secret discovery through /update is impossible.

- [ ] Add a D1-backed failing test for valid registration returning a unique node token and for an existing-name request not obtaining the existing node token. Run Node 22 `--test test/agent-registration.test.js` to prove RED.
- [ ] Implement administrator-only same-origin key issuance and bounded registration. Keep key out of settings/list/export responses, logs, and reports. Create a fresh node regardless of name matches; source address/name fallback is metadata only. Atomically enforce expiry, active key hash, cap, node creation, and credential issuance; roll back on any failure.
- [ ] Test disabled auto-discovery, anonymous key issuance, wrong/expired/replaced keys, cap exhaustion and concurrent last-slot attempts, oversized/invalid JSON, caller-selected existing IDs, same-name theft, rollback on issuance failure, and registration key rejected at reporting and terminal endpoints.
- [ ] Run Node 22 `--test test/agent-registration.test.js test/auto-discovery.test.js test/node-report-auth.test.js`; document schema/API shapes and stop for primary acceptance.
- [ ] Primary accepts and commits `feat(agent): add short-lived node registration`.

## Task 4: Agent single-token protocol and installation

**Files (Agent repo):** internal/cfprobe/types.go, cli.go, config.go, install.go, agent.go, report_transport.go, websocket_client.go, terminal_protocol.go, connected callers/tests; install.sh, install.ps1, entrypoint.sh, README.md and installer/release tests. Only modify Dockerfile/workflows if directly required, not for publication.

**Consumes:** Authorization bearer node reporting/terminal; registration API Task 3 {serverId, token}; terminal permission remains local.

**Produces:** Config.NodeToken persisted as NODE_TOKEN; CLI -token, -token-file, -register-key; installer --install-node-token private staging; no Secret/TerminalToken aliases or old flags/config fallback. Registration key exchanged before reporting and not persisted. Same NodeToken used for reports/terminal headers.

- [ ] Write failing Go tests for one NodeToken in HTTP/WSS/terminal headers, no credentials in JSON, token-only monitoring with terminal off, and rejecting old secret flags/config. Run the targeted `go test ./internal/cfprobe -run 'NodeToken|NodeRegistration'` to prove RED.
- [ ] Replace both local credential fields and all callers/tests/fixtures. Preserve protected config replacement, interval/runtime behavior, remote-config identity immutability, explicit local terminal opt-in, token-format validation, and Linux terminal support. CLI/protected-file input is handled across supported platforms; old SECRET config fails with a reinstall message.
- [ ] Implement registration before first report with bounded HTTPS, verified TLS, strict response schema, no cross-origin credential redirects, and no overwrite of a working config on failure. Reinstall with valid saved token reuses it; registration key never persists. A reset token supplied explicitly replaces the old token once for all transports.
- [ ] Update shell/PowerShell installer staging and Docker environment to NODE_TOKEN, including upgrades, dedicated-user permissions, malicious quoting/unsafe-file cases, and help messages. Do not enable terminal from remote config or a monitoring server response.
- [ ] Run full Go tests, race, vet, relevant supported cross-builds, shell/PowerShell parsing, and installer tests. Document exact runtime and no-real-host limitations. Stop for primary acceptance.
- [ ] Primary accepts and commits in Agent repo `feat(agent): unify monitoring and terminal node tokens`.

## Task 5: Copy-only download UI and supported download paths

**Files (Worker):** src/frontend/views/admin/index.vue, connected download/auto-discovery components/fixtures, src/frontend/utils/agentInstallRelease.js, src/shared/agentSource.js, all existing locale files with changed strings, public installer variants, README.md, test/agent-install-release.test.js, test/agent-download-source.test.js, test/frontend-terminal-usability.test.js, test/frontend-node-token-install.test.js, package.json.

**Consumes:** node_read_install/node_reset_token/node_prepare_registration and unified Agent -token/--install-node-token/NODE_TOKEN interface.

**Produces:** Stable per-node command token independent of terminal checkbox; one credential for all supported ordinary installation modes; registration command uses short-lived register-key. Existing layout, typography, Copy/Close, version/proxy/user/options preserved.

- [ ] Add a compiled frontend failing regression for a terminal-off command containing one node token and no secret, then selecting terminal preserving that token. Run the new targeted fixture test to prove RED.
- [ ] Replace apiSecret command use with dedicated token state/read errors. Discard stale node-read responses and clear token/key state on logout/close/node changes. Terminal checkbox enables terminal permission but does not rotate a usable token. Preserve shell/PowerShell quoting and Docker/user/version/proxy behavior.
- [ ] Wire auto-discovery key issuance without exposing global administrator bootstrap secrets or rotating keys during ordinary edits. Update release capability checks to reject old binaries that lack the single-token CLI, using real helper contracts and synthetic release fixtures; do not publish a new version or claim old latest is compatible.
- [ ] Convert supported Worker-hosted legacy installers to token headers/config, or retire them with an explicit fail-before-mutation message pointing to the maintained installer. Never leave a successful shared-secret install path. Update current docs/locales for credential resets, no-compat reinstall, optional bootstrap password, and warnings.
- [ ] Run compiled desktop/mobile download fixtures for token-off/on, node switching/close/logout, errors, Windows/macOS/Docker, registration, proxy/version, and trusted-theme terminal entry. Run relevant locale/install tests and Node 22 frontend build. Stop for primary acceptance.
- [ ] Primary accepts and commits `feat(frontend): use one node token in installation commands`.

## Task 6: End-to-end security regression and final delivery

**Files:** Focused cross-repo protocol/install fixtures and tests, test/node-token-flow.test.js and related existing terminal-flow fixtures, current security/upgrade documentation. Changes must close demonstrated gaps, not redesign accepted behavior.

**Consumes:** Completed Tasks 1-5.

**Produces:** Synthetic end-to-end evidence for installation/config -> report HTTP/WSS -> observed enabled state -> authenticated browser terminal -> PTY data path, plus monitoring when terminal disabled and simultaneous revocation. No production claims.

- [ ] Add a focused regression for any uncovered cross-layer contract before fixing it. Exercise registration -> independent node credential -> normal report without a secret, and the same token's terminal connection with administrator ownership/ticket checks. Include old Agent denial and a cross-node attack attempt.
- [ ] Execute full Node 22 `npm run test:all` and `npm run build:frontend`; full Go tests/race/vet and supported build checks. Run independent compiled desktop/mobile download checks and synthetic terminal flow. Record any flaky harness/baseline failure separately; do not conceal failures by weakening assertions.
- [ ] Search final supported source, commands, fixtures and documentation for old Agent SECRET/TERMINAL_TOKEN authentication acceptance, credential leakage, stale capability checks, or direct upstream install links. Retained API_SECRET references must be administrator bootstrap/config documentation only, never Agent auth or JWT signing.
- [ ] Developer returns evidence and stops. Primary reviews, reruns final scoped flow/build checks, resolves any findings through the developer chat, then commits `test(auth): verify unified node token flow` if there are changes.
- [ ] Primary reports commit IDs, passed verification, migration consequences, remaining release/deployment prerequisites, and unverified real-host risks. Do not push or deploy without new authorization.

## Acceptance record

Primary records each task's accepted commit and independent test receipt in the selected .planning directory, updates task_plan.md after every accepted step, and only then creates the next developer chat. Do not equate a developer's completed chat with a passed acceptance gate.
