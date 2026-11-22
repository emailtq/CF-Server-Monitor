# Bundled Monitor themes

These are the reviewed static release bundles used by the opt-in Monitor compatibility host.
The build copies only each release's `dist/` directory to `dist/_monitor_theme/<short>/`;
the metadata files stay in this source directory and are not published as assets.

| short | release | upstream | source archive SHA-256 |
| --- | --- | --- | --- |
| `default` | v1.4.3 | [monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | `78c83ea0343d0ac06507528407eae93af0773239fdefae54024ca9d16a54c0a8` |
| `serverstatus` | v1.5.1 | [monitor-theme-serverstatus](https://github.com/monitor-probe/monitor-theme-serverstatus) | `b0be00e8d3362b3b03f531f00c2d0488d63d431a059e5f84d6a95f169813bf32` |

The themes intentionally retain their original root-relative `/assets/*` URLs. The
compatibility host selects the active bundle by exact hostname and rewrites those requests
to the matching internal asset namespace; the legacy CF frontend remains on its own route.

The upstream repositories publish these bundles under the MIT license. The applicable license
texts are kept beside the vendored packages as `LICENSE-default.txt` and
`LICENSE-serverstatus.txt`; the release archives themselves did not include those files.

Cloudflare Static Assets are asset-first by default. Both the local Wrangler config and the
generated deployment config route `/_monitor_theme/*` through the Worker first, so direct
requests cannot bypass the compatibility host's rejection of internal paths.

To enable the compatibility host in GitHub Actions deployments, set the repository variable
`MONITOR_COMPAT_HOST` to the exact DNS hostname and optionally set `MONITOR_COMPAT_THEME` to
`default` or `serverstatus`. If the theme is omitted, `default` is selected. With neither
variable set, the compatibility host remains disabled; no hostname is configured by default.
Invalid or incomplete values fail the deployment configuration step rather than producing a
partially configured host.

## Choose and configure from CF admin

Open **Admin → Themes → Minimal Monitor themes**. Preview either bundled release, select
one for the Monitor entry, or choose **Follow deployment**. A saved D1 selection takes
precedence over `MONITOR_COMPAT_THEME`; with neither selected, Default is used. This does
not enable the hostname or change the ordinary CF homepage. The legacy GitHub-theme and
Mikus controls remain separate.

Default's **Show summary** setting is its manifest-declared boolean. Saving `false` hides
the original four summary blocks; **Restore defaults** stores `{}`, allowing the release's
own default `true`. ServerStatus declares no settings and has no empty settings dialog.
Selection and per-theme overrides use dedicated settings rows and are included in server
settings backups as `settings.monitor_theme`; deployment bindings are not backed up.
Invalid authoritative state is an error, not a fallback theme.

Preview requires the existing administrator preview authentication and an explicitly public,
unchallenged site. It never saves a global selection. The `monitor_preview` URL context is
preserved across the original SPA's navigation and WebSockets by a small **preview-only
HTML response bootstrap**. Vendored files and normal public HTML are unchanged. Root-relative
assets and APIs use the same authenticated context, with no-store responses; normal homepage
requests do not consume a theme-selection cookie. Private-site and Turnstile theme sessions,
and runtime archive installation, are not included.

For isolated development QA, build with `npm run build:frontend`, then run
`npm run preview:monitor-theme -- default`. The script prints a Monitor hostname URL and a
local-only auto-login `/_fixture/admin` URL; `localhost` on the same printed port exercises
the unmatched CF homepage and authenticated preview. All data and fixture login authority
are ephemeral, with no Cloudflare credentials or production connection.
