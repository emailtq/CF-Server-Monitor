# Terminal Task 2 Review

Scope: node broker, pairing, admission, routes and consent/revocation integration. Parent review of the stopped Task 2 candidate on 2026-11-05, based on fed6a9e. No commit, push or deployment of this candidate.

## Decision

Accepted for the Task 2 checkpoint after the repair and independent verification on 2026-11-06. The initial three required findings are resolved; their original evidence is retained below. This does not accept the complete feature or real Cloudflare/Linux behavior.

## Findings

1. [P1] Failed persistence leaves an uncommitted reservation occupied. In src/durable/TerminalBroker.js:37, mutate changes live metadata before storage.put. A rejected first reservation write is propagated without rollback or safe restart/cleanup. The open request returns 503, but terminal_status still reports activeCount=1 while persisted sessions remain empty. A bounded event/state queue is not enough to make the failed transition atomic. Make persistence failure fail closed and recover metadata/accepted-peer ownership consistently; test reservation and admission failure paths, not just audit failure.
2. [P2] Status for an ordinary unconfigured node creates a new broker. src/handlers/terminal.js:88 unconditionally forwards terminal_status to the DO even when the node has never had terminal credentials. This creates unnecessary DO storage/namespaces for legacy/default-off nodes, and returns 503 if the binding is unavailable instead of reporting disabled status. Return a safe disabled/unsupported/zero-session result without instantiating a broker when there is no terminal authorization record; retain real broker status when valid existing terminal state must be observed.
3. [P2] Normal exit drops the validated exit code. src/durable/TerminalBroker.js:301 closes both sockets on an agent exit frame without first forwarding the protocol exit notification. A browser gets disconnected but never receives {type:"exit", code:7}, although the protocol defines broker exit controls. Forward the validated exit frame before cleanup; keep untrusted error text out of audit and responses.

## Independent evidence

- Node 22.23.4 npm test: 223 passed, 0 failed/skipped, exit 0. These tests did not catch the findings.
- Parent local regression suite: 0 passed, 3 failed, exit 1. Unconfigured-node status returned 503 instead of 200; failed storage reservation reported one active session instead of zero; browser exit frame was undefined instead of the expected validated code.
- The persistence test used a test-harness-only one-shot rejected put plus a fault endpoint. Production files were unchanged for the repro. Original harness bytes were restored in finally and its SHA256 matched.
- A separate parent mutation disabled the exact-Origin administrator guard. The existing Origin test failed (0 passed, 1 failed, exit 1), confirming this guard is covered. Original handler bytes were restored and its SHA256 matched.
- Raw logs and parent-only regression source live under .planning/2026-11-05-agent-terminal-proposal and are not staged. The storage regression requires the test-only fault hook, so migrate it to the permanent harness rather than running the restored harness without fault injection.

## Verification boundaries

The current test harness reconstructs TerminalBroker over actual accepted workerd sockets and storage. It does not prove real Cloudflare eviction, billing or Linux PTY behavior. Those remain later acceptance gates. Credits, user-inactivity enforcement and retention maintenance belong to Task 3; their absence here is not presented as feature completion.

## Repair and acceptance

- Metadata changes now operate on a bounded draft; socket acceptance/send/close effects occur only after successful persistence. Failures reload durable authority, remove lost/abandoned reservations and bindings, and fail closed if recovery reads fail. Healthy storage failures preserve unrelated committed sessions; failed user close is retryable and does not report success.
- Ordinary nodes without terminal authorization return disabled status after the normal Origin/JWT/D1 checks, with zero broker calls. Nodes with authorization still use actual broker status.
- The validated exit frame reaches the browser before cleanup. Arbitrary peer error text remains excluded.
- The developer migrated the parent regressions and added failure coverage for reservation/admission/attach, pairing/start/ready, user close, alarm writes, ambiguous acknowledgement, failed recovery reads and cold reconstruction. The parent read these tests and revised code.
- Parent unchanged local regression suite: 3 passed, 0 failed/skipped. Parent mutation disabling the new no-cold-broker shortcut: its formal regression failed 0/1; original handler bytes/SHA256 restored.
- First full parent run was interrupted by host modern standby: 231/232 passes with a closed test socket and approximately 963-second delays in two cases. The failed log is retained. A Kernel-Power standby-exit event matched the shared delay; both cases passed with a 45-second limit afterward. No host power setting or assertion was changed.
- Fresh uninterrupted `npm run test:all`: 232 suite tests passed, agent-config assertion script passed, 6 history-query tests passed; zero failures/skips and exit 0. Full suite duration: 43600 ms. This fresh result, not the interrupted run, supports acceptance.
- Both frontend builds exited 0. The normal frontend build was rerun last to leave Worker `dashboard.html` assets in the generated dist directory. No generated files, tool downloads, local logs, secrets or AGENTS.md are staged.
- Resource regressions still verify zero D1/storage/alarm/timer operations for auto-heartbeats and data frames. Real account charges and actual platform eviction remain explicitly unverified.
