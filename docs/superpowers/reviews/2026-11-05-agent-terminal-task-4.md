# Agent terminal Task 4 review

## Verdict

Accepted for the local config/protocol/transport checkpoint after independent source review, fresh Windows tests and platform compilation. No blocking finding is established within Task 4. This is not Linux permission/PTY runtime or complete terminal acceptance; those remain required later gates.

## Scope and review

- Read all 15 changed Agent files and their connected install/config/reporting/remote-config callers. Local consent defaults off, absent reinstall fields remain unchanged, remote schema/MD5/metric payloads cannot carry or replace terminal fields, and no Agent.Run/control/PTY/UI wiring is added.
- The CLI takes only an absolute token-file path. Content is bounded to 65 bytes and requires exactly 64 lowercase hexadecimal bytes. Metadata must be regular/restricted; Linux opens with no-follow/nonblocking/close-on-exec and compares the opened descriptor with Lstat. Non-Linux installation is refused without weakening ordinary disabled installs. The two platform opener files are justified security extensions, not PTY scope creep.
- Config writes use a fresh restricted temporary file in the destination directory before Rename, instead of reusing a predictable .tmp. Installation validates explicitly changed terminal consent before service stops/config replacement. Credential fields are not printed in summaries or remote merge logs.
- V1 roles/fields/dimensions/safe cumulative ACK bounds match the Worker protocol. Terminal reading checks the remaining fragmented-message budget before allocation; WebSocket control interleaving does not reset it. The existing reporting reader retains its one-MiB behavior.
- Each connection retains its own ordered writer and real socket write deadlines; no global writer, background terminal connection, unbounded application queue or periodic work is introduced. Active producer/credit/ACK batching and process lifecycle remain Task 5/6 responsibilities, not implemented promises here.
- Terminal endpoints derive only from a credential-free HTTPS origin, discard report queries/fragments, use independent node identity/token/ticket headers, preserve verified TLS/DNS and refuse redirects. Terminal handshake/close errors suppress peer-controlled credential-bearing details. TLS test roots are confined to a child test process, not installed on the host.

## Independent evidence

- Parent mutation removes only the owner-only permission check. The formal regression fails with unsafe-file-metadata acceptance, exit 1. config.go is restored in finally with SHA256 69AA86FFF73FB6258F6ED8F1CBD92264288ACD15CB940BD95ACFDC7D29A441C4.
- Fresh post-restoration Go 1.27.3 Windows/amd64 `go test ./... -count=1 -json`: 205 top-level tests, 272 including subtests pass; no failures or skipped test events; cfprobe 23.319 seconds. Three unchanged command packages have no test files. `go vet ./...` and `git diff --check` pass.
- Parent reviewed the complete matrix script before deriving an identical command matrix with separate parent output paths. Fresh 20/20 release builds pass, including existing ARM variants and MIPS softfloat settings; Windows compatibility/import checks pass. Five test binaries compile for Linux/Darwin/FreeBSD/Windows; the full Windows/386 test binary actually runs and passes. The matrix exits 0.
- Parent logs/artifacts live under the selected untracked planning directory: stage4-parent-permission-mutation.log, stage4-parent-all.jsonl, stage4-parent-vet.log, stage4-parent-matrix.log and stage4-parent-matrix/. Developer logs remain separately retained under TEMP/cfsm-task4-20261106. No downloaded tool, binary, log, local token or shared planning file is eligible for staging.

## Remaining gates

Linux permission/no-follow/FIFO/race and PTY runtime tests have not run. Linux/Darwin/FreeBSD/Windows ARM64 compilation is not runtime acceptance; Linux-specific test branches do not execute in the Windows run even though no test was explicitly skipped. There is no working local WSL/Linux installation and no Docker/Podman command. Do not install/upgrade those or use another server's credentials without authorization. A dedicated authorized Linux environment is required for Task 5 runtime acceptance before its commit/Task 6 dispatch.

Actual Cloudflare eviction/billing, bounded Agent/browser producer batching, interactive latency, seven locales and desktop/mobile end-to-end checks remain later gates. No push, deployment, real probe installation or main change is authorized by this checkpoint.
