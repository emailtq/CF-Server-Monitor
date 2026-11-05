# Agent terminal Task 3 review

## Initial verdict

Changes required before the Task 3 checkpoint. The parent reviewed the stopped candidate on terminal/9eb6f85; no Task 3 commit or Task 4 dispatch is approved.

## Repair verdict

Accepted for the Task 3 local checkpoint after the stopped repair and fresh independent verification. The initial finding/evidence below is retained; it is resolved, not omitted. No unresolved blocking finding remains within this stage. Real-platform and later Agent/UI gates remain outstanding.

- The only production repair wraps terminal retention in a local try/catch that records the original error, then continues existing weekly/hourly maintenance. No schema probing, automatic initialization, extra retry, new cron or minute query was added. Existing rotation failure handling still allows expiry maintenance to continue.
- Four formal tests cover missing tables, an auth DELETE failure, real Sunday history rotation and simultaneous retention/rotation failures. They assert the error records and actual ordinary work, not just a successful response. The parent read these tests and the added test-only log capture; Broker SHA256 remains unchanged.
- Parent repair mutation removes only retention isolation: all four formal tests fail, no skips, exit 1 (7509 ms). Original index.js bytes are restored with SHA256 A8DFA5271D262EC98B959C4E43A9C2A872E7386E32184C99803CF99A5B769EF9. The unchanged parent regressions now pass 2/2, no failures/skips, exit 0 (4383 ms). Logs: `stage3-parent-repair-mutation.log` and `stage3-parent-repair-green.log` in the selected planning directory.
- Fresh post-restoration `npm run test:all`, Node 22.23.4: 266 regression passes (49915 ms), agent-config assertions pass, 6 history-query passes (1737 ms); no failures/skips and exit 0. Both frontend builds pass (2.03 s normal, 1.94 s static); normal build reruns last (1.94 s) to restore Worker dashboard assets. No generated assets are staged. Logs: `stage3-parent-repair-test-all.log`, `stage3-parent-build.log`, `stage3-parent-static-build.log`, `stage3-parent-final-worker-assets.log`.
- Post-verification `git diff --check` passes. Only scoped feature/tests and this review are eligible for staging; the Agent remains unchanged and clean on terminal/67a3238. Local downloads/logs/secrets, AGENTS.md and shared .planning files are excluded.

## Required finding

- [P1] Isolate terminal retention errors from ordinary monitoring maintenance (`src/index.js:499`). The newly awaited cleanup executes before the existing weekly history rotation and hourly expiry checks. An older installation without terminal tables, or a terminal-specific DELETE failure, throws out of the scheduled handler and skips all remaining ordinary maintenance. Terminal is opt-in, but this regression affects ordinary monitoring too. Ensure the existing work still executes after a terminal cleanup failure and report the failure; do not add per-minute checks or repeated schema initialization to hide it.

## Independent evidence

- The parent read both new test suites, the complete broker, handler/database changes, existing auth and maintenance callers, and the harness changes. Per-direction cumulative credit accounting is bounded; saved counters and last user activity are validated after reconstruction. Only input/resize refresh user activity. Authorization is fresh D1 at admission/start/renewal, with leases anchored before asynchronous reads; no auth renewal happens on terminal frames.
- Fresh `npm run test:all`, Node 22.23.4: 262 regression passes, no failures/skips, 47015 ms; agent-config assertions pass; 6 history-query tests pass, no failures/skips, exit 0. This green baseline does not cover the required maintenance failure.
- Two parent-only regressions fail 0/2, no skips, exit 1, 4158 ms. Dropping terminal tables from an otherwise initialized real D1 yields hourly status 500 and exactly one D1 query, the failed terminal DELETE: ordinary settings/expiry work never runs. A proxy failing only authorization cleanup records just the two terminal DELETE statements, with no ordinary settings read. Source: `.planning/2026-11-05-agent-terminal-proposal/stage3-parent-regressions.mjs`; raw log: `stage3-parent-red.log` in that directory.
- Parent mutation removed only the data credit boundary. Both exact-window tests fail, exit 1 (7513 ms). Broker bytes restored in finally with SHA256 FE457167B81D8C748A0755ABCDC3F2147EBC62511EB207AFCD9F91D7DB9634B7. After restoration the two tests pass, no failures/skips, exit 0 (4462 ms), and `git diff --check` passes. Logs: `stage3-parent-credit-mutation.log` and `stage3-parent-credit-restored.log`.
- The fresh suite independently runs the operation-count assertions: four full bidirectional windows total 2097152 bytes, 128 data plus 8 ACK frames produce 136 attachment writes with zero hot-path D1/storage/alarm/timer work; minute cron has no terminal queries, healthy hourly cleanup has two indexed DELETEs. Index assertions use real D1 EXPLAIN, not regex-only source inspection.

## Harness and platform boundaries

- The new bounded wait for the user_idle control notification preserves its original reason assertion; data socket closure and control messages have no cross-WebSocket arrival order. The original developer failure log is retained. Parent fresh full tests exercise the revised synchronization.
- The manual alarm route deletes the consumed alarm before invoking the class callback. This models the platform's executed-alarm semantics; it is a clock/reconstruction test, not forced real platform eviction.
- Close audit uses DO waitUntil only after durable removal/socket cleanup. The constructor test verifies that an unfinished audit does not hold healthy data behind the constructor. Close auditing remains best effort; admission/start audit remains awaited and fail closed.
- DO send is synchronous enqueue, not a reliable eight-second transport-write completion signal. Logical deadlines reject further forwarding, while passive cleanup depends on platform alarm delivery. Do not promise exact physical closure at second 60 during platform maintenance/faults.
- Real Cloudflare eviction/billing, Linux PTY/race, Agent/UI batching and interactive latency are not yet accepted. Independent builds passed after the stopped maintenance repair; no feature acceptance follows from the developer's build report alone.
