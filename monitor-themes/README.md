# Bundled Monitor themes

These are the reviewed static release bundles used by the Worker default frontend.
The build copies only each release's `dist/` directory to `dist/_monitor_theme/<short>/`;
the metadata files stay in this source directory and are not published as assets.

| short | release | upstream | source archive SHA-256 |
| --- | --- | --- | --- |
| `default` | v1.4.3 | [monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | `78c83ea0343d0ac06507528407eae93af0773239fdefae54024ca9d16a54c0a8` |
| `serverstatus` | v1.5.1 | [monitor-theme-serverstatus](https://github.com/monitor-probe/monitor-theme-serverstatus) | `b0be00e8d3362b3b03f531f00c2d0488d63d431a059e5f84d6a95f169813bf32` |

The themes intentionally retain their original root-relative `/assets/*` URLs. The
Worker selects the active bundle and rewrites those requests to the matching internal
asset namespace. CF admin, Agent reporting and existing CF API clients keep their entry points.

The upstream repositories publish these bundles under the MIT license. The applicable license
texts are kept beside the vendored packages as `LICENSE-default.txt` and
`LICENSE-serverstatus.txt`; the release archives themselves did not include those files.

Cloudflare Static Assets are asset-first by default. Both the local Wrangler config and the
generated deployment config route `/_monitor_theme/*` through the Worker first, so direct
requests cannot bypass the Worker's rejection of internal paths.

No hostname variable is needed: `/` and `/node/:id` serve Default out of the box.
Optionally set `MONITOR_COMPAT_THEME` to `default` or `serverstatus`. A saved admin selection
takes precedence. `MONITOR_FRONTEND_MODE=legacy` restores the previous CF frontend for
recovery; in that mode an optional exact `MONITOR_COMPAT_HOST` retains the earlier public-only
compatibility host. Invalid deployment values fail configuration validation.

## Choose and configure from CF admin

Open **Admin → Themes → Minimal Monitor themes**. Preview either bundled release, select
one for the homepage, or choose **Follow deployment**. A saved D1 selection takes
precedence over `MONITOR_COMPAT_THEME`; with neither selected, Default is used. This does
not require a separate hostname. The theme page hides legacy GitHub-theme, Mikus and
CF-only appearance controls in default mode; admin language/theme and public data visibility
controls remain available. Site title is edited under Settings.

Default's **Show summary** setting is its manifest-declared boolean. Saving `false` hides
the original four summary blocks; **Restore defaults** stores `{}`, allowing the release's
own default `true`. ServerStatus declares no settings and has no empty settings dialog.
Selection and per-theme overrides use dedicated settings rows and are included in server
settings backups as `settings.monitor_theme`; deployment bindings are not backed up.
Invalid authoritative state is an error, not a fallback theme.

Private sites use the existing CF administrator login session. Global Turnstile opens an
access gate, whose successful verification sets a one-hour HttpOnly receipt using the existing
encryption authority. Login does not bypass Turnstile. APIs and live connections enforce
the same policy; live sessions are revalidated with the ten-second snapshot refresh.

Preview requires existing administrator preview authentication, and Turnstile verification
when enabled. It never saves a global selection. The `monitor_preview` URL context is preserved
across SPA navigation and WebSockets by an HTML bootstrap. Formal HTML also adds a WebSocket
protocol marker, keeping unmarked CF clients on their existing incremental protocol, and
migrates old `/#/server/<UUID>` and `/#/admin` links. Vendored JS/CSS files are unchanged.
Root-relative assets and APIs retain the same authenticated preview context with no-store
responses; ordinary homepage requests do not consume a theme-selection cookie. Arbitrary
runtime archive installation is not provided.

For isolated development QA, build with `npm run build:frontend`, then run
`npm run preview:monitor-theme -- default`. The script prints a Monitor hostname URL and a
local-only auto-login `/_fixture/admin` URL; `localhost` on the same printed port exercises
the actual default homepage without a hostname binding and authenticated preview. All data and fixture login authority
are ephemeral, with no Cloudflare credentials or production connection.
