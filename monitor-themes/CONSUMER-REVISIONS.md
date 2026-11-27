# CF consumer revisions

These are source-level nullable-data fixes, not redesigned themes. `consumer-revisions.json` pins the six upstream versions, repositories and commits. Each `source/theme.json` keeps the upstream identity. The generated outer `theme.json` and `release/theme.tar.gz` carry `<upstream>-cf.1`, `cf_revision: nullable.1` and the upstream provenance.

## Build and install locally

Use Node 24.15+ and pnpm 11.15+ for the pinned Naive source; npm builds the other five. Dependencies stay in each source directory. No global installation is necessary when those tools are already available.

```sh
npm run build:monitor-consumers -- --install
npm run test:monitor-consumers
npm run build:frontend
```

The source-level `npm run package` entries also route to this CF packager, so they cannot label a modified build as an original release. After the initial install, omit `--install`. To rebuild selected themes:

```sh
npm run build:monitor-consumers -- naive glassmorphism
```

The build runs each upstream compiler/type checker, then creates `monitor-themes/<name>/release/theme.tar.gz` with fixed tar metadata. Upload that archive through the existing theme upload control. Preview, selection, configuration, replacement, deletion and old pinned tabs use the existing D1 revision registry. A local upload of a reviewed CF package is the supported update path; no remote CF release has been published.

Default and ServerStatus are the only builtins. The Worker build consumes their revised `source/dist` and serves them under `builtin-<short>-cf-nullable-1`. Their original `dist` is retained and copied under `upstream/`, so `builtin-default` and `builtin-serverstatus` continue to serve the original pinned bytes. The four community packages remain optional uploads rather than becoming builtins.

`npm test` includes package/registry integration checks using the product build artifacts. The dedicated `test:monitor-consumers` command additionally compiles and executes the actual React/Vue consumers; it requires the per-theme dependencies above. It does not launch a QA or browser service.

## Unknown is not zero

- Unknown day/month/lifetime counters render `—`. A mixed known/unknown sum stays unknown; it is not presented as a complete partial total.
- Explicit `month_used: null` remains authoritative. The older directional calculation is used only when `month_used` is absent. Up/down modes require only their selected direction; max/sum require both.
- KANSO preserves older hubs' live monthly counters when the corresponding top-level field is `undefined`; a top-level number (including zero) or explicit `null` takes precedence over `metrics`.
- Unknown quota use leaves the existing bar empty and its reading unknown, while known zero remains zero. Missing monthly counters no longer discard otherwise-valid live resource metrics.
- Unknown loss denominators show `丢包未知`/`未知`; 0 ms remains a successful latency. Native healthy buckets omit `loss` and resolve to 0 only with a known window denominator. Rows tagged `legacy-summary/unknown-denominator` remain unknown even if they carry a legacy numeric summary.
- API and WS numeric values, nulls, sources and coverage are unchanged. Windows reports missing required load/swap fields still have the separately documented strict-consumer limitation.

## Updating upstream without losing the fix

GitHub update checks on a CF revision return `monitorThemeConsumerRevisionRequired` before downloading. Repository reinstall or archive upload cannot silently replace an installed CF revision with a raw package. To intentionally return to upstream, remove the installed runtime revision and install the original package again; original third-party packages retain their normal same/new-version update behavior. Repository installation also protects revised builtins from an unreviewed raw replacement. An explicit local original-package upload can still override a builtin; its original version/source remains visible.

To maintain a CF revision, import the new upstream source deliberately, review the nullable paths, update the pinned provenance and CF revision identity, rerun consumer tests and build/package checks, then complete desktop/mobile light/dark live acceptance. Do not edit minified bundles, overwrite the original reference `dist`, or label an untested upstream release as fixed. Publishing a remote theme release requires separate authorization.

Live visual/interaction acceptance for these revisions is pending the project's existing QA/reference/Ego recovery gates; source tests and local builds do not close that gate.
