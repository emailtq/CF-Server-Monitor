# Unified per-node Agent credential design

## Approval and scope

The user approved one independent node token shared by reporting and terminal Agent connections, explicitly rejected legacy shared-secret compatibility, and authorized sequential visible developer chats with primary review and local commits. The primary owns this design, the plan, acceptance, and commits. Developer chats must not use subagents, commit, push, release, deploy, or start the next step.

Worker baseline: e5fa1252f06f320383abe8967827f7e97d3057d1.
Agent baseline: cb300c8061c784fcb3036390a59c3d768840c8ee.
Both local branches: codex/admin-ui-refactor. Existing unrelated untracked files stay untouched. No work on main and no production changes.

## Product contract

- Every installed node has one 32-byte cryptographically random token, encoded as 64 lowercase hexadecimal characters.
- Ordinary commands contain the node token, endpoint, local terminal switch, and existing installation/collection options. No reporting secret or separate terminal token.
- The node ID may remain a non-secret routing identifier. Authentication determines the node; a supplied mismatching ID is rejected.
- Local terminal opt-in remains mandatory. A monitoring token is valid when terminal permission is off. Authenticated terminal_enabled reports affect status, not token issuance or authorization.
- Browser terminal operations continue to require administrator authentication and same-origin authorization. A node token is not an administrator login credential.
- Closing terminal permission does not rotate the token or interrupt monitoring. Resetting the node token invalidates reporting and terminal credentials together.
- All old shared-secret reporting paths are removed, not grandfathered. Existing node IDs, metrics, settings, and history are preserved; all existing Agents need reinstalling with the new command.
- Existing trusted same-origin themes, copy-only download UI, existing locales, and platform-specific terminal support rules remain unchanged.

## Storage and lifecycle

Reuse the existing terminal_nodes credential row as the single credential store. Its historical table name does not justify a risky table rename or a second token store. Move general credential behavior into src/database/nodeCredentials.js and share it with reporting and terminal paths.

Existing token_hash and token_ciphertext remain SHA-256 and AES-GCM respectively. Ciphertext remains bound to the server ID using authenticated additional data; no plaintext token is stored in D1. Credential reads require authenticated administrator access and Cache-Control: no-store. Tokens never enter public configuration, metrics, lists, notification payloads, exports, or logs.

Add token_version for reporting credential revocation. Existing credential_version remains the terminal lifecycle epoch because terminal-only disable already increments it. Token reset increments both values; terminal-only disable increments only credential_version. Each explicit administrator revoke advances the terminal epoch even while permission is off, fencing earlier in-flight enable requests; maintenance-only disabled revocations remain no-ops. A saturated terminal epoch cannot be enabled again. enabled remains terminal permission, not monitoring credential validity. This keeps existing terminal broker generation/ticket protections without making a disabled terminal stop reports.

Node credential verification must join the live servers row, validate the token format, compare its hash, and bind to the node ID. Enforce token_hash uniqueness so the same bearer token cannot identify multiple nodes. Migration conflicts fail visibly rather than silently choosing a node or rotating existing credentials. Deletion denies credentials even if a retained terminal tombstone exists. New nodes get credentials as part of their creation flow; existing/imported rows get a stable token through authenticated provisioning without deleting data. Reading a usable token must not rotate it. Hash-only or undecryptable rows require an explicit reset, never a silent reset of a running node. Database failures fail closed.

Node reset is an explicit administrator mutation. Commit revocation in D1 before notifying live connections. Reporting token versions and terminal epochs ensure failure of notification cannot leave an indefinite authorization grant. Node deletion, single and batch deletion, and import must preserve this invariant.

## Agent transport and authorization

Use Authorization: Bearer <node-token> for HTTP reports and the WebSocket upgrade handshake, as well as terminal Agent connections. No credentials in report JSON or URL query parameters. Check authentication before accepting an Agent reporting WebSocket; do not open anonymous sockets and authenticate later with a shared-secret message.

HTTP reports authenticate every request. Reporting WebSockets retain only the authenticated node ID, token version, and an authorization lease deadline, not plaintext token. Revalidate against D1 on a bounded lease of at most 60 seconds, shared by message handling and config pushes. Failed revalidation must not extend the lease; database outages may use only the remaining unexpired lease. Alarms close idle invalid/expired sockets, so a silent connection cannot bypass revocation. Cache or already-authenticated attachments must not override a changed token_version or node deletion. A changed/mismatched ID is rejected.

Token reset and deletion proactively notify MetricsBroadcaster and TerminalBroker using internal-only routes. Public forged headers must not invoke invalidation or provisioning. Version/epoch checks are the authoritative fallback; notification failure is reported without rolling back revocation.

Production Agent connections require HTTPS/WSS with certificate verification; explicit loopback-only local development exceptions must not permit remote plaintext transmission. Redirects must not disclose Authorization to another origin. Keep payload/frame bounds, backpressure, concurrency limits, and timeouts. No new dependencies for simple validation or hashing.

## Browser and terminal authorization

