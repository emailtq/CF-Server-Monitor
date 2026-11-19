# Browser Terminal Stage 1: Input Comfort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement the single current task. Preserve the sequential developer-chat workflow; parent owns review and commits.

**Goal:** Add a session-bound multiline composer and a few missing phone keyboard controls with fitted terminal text sizing while preserving the current browser terminal behavior.

**Architecture:** Extend the current Vue terminal page and its existing xterm composable. Route all explicit composer and virtual key bytes through xterm's existing paste/input queue; preserve mode-aware terminal key semantics. Store only the short-lived draft in component memory keyed to the live session; keep all input capability and server authorization checks unchanged.

**Tech Stack:** Vue 3, xterm.js 6, FitAddon 0.11, existing Node 22/browser fixture, Playwright and Vite test harness already used by this repository.

**Spec:** `docs/superpowers/specs/2026-11-19-browser-terminal-capabilities-design.md` (Stage 1 and its acceptance section).

## Global Constraints

- Keep immediate input and existing Ctrl/Alt/Esc/Tab/Copy/Paste virtual keyboard actions and entry paths unchanged.
- Do not add dependencies or change Worker, Durable Object, Agent, D1, terminal protocol v1 or per-node four-session behavior.
- Reuse xterm bracketed-paste behavior, UTF-8 16 KiB boundary, input queue and ACK/credit handling; do not bypass terminal send APIs.
- New draft is only in memory and bound to the current session. No automatic execution, persistence, replay, cross-node transfer or telemetry.
- Only explicit submit adds Return; report submitted PTY input, never Shell command success. Multiline embedded-newline risk remains visible.
- Preserve current disabled/read-only lifecycle, reduced-motion/theme/localization conventions, touch targets and page sizing.
- No commit, push or deployment by the developer chat. Parent independently verifies then makes the only commit.

---

### Task 1: Implement and verify terminal input comfort

**Files:**
- Modify: `src/frontend/views/admin/Terminal.vue` — optional composer, retained virtual keys, Up/Down/Backspace actions, font controls, session lifecycle.
- Modify: `src/frontend/composables/useTerminal.js` — live-mode-aware cursor delivery, Backspace, bounded append-Return admission, font change/refit API.
- Modify: `src/frontend/locales/{zh,zh-TW,en,es,fr,id,ja}.js` — localized composer, explicit submit, multiline caution, Up/Down/Backspace and font strings.
- Modify: `test/fixtures/admin-ui/terminal-workspace.mjs` and `test/fixtures/admin-ui/terminal-workspace.js` — register real component behavior checks for Stage 1.
- Create: `test/fixtures/admin-ui/terminal-input-comfort-checks.mjs` — browser regression checks using mounted xterm and synthetic peer.
- Modify: `test/frontend-terminal-workspace.test.js` only if it must assert the new fixture check report or separate a focused test; do not change unrelated test registration.
- Do not edit generated `dist/` assets.

**Interfaces:**
- Existing `useTerminal({ serverId, apiIndex })` result and `paste(text)` signature remain compatible with all callers.
- Add a virtual-key method that accepts a closed set of keys and uses xterm's live application-cursor mode; reject unknown keys, non-running sessions and unavailable terminals.
- Add an explicit bounded submit path which reserves paste delimiters and Return together before admitting either; keep both ordered in the existing input queue. On overflow it returns false and leaves the caller draft intact.
- Add `setFontSize(value)` and expose the effective current size within the chosen documented bounds; update xterm option then call FitAddon so resize remains authoritative.

- [ ] **Step 1: Write failing browser assertions for composer and lifecycle**

In the new `terminal-input-comfort-checks.mjs`, add checks against actual selectors from the mounted `Terminal.vue`:
1. The toolbar still exposes the keys toggle, mobile input and keyboard-focus control; current Copy/Paste/Esc/Tab/Ctrl/Alt controls remain present when expanded.
2. Opening composer leaves current PTY input unchanged; typing multiline text and Shift+Enter changes only the draft; explicit send forwards exactly its draft bytes to the synthetic PTY and cancellation forwards nothing.
3. Existing Ctrl toggle plus entering C sends exactly `\x03`; all existing Ctrl/Alt/Esc/Tab/Copy/Paste behavior is preserved.
4. Explicit append-Return sends draft then exactly one `\r` in order; a buffer-capacity rejection leaves the draft visible and sends no Return.
5. Reopen creates a new `sessionId` and clears composer; a non-running state disables sends; simulated IME composition does not trigger keyboard submit.

Run the registered fixture before production edits:

```powershell
$env:TERMINAL_REFINEMENT='1'
node test/fixtures/admin-ui/terminal-workspace.mjs
```

Expected: new assertions fail because current UI has no optional composer/append-Return action. Preserve the failing result in the fixture report, then implement.

- [ ] **Step 2: Write failing browser assertions for phone keys and font fitting**

