# Terminal Task 1 Review

Scope: protocol and independent authorization foundation only. Reviewed on 2026-11-05 by the parent chat after developer chat 01a1abee-98e2-7402-ba25-7cadae5e8142 stopped writing. Baseline: monitor 609cc0b. No deployment or push.

## Decision

Accepted for the Task 1 checkpoint. No unresolved blocking findings in this scope. This is not acceptance of the complete terminal feature.

## Findings and resolution

- Resource finding: existing administrator authorization initially attempted INSERT plus SELECT on every request. The developer added a failing query-count regression and changed this to one indexed SELECT for existing jtis. Missing records use SELECT, conflict-do-nothing INSERT, then SELECT. No cached authorization bypasses revocation.
- The shared SITE_FIELDS list feeds ordinary settings saves. The change explicitly excludes terminal_enabled from that path, preventing future step-up activation from being bypassed. Backup/import white lists also exclude this switch.
- Node rotation uses atomic UPSERT/RETURNING with monotonically increasing credential versions; only hashes persist. Terminal JWT validation requires independent signing material, admin subject, signed integer expiry, bounded jti and a matching unrevoked database record.
- Protocol controls reject wrong sender roles, extra fields, invalid dimensions and oversized UTF-8 messages. Binary data remains distinct from JSON controls.

## Independent verification

The parent ran these checks under Node 22.23.4 after reading the actual tests, new modules and all tracked integration diffs:

| Check | Result |
| --- | --- |
| npm test | 195 passed, 0 failed, 0 skipped; exit 0 |
| npm run build:frontend | Built successfully; exit 0; generated dist is not committed |
| Revocation mutation | Replacing conflict-do-nothing with a tombstone-clearing UPDATE made the concurrent first-use test fail: 0 passed, 1 failed; mutation command exit 1 |
| Mutation restoration | Original auth.js bytes restored in finally; SHA256 matched before/after; full suite passed after restoration |
| Query-cost regression | Existing terminal administrator: one indexed read; node token: one indexed read; ordinary monitoring authentication: zero added D1 operations |
| Existing baselines | Original monitor suite: 176 passed; unmodified agent go test ./... passed on Windows with Go 1.27.3 |

Local raw logs are retained in .planning/2026-11-05-agent-terminal-proposal and excluded from feature commits. No real credentials were used.

## Remaining feature gates

Broker admission/pairing, hibernation reconstruction, credits/leases/revocation delivery, retention maintenance, agent consent/PTY/control, UI/locales and end-to-end acceptance belong to Tasks 2-8 and are not implemented or accepted here. Real Linux PTY/race and real Cloudflare checks need their respective test environments. The audit helper accepts bounded codes; future callers must map untrusted peer errors to canonical lifecycle reasons instead of persisting arbitrary peer text.