Keep independent persisted jwt_secret signing, administrator sub/expiry/jti checks, revocable sessions, HTTPS exact Origin checks, HttpOnly/Secure/SameSite cookies, session ownership, one-time session tickets, terminal epochs, short leases, local opt-in, and PTY cleanup. The token must never become a browser URL credential.

Remove the ordinary login signing fallback to API_SECRET or a known default. The existing persisted random signing-key mechanism is canonical. API_SECRET may remain an administrator-only first-login bootstrap password for existing deployment workflows, but it is never returned by admin data APIs, used to sign JWTs, included in installation commands, or accepted by any Agent endpoint. A site with configured administrator credentials must operate without API_SECRET. Do not change Cloudflare bindings or deploy configuration unnecessarily.

Local credential/config files retain owner-only permissions and safe regular-file handling. The unified token replaces SECRET and TERMINAL_TOKEN in the Agent model, CLI, persistent config, reporting, and terminal connection code. Remote config/MD5 does not include or overwrite token, endpoint identity, or local terminal opt-in. Old flags/configs fail with a useful reinstall instruction, not a fallback. Reinstall must not retain a stale second token.

## Auto-registration

Do not remove the existing auto-discovery product feature or retain its shared-secret bypass. Replace first-report discovery with explicit registration before reporting.

An administrator creates a short-lived registration key when auto-discovery is enabled. Store only its hash, expiry, and issuance metadata. Fixed validity: 15 minutes; a fresh key invalidates the previous key. Return it only in the dedicated no-store administrator action. The key authorizes new-node registration, never existing-node credential reads, terminal operations, or metrics reports. It is an optional bootstrap credential, not a second long-term node credential.

POST /api/agent/register accepts the registration key in Authorization, validates bounded JSON, creates a new node and its independent token, and returns {serverId, token}. Do not deduplicate or return credentials by an unverified name, hostname, source IP, or caller-chosen existing node ID. Preserve existing name/source-IP fallback as display metadata only. Registration writes must be atomic and rate/cap bounded (maximum 100 new nodes per key); expiry and key revocation must be checked in the write transaction, not only beforehand. Existing installed configuration reuses its own node token on reinstall instead of registering again. A failed installation must not overwrite a working local config.

Ordinary installation uses -token or --install-node-token staging. Auto-discovery installation uses -register-key instead of -secret, exchanges it once before initial reporting, and persists only the received node token and ID. It never persists the registration key or sends it in reports. The frontend obtains a key explicitly for the registration command; it does not rotate keys while users edit ordinary command options.

## Installer and frontend behavior

The download dialog keeps the accepted layout, typography, options, Copy and Close actions. Loading/install-read errors cannot yield a partial usable command. Ordinary token reads are stable and independent of the terminal checkbox. Selecting terminal enables only permission/installation state and reuses the same token. Switching nodes, logout, closing the dialog, and stale asynchronous responses clear or discard token state appropriately.

Commands for Linux, macOS, Windows, Docker, and auto-registration use the new model. Linux terminal-enabled installation automatically stages the same token in a private temporary file. macOS/Windows/Docker terminal restrictions remain platform support rules, not theme rules. Shell and PowerShell arguments are correctly quoted. Docker contains NODE_TOKEN, not SECRET or TERMINAL_TOKEN. Point commands at the user's Agent fork, preserving explicit version and proxy options; do not assume an old release supports the new protocol. Update the release capability check so pre-migration binaries cannot be offered as working token-capable downloads. Do not publish a release as part of this implementation.

Worker-hosted legacy scripts that remain supported must use the new header/token model. Any retired script must fail before modifying services or files and direct users to the maintained installer, not silently install a shared-secret Agent.

## Acceptance and limits

Tests must demonstrate wrong/missing tokens, cross-node ID attempts, old secret-only requests, query/body credentials, expired/reset/deleted credentials, WSS revalidation outages, unsolicited registration, registration expiry/cap/races, existing-name theft, and anonymous/browser token misuse are denied. Positive tests cover monitoring with terminal off, the same token for reporting and terminal, stable token reads, terminal-only disable preserving reports, token reset ending both channels, and authenticated terminal_enabled status.

Use existing Node/Miniflare/Vue fixtures, Go tests/race/vet, shell checks, and built frontend. Primary runs independent scoped acceptance for every step, reviews related callers and test evidence, and commits only explicit files. Final acceptance runs Worker test:all and frontend build, Agent tests/race/vet plus supported build targets, desktop/mobile download checks and synthetic terminal flow. Dist is generated, never hand edited. No real-host PTY, production installation, public release, push, or deployment is claimed without a separate authorized run.

Residual risks: a stolen bearer token can impersonate its node and intercept an administrator's connection to that impersonated Agent. Same-origin installed themes are trusted code, not isolated sandboxes. Installation commands can leak through shell history, clipboard, screenshots, and process arguments. Token consolidation does not protect a compromised host, administrator account, or Worker account. Preserve concise warnings without adding manual authorization gates.