Extend the same fixture to apply xterm DEC cursor modes `ESC[?1l` and `ESC[?1h`, tap virtual Up/Down in each mode, and assert emitted sequences are respectively CSI (`ESC[A`/`ESC[B`) and application-cursor (`ESCOA`/`ESCOB`). Assert Backspace is DEL (`\x7f`) and the retained Ctrl-toggle plus C path sends Ctrl-C (`\x03`); no dedicated Ctrl+C button is added until Stage 4. At font bounds, assert the displayed size clamps, xterm's `options.fontSize` changes within 10–32 px, FitAddon recalculates dimensions, and the surrounding viewport/control sizes do not scale.

Run the same command and observe these new checks fail for missing actions.

- [ ] **Step 3: Add a session-owned composer without changing instant input**

In `Terminal.vue`, add a default-collapsed toggle and multiline textarea within the existing terminal footer. Keep `showKeys`, mobile immediate input and keyboard focus as distinct controls. Do not autofocus on expand. Keep the draft in a Vue `ref`; preserve it while collapsed and while the same session remains running. Clear on sessionId replacement, loss of running status, page/site exit or unmount. A Cancel/close action sends no bytes.

Expose two clearly labeled actions: “Send text” routes through existing bracketed `paste`; “Send + Enter” uses the explicit append-Return path. The text remains editable until the chosen path admits all bytes. Multiline caution must state that embedded line breaks can be interpreted by the remote program. Never imply that PTY write means command execution succeeded.

- [ ] **Step 4: Implement atomic bounded append-Return delivery through xterm**

In `useTerminal.js`, retain the zero/one-argument behavior of `paste(text)`. Add a separate submit method which first verifies `status === 'running'`, computes UTF-8 payload length and reserves existing pending input plus 12 bracketed delimiter bytes and the final one-byte Return against `TERMINAL_LIMITS.dataFrameBytes`. Reject before calling xterm if the complete submission cannot fit. Then call `screen.paste(text)` and append exactly one `\r` through the same `sendInput` closure before yielding, so output ordering follows the xterm paste event and queue. Return success only if all parts were queued; overflow must not leave an unpaired Return. Do not bypass ACK/credit limits or the paste interceptor.

- [ ] **Step 5: Implement closed-set virtual keys using live xterm mode**

Add only the missing `ArrowUp`, `ArrowDown` and `Backspace` actions, without moving/removing existing controls. For arrows choose `ESC[A`/`ESC[B` or `ESCOA`/`ESCOB` from `screen.modes.applicationCursorKeysMode` at click time. Use DEL for Backspace. Exercise the existing Ctrl toggle with C to preserve the current `\x03` interrupt path; do not add a dedicated Ctrl+C button until the later custom-combinations stage. Route all actions through the same `sendInput` callback; disable if the PTY is not running. Unknown key labels cannot be converted to arbitrary shell content.

- [ ] **Step 6: Add bounded xterm font adjustment and fitting**

Provide the existing terminal menu with a compact minus / current-size / plus / reset row. Start at 14 px, clamp adjustments to 10–32 px, mutate only `screen.options.fontSize`, then call existing `fitScreen()`/FitAddon. Keep font size ephemeral; do not persist it in browser storage, server settings or synchronized commands. Keep keyboard menu controls accessible and touch targets at least 44 CSS px.

The setting is ephemeral and returns to 14 px when leaving the terminal page; no persistence is part of this stage.

- [ ] **Step 7: Localize controls in all supported languages**

Add complete natural strings to the seven listed catalogs for composer toggle, placeholder, Send text, Send + Enter, cancel/clear, multiline warning, arrows, Backspace and font-size/reset controls. Keep locale key sets aligned; do not introduce fallback English strings into zh-TW or other catalogs.

- [ ] **Step 8: Run targeted browser regressions and inspect phone/desktop renders**

Run:

```powershell
$env:TERMINAL_REFINEMENT='1'
node test/fixtures/admin-ui/terminal-workspace.mjs
node --test test/frontend-terminal-workspace.test.js test/frontend-terminal-refinement.test.js
npm run build:frontend
```

Inspect fixture captures with 390×300 and 390×844 coarse touch viewports plus 1440×900 fine-pointer desktop in light and dark. Confirm the keyboard, composer and submit row remain reachable after visualViewport shrink; check 44px hit targets, no horizontal overflow, no clip/overlap, no changed instant-send bytes or old key actions. Browser emulation is not a physical Android IME test.

- [ ] **Step 9: Review full scoped diff and handoff without committing**

Check all seven locale entries align, `package.json` gains no dependency/test suite unrelated change, Worker/Agent/protocol stay untouched, the new test observes actual mounted xterm bytes, and only this stage's files changed. Return a concise handoff with diff paths, tests/build output, exact viewport captures and physical-device gap. Leave commit/push/deploy to parent.
