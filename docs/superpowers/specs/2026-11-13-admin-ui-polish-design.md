# Approved Admin UI Polish

Approved by the user on 2026-11-13. Continue on `codex/admin-ui-refactor`, baseline `47b14e4edf379919e885e023abf3147e9635f4ad`. One developer chat per stage; the parent independently verifies, requests corrections, then commits before dispatching the next stage. No push, deployment, main merge, Agent edits, or protocol/authentication changes.

## Nodes

Match the local minimal monitor implementation in `../monitor/web-admin/src/components/Admin.tsx` and `components/ui/{table,button}.tsx`: font family, size/weight/line-height, spacing, columns, icons and buttons. Retain CF-specific fields/terminal action and established flag/OS assets, but do not invent a new visual design. Mobile retains a horizontally scrollable table without page overflow.

Port the behavior of `slide` and `useDragOrder` to the existing Vue flow: live reorder, short transform-based displaced-row animations, layout-position hit testing, unequal-row-height hysteresis, edge scrolling, stable pointer capture, Escape/pointer cancellation/outside release restoration, keyboard ArrowUp/ArrowDown, reduced motion. Remove the old cloned ghost and colored target indicator. Preserve full-order save semantics, filter restrictions, site ownership, serialized quick saves, error visibility and server-authoritative reconciliation. No per-move requests or new dependency.

## Download and Token Rotation

At 320-390px use a full-width single-column label/control layout, except short switch rows. Desktop can retain two columns. Readable long choices and descriptions; do not solve clipping by shrinking fonts or hiding important text. Only the dialog body scrolls vertically; commands wrap and footer copy stays reachable. Match the minimal switch size/colors for checked, unchecked and disabled states in light/dark themes.

Keep all install fields and generated command/credential semantics. The added user request includes token reissue: match the minimal installation dialog's rotation entry, confirmation, busy/error/success feedback and interaction flow; investigate current lag rather than adding artificial delay. Retain destructive confirmation and explain that the old credential stops working. No automatic rotation on open or redundant credential reads, no request from stale site/node/dialog ownership may mutate the new dialog, no duplicate concurrent reset, no browser persistence/logging of real tokens. Old token invalidation and active connection revocation remain unchanged.

## Terminal

Fill the available visual viewport. Remove the public admin header and bulky always-visible metadata/status/risk blocks. Keep a narrow connection-object/menu strip. Opening the menu reveals an overlay sidebar without shrinking the terminal: back, reconnect, disconnect, remote disable, language/theme, session details and risk text. Show connection/disconnection/error feedback inside the terminal region, visibly distinguish it from remote output. Preserve clear errors and safety text without new authentication prompts.

Keep an easy mobile keyboard entry and optional special-key controls, clipboard, IME and session ownership. Verify touch scrolling of normal shell history and new-output behavior when reading old output. Respect full-screen/alternate-buffer programs; do not indiscriminately emit arrow keys from touches. Diagnose event/render/resize overhead using actual xterm 6.0.0. Keep bounded output/ACK protocol, final output, disposal, theme refresh, accessible controls and no session recreation on layout changes. Do not disable accessibility to gain speed.

## Acceptance

Node 22, existing dependencies only. Tests use actual mounted Vue/xterm browser fixtures and meaningful runtime assertions, not just source regexes. New tests must enter the explicit npm test list. Use 1440 desktop and 320/360/390 mobile, light/dark and zh/en/ja or affected locale matrix. Parent runs fresh commands and reviews screenshots and computed geometry. Reordering checks include tall/short rows, 200-node drag, edge scroll, cancel, queued saves/failure and site changes. Download checks include every target OS, long choices, switches and token rotation races/failure. Terminal checks include real history scroll, continuous output, alternative buffers, keyboard-height/IME and teardown/security regressions. Final full `npm run test:all`, `npm run build:frontend`, `npm run build:github-page`. Browser emulation does not prove physical Android fling/IME performance; report that limitation.
