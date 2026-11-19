# Browser Terminal Capabilities Design

## Goal

Make the existing browser terminal more comfortable on phones and desktop by adding only a few practical tools. Preserve the terminal's current instant-input behavior, its phone-oriented virtual shortcuts, and the familiar terminal workspace; do not rebuild the SSH desktop application's product surface.

## Firm user decisions

- Retain current instant input, Ctrl/Alt/Esc/Tab, Copy/Paste, the existing expandable virtual-key row, keyboard-focus action, and all current terminal capabilities.
- A multiline local composer supplements instant input; it never replaces it, replays a command, or carries a draft to another node/session.
- Mobile and desktop both matter. The Android soft keyboard, focus, usable terminal height, touch targets, selection, and scroll behavior are acceptance-critical; desktop keyboard operation also remains available.
- In a later separate stage, support user-defined single-key actions (for example `R`), combinations (for example `Ctrl+C`), named terminal commands, ordering and authenticated synchronization between that user's panel devices. Do not sync transient drafts, PTY keystrokes or output.
- Server-file download means retrieving a real file from the monitored machine. It is distinct from saving terminal output and requires a separate agent/worker protocol design.
- Do not implement Shell command history or split/multiple terminal sessions.
- Follow the existing sequential workflow: a fresh development chat for each stage; parent independently inspects the diff and decisive tests, parent alone commits accepted changes, then starts the next stage. No push/deploy is authorized by this design.
- Netcatty is a behavioral reference, not code to copy; its GPL-3.0-or-later code/assets remain out of this MIT product.

## Architecture and sequence

### Stage 1 — Terminal input comfort (current)

Vue terminal UI additions only, using existing xterm 6 and FitAddon. Keep the existing one-key mobile entry and virtual-key row intact. Add an optional in-memory composer bound to the current PTY session, missing Up/Down/Backspace phone keys, and bounded terminal-font controls that refit xterm without zooming the surrounding page. Continue using the existing Ctrl toggle plus C for interrupt (`Ctrl+C`); do not add a second dedicated interrupt button in this phase because custom combinations belong to Stage 4. Use the existing paste/input queue, bracketed-paste behavior, 16 KiB limits and ACK accounting. No Agent, Worker protocol, server state, dependencies or remote-command model changes.

The composer is not a command-history feature. It has explicit actions for sending exact text and sending it followed by Return; neither reports Shell success. It must expose the fact that multiline payloads can execute at remote line boundaries and must not promise that sending without the appended Return is universally non-executing. Clear the composer on session replacement, leave/unmount or loss of the running session; a failed local queue admission leaves the draft available for correction/retry. Do not store drafts persistently or send them to telemetry.

### Stage 2 — Search and output helpers

Separate frontend stage: search only output retained by the browser terminal buffer; add optional plain-text export whose filename and UI state its bounded screen-output scope; and, if it remains worthwhile after touch testing, permit only validated `http(s)` terminal links with a touch-safe activation/selection behavior. Do not call terminal output a complete server log. No command history/session recording.

### Stage 3 — Server single-file download

Separate Agent + Worker + browser stage. Design an authenticated, task-scoped, read-only transfer for one regular file from the Agent machine to the browser. Never multiplex file bytes over the existing PTY binary stream or inject `cat`/base64 commands. Preserve the existing terminal authorization/revocation, per-node/owner/site isolation, resource bounds, flow control and old Agent PTY behavior. Define path/symlink policy, limits, transfer expiry, progress, cancellation, client save behavior, version compatibility, and recovery before implementation. Upload, edit/delete, directories, shell history, split sessions, background resume and a full SFTP browser are out of scope.

### Stage 4 — User-defined actions and sync

Separate UI + private configuration stage. Define a typed allowlisted terminal-key schema rather than evaluating keyboard labels or shell text as code. Distinguish single key, combination, inserting a named command into the composer, and an explicitly labeled command+Return action. Synchronize per-user/per-site definitions and order via authenticated private panel storage; apply revision/conflict semantics to prevent lost concurrent edits. Never sync drafts, terminal output, active input, or credentials. Existing built-in keys remain present.

Stages 3 and 4 receive their own implementation design and test plan when reached; they are not smuggled into Stage 1.

## Stage 1 acceptance

- The browser's actual xterm session receives composer bytes only after an explicit action. Newlines inside the draft work while editing. IME composition does not submit; cancellation does not send.
- Existing immediate input and every current virtual key continue to deliver the same bytes, including Ctrl-toggle plus `C` producing `\x03`. Added Up/Down follow xterm's live application-cursor mode and Backspace delivers DEL; read-only/disconnected state accepts no input.
- Failed/oversized submission leaves the draft editable and does not append an unadmitted Return or claim success.
- Composer contents are in-memory and session-owned; no cross-node, cross-site, reopen, or unmount carryover.
- Font adjustment changes xterm only, stays in the documented range, preserves FitAddon dimensions/resize control, and does not rescale site controls.
- Actual browser fixture interactions cover a small phone viewport and a desktop viewport; inspect light and dark renders. Run the focused terminal frontend tests and frontend build. Physical Android must be honestly identified separately from browser touch/IME emulation.

## Non-goals and risks

- The UI cannot infer whether a remote application is a Shell prompt, TUI, password prompt, or interactive editor. Do not gate or claim execution state from rendered text.
- Bracketed paste is preserved, but a remote program that does not support it may interpret embedded newlines; show an accurate warning for explicit submit.
- xterm controls model one real Linux Agent PTY; keep the current four-shell protocol limit, lease, owner and revoke semantics unchanged.
- Keep source contracts independently implemented; do not copy GPL reference code, styles or media.

## Repository baseline

Current accepted code is `63c3731` on `codex/admin-ui-refactor`, after the keyboard/picker repair. Main is unchanged. Existing `Terminal.vue`, `useTerminal.js`, `terminalProtocol.js`, locale catalogs, and `test/fixtures/admin-ui/terminal-workspace.mjs` are the primary Stage 1 touch points. `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 are already installed; do not add dependencies. The protocol stays unchanged.
