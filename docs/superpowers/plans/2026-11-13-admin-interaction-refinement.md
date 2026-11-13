# Admin Interaction Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL superpowers:subagent-driven-development or executing-plans. User specifically requires visible developer chats, parent-independent verification and parent-only commits; no nested delegation by developers.

**Goal:** Finish real overlap drag/two-line node metadata, common dialog containment/switch motion and unobtrusive terminal transcript/native paste/menu interaction.

**Architecture:** Reuse Vue keyed rows, existing node order API, shared AdminDialog and xterm transport. Three serial developer stages and final parent review; root fixes stay in owning shared code.

**Tech Stack:** Node22, Vue3, existing Vite/Playwright/xterm6/node:test.

**Spec:** docs/superpowers/specs/2026-11-13-admin-interaction-refinement-design.md

## Global Constraints

- No dependency, Agent/backend/protocol/auth/public UI or deployment changes. No push/deploy/merge.
- All runtime output goes to `.planning/2026-11-13-admin-ui-refinement/taskN/`; add exact evidence root to existing fixture whitelist as necessary, never remove containment checks.
- Developers never stage/commit/create worktrees/chats/agents; preserve existing user history. Parent owns shared ledgers.
- Read applicable skills, root AGENTS, and complete connected reference code. Use existing Node22 `.planning/2026-11-05-agent-terminal-proposal/tools/node-v22.23.4-win-x64/node.exe`; heavy tests serial (`--test-concurrency=1`).

### Task1: Node Overlap and Metadata

**Files:** ServerTable.vue, views/admin/composables/useServerReorder.js, node-scoped admin.css, existing getOSName helper (reuse without changes if possible), test/fixtures/admin-ui/reorder.mjs or new focused fixture/test, package explicit test list if new, fixture evidence roots.

**Interface:** Existing props orderedServers/dragging/tbody capture and `emit('reorder',orders)`; parent save_order full-array/site-owned queue unchanged. Real row transform offset only, not a cloned DOM.

- [ ] Trace all drag callers, existing reference slide/useDragOrder and stable-input test helper. Add RED real-node overlap position checks and two-line DOM/OS labels.

```js
assert.deepEqual(await renderedIds(), before) // visible overlap below threshold
assert.ok(overlapPixels > 0)
assert.notDeepEqual(await renderedIds(), before) // above measured threshold
assert.equal(requestsBeforeRelease, 0)
```

- [ ] Run RED, implement smallest transform/threshold/hysteresis and information placement, admin-only tap correction with keyboard focus preserved.
- [ ] Verify tall/short bidirectional overlap, edge scroll, cancel animated restoration, keyboard/reduced motion, rapid saves/failure/siteABA plus mobile/theme/locale screenshots; parent reviews/runs fresh then commits.

### Task2: All Shared Dialogs and Download Switches

**Files:** AdminDialog.vue/admin.css shared scroll wrapper, admin-download.css/CopyCommandModal only necessary, dialog consumers only where an actual incompatible width exists, all-consumer browser fixture/test and explicit registration.

**Interface:** Shared dialog props/slots/events/focus/busy stay compatible; terminal-only height and focus handoff retained for Task3. Existing canonical install/token requests unchanged.

- [ ] Enumerate every consumer, reproduce border/focus/scrollbar clipping with actual mounted modal sizes, small screen and long locale text before editing. Read minimal dialog/switch implementation.

```js
assert.ok(controlRightIncludingOutline <= scrollContentRight)
assert.equal(dialogOverflowX, false)
assert.ok(footerBottom <= viewportBottom)
assert.notEqual(thumbDuringTransition, thumbBefore)
```

- [ ] Run RED, fix shared scroll edge/gutter/box sizing without double width; add only switch transform/color transitions and pointer feedback, maintain disabled/reduced motion.
- [ ] Verify add/delete/edit/batch/renew/group/download/notification/alert/revoke and all actual shared consumers; busy/trap/Escape/stack/footer/copy/credential races; parent verifies then commits.

### Task3: Terminal Feedback, Native Paste and Menu Slide

**Files:** Terminal.vue, useTerminal.js only required local-render hooks, shared AdminDialog transition integration if needed, necessary locales, existing+new real workspace fixtures/tests.

**Interface:** Keep status/ref/open/close/paste/ACK/epoch/renderdrain authority. Local connection transcript must be separate DOM or separately owned local renderer so FIRST remote output is never cleared; draft paste sends only after explicit current-session validation.

- [ ] RED connection progress text inside host area/non-covering controls, clipboard rejection fallback, menu mid-enter/leave transform and pointer feedback.

```js
assert.ok(connectionTextInsideTerminal)
assert.equal(localTranscriptAfterReady, '')
assert.ok(remoteText.includes('FIRST REMOTE LINE'))
assert.equal(remoteInputsBeforeExplicitPasteSend, 0)
assert.ok(menuMidEnterX < menuStartX && menuMidEnterX > menuEndX)
```

- [ ] Implement plain transcript at real states without changing remote byte/ACK accounting; draft native paste Send/Cancel with size/session fences; reconnect label; neutral settings glyph; animated overlay/sidebar enter/leave with reduced-motion and focus-safe handoff.
- [ ] Verify first-line retention/late output/drain/altbuffer/nativepaste/IME/session loss/permission rejection, unchanged socket/menu dimensions, rapid transitions and all stage2 scroll/focus rules; parent verifies and commits.

### Task4: Whole-Change Parent Acceptance

- [ ] Read full diff vs63ba4d9 and spec; request independent read-only reviewer, resolve any findings through stage owner.
- [ ] Run exact explicit npmtest file list with concurrency1, test:agent-config and test:history-query, both frontend builds, gitdiff--check and source/cleanup guards.
- [ ] Deliver actual commits/tests/screenshots and explicit physical-device limits; do not push/deploy.

## Preflight Interface Review

| Pair/Task | Shared Contract | Ruling |
|---|---|---|
| T1/T2 | admin.css touch and fixture evidence roots | T1 scopes node/appropriate admin control tap highlight; T2 preserves focus and adds own root sequentially. |
| T2/T3 | AdminDialog viewport/scroll/focus | T2 fixes common containment first; T3 adds terminal-only motion retaining leave-time focus/stack rules. |
| T1/T3 | terminal table entry vs standalone workspace | Capability/auth/routes unchanged; no new connections from node metadata. |
| T1 | Real transform vs layout authority | Offset is visual only; DOM/saves full order and cancelled authority retained. |
| T2 | Reserved scrollbar vs100% widths | Measure rendered geometry, not CSS declarations alone; no overflow hidden masking. |
| T3 | Transcript vs remote first bytes | Clear local transcript only, never reset real remote screen/buffer; byte ACK is remote-only. |
| T4 | Full test coverage and resources | Same explicit test set with constrained concurrency, no skips or assertion weakening. |
