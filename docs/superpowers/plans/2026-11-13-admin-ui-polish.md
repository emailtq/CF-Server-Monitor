# Admin UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. The user specifically requires visible developer chats and parent-only acceptance/commits; that instruction overrides worker-commit defaults.

**Goal:** Match minimal monitor node/download presentation and reordering, and deliver a usable full-viewport mobile terminal.

**Architecture:** Keep existing Vue components, administrative APIs, canonical node credentials, and xterm transport. Replace only relevant presentation/interaction paths. Run three sequential developer chats, with parent diff/runtime review and parent commit after each.

**Tech Stack:** Node 22, Vue 3, existing Vite/Playwright browser fixtures, xterm 6.0.0, node:test.

**Spec:** `docs/superpowers/specs/2026-11-13-admin-ui-polish-design.md`

## Global Constraints

- No dependency, Agent, backend protocol/auth, public UI, deployment configuration, push or deployment changes.
- Preserve unrelated existing untracked files; all task evidence goes under `.planning/2026-11-13-admin-ui-polish/`.
- Child developers may not commit, stage, create further chats/agents or start subsequent stages.
- Parent independently verifies every claim; failures return to the same developer chat before the next stage.
- Read installed relevant skills and repository AGENTS.md. Keep ASCII code unless existing locale/reference text requires Unicode.

### Task 1: Node List and Reordering

**Files:** `src/frontend/views/admin/components/ServerTable.vue`, `src/frontend/views/admin/index.vue`, `src/frontend/styles/admin.css`, optional narrowly scoped Vue drag helper, `test/frontend-admin-reorder.test.js`, corresponding `test/fixtures/admin-ui/` browser fixture, `package.json` explicit test list.

**Interfaces:** Consume `servers`, `selectedApiIndex`, existing filtering and administrative site generation. Produce a displayed full order and the existing `save_order` payload `{action:'save_order',orders:[...ids]}`; keep site-bound requests and reconcile from `loadServers`. No changed terminal-ready semantics.

- [ ] Read the complete reference `slide/useDragOrder` and local table/button/token CSS; trace every current drag-start/drop caller before editing.
- [ ] Mount real ServerTable/admin in an existing-style browser fixture and write RED checks: during pointer movement DOM row IDs change before save; mixed-height rows do not oscillate; cancellation restores IDs; one release emits one complete order; rapid saves remain serialized and stale site results are ignored.

```js
assert.notDeepEqual(await page.locator('tbody .server-row').evaluateAll(rows => rows.map(row => row.dataset.serverId)), initialOrder)
assert.equal(saveRequests.length, 0) // Before pointer release.
```

- [ ] Run `node --test test/frontend-admin-reorder.test.js`, record a real assertion failure before implementation.
- [ ] Port layout-position FLIP reordering and edge scroll into Vue; remove the clone/old target styling, retain normal full-order authority, add reduced-motion/keyboard handling and reference geometry.
- [ ] Independently verify new tests, existing frontend admin/terminal regressions and desktop/mobile reference screenshots; parent alone stages and commits accepted Task 1.

### Task 2: Download Layout, Switches and Token Reissue

**Files:** `src/frontend/views/admin/components/CopyCommandModal.vue`, `src/frontend/styles/admin-download.css`, only necessary locale entries, `test/frontend-admin-download.test.js`, corresponding browser fixture, `package.json`.

**Interfaces:** Consume the accepted node list and existing CopyCommandModal props/emits. Keep `node_read_install`/`node_reset_token`/terminal enable flow, exact command token flags and request-owner checks. No changes to issuance APIs.

- [ ] Read the reference InstallDialog/rotation flow and trace CopyCommandModal credential/load/reset handlers; reproduce clipping, CSS-specificity switch issue and duplicate/stale token-request behavior in an isolated browser.
- [ ] Write RED checks for 320/360/390 widths, each OS, long labels, switch computed colors, token rotation confirmation, immediate pending feedback, single reset, failure and stale owner results.

```js
assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true)
assert.notEqual(offColor, onColor)
assert.equal(resetRequests.length, 1)
assert.equal(await page.locator('[data-copy-command]').isEnabled(), false) // During reset.
```

- [ ] Run the new test RED, implement only the approved UI/ownership fixes, and run GREEN alongside node-token/install tests.
- [ ] Parent reviews mobile/light/dark/locales screenshots and fresh runtime assertions, then commits Task 2 before terminal development.

### Task 3: Terminal Workspace and Touch History

**Files:** `src/frontend/views/admin/Terminal.vue`, `src/frontend/composables/useTerminal.js`, optional focused terminal UI component, necessary locales, terminal tests/browser fixtures and `package.json`.

**Interfaces:** Consume existing `useTerminal({serverId,apiIndex})` refs/methods and same route; retain session authority, `sendInput`, ACK accounting, renderer drain and disposal. Add only narrowly scoped UI/scroll hooks if public xterm APIs are needed.

- [ ] Reproduce real xterm history touch scrolling and inspect current xterm 6 viewport behavior; establish whether touch handling, selection, repeated layout or output refresh is responsible before fixing.
- [ ] Write RED runtime checks for normal-buffer `viewportY` movement, alternate-buffer isolation, continuous output while scrolled up, full-height screen, sidebar overlay, keyboard shrink, IME and disposal.

```js
assert.ok(afterViewportY < beforeViewportY)
assert.equal(await page.locator('.admin-header').count(), 0)
assert.equal(socketReservations, 1) // Opening the sidebar/theme change must not reopen.
```

- [ ] Implement the approved narrow header/overlay/sidebar and local feedback, mobile controls and smallest valid touch/resize fix; do not alter ACK/security behavior or disable accessibility.
- [ ] Run runtime/terminal protocol regressions, parent reviews fresh browser screenshots and accepts/commits Task 3.

### Task 4: Parent Whole-Change Acceptance

- [ ] Review all three stage diffs against the approved spec, check no functionality/credential/error/locale path was removed.
- [ ] Run fresh `npm run test:all`, `npm run build:frontend`, `npm run build:github-page`, and `git diff --check` using Node 22.
- [ ] Return actionable findings to the appropriate already-authorized developer chat; independently reverify and commit corrections.
- [ ] Deliver commit IDs, evidence and explicit physical Android limitation; do not push, deploy or merge.

## Preflight Review

| Pair/Task | Shared Interface | Result |
|---|---|---|
| Task 1 / Task 2 | package.json and node IDs | Sequential commits; Task 2 appends tests without dropping Task 1. |
| Task 1 / Task 3 | terminal row entry/status | No ready/disabled semantics change; existing same-origin route retained. |
| Task 2 / Task 3 | terminal locale keys and install permissions | Stage 3 reads accepted locale changes and preserves local-install opt-in. |
| Task 1 | Full-order tests and current save_order | No new backend API needed; local preview never filters a saved order. |
| Task 2 | pending copy test and existing token flow | Copy is blocked while credential authority is unknown/resetting. |
| Task 3 | history test and real xterm | Only normal-buffer history gets viewport scrolling; no synthetic remote input. |
| Task 4 | verification commands and scope | Existing Node 22 and browser dependencies reused; production untouched. |
