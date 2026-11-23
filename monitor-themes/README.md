# Native Monitor themes

These are the reviewed static release bundles used by the Worker default frontend.
The build copies each release's `dist/` directory to `dist/_monitor_theme/<short>/`.
The original Default v1.4.3 `preview.png` is copied separately to an internal metadata
namespace for the authenticated admin thumbnail. Manifest files stay in this source directory.

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

Both local and generated deployment configs use `run_worker_first = true`. The Worker
resolves the selected theme's whole `dist/` tree, including root fonts, images, flags and
scripts, before static assets can intercept it. CF admin static files, installation files,
OS icons and admin-context flags retain their own routes. Direct `/_monitor_theme/*`
requests are rejected.

No hostname variable is needed: `/` and `/node/:id` serve Default out of the box.
Optionally set `MONITOR_COMPAT_THEME` to `default` or `serverstatus`. A saved admin selection
takes precedence. `MONITOR_FRONTEND_MODE=legacy` restores the previous CF frontend for
recovery; in that mode an optional exact `MONITOR_COMPAT_HOST` retains the earlier public-only
compatibility host. Invalid deployment values fail configuration validation.

## Choose and configure from CF admin

Open **Admin → Themes → Minimal Monitor themes**. Preview or select an installed release,
or choose **Follow deployment**. A saved D1 selection takes
precedence over `MONITOR_COMPAT_THEME`; with neither selected, Default is used. This does
not require a separate hostname. The theme page hides legacy GitHub-theme, Mikus and
CF-only appearance controls in default mode; admin language/theme and public data visibility
controls remain available. Site title is edited under Settings.

Default's **Show summary** setting is its manifest-declared boolean. Saving `false` hides
the original four summary blocks. **Restore defaults** resets the draft; **Save** then
stores `{}`, allowing the release's own default `true`. Cancel leaves saved values intact.
ServerStatus declares no settings and has no empty settings dialog.
Other themes draw their settings directly from `theme.json`: string, multiline text,
number with bounds, boolean, select and section headings. Malformed fields are omitted;
keys a version no longer declares are preserved when saving and cleared by reset.
Large forms use the original section navigation and two-column field layout; number
validation includes sections not currently visible. The Use/In use badges, icon actions,
source links, preview.png zoom and non-blocking notifications follow Minimal admin.
Checking updates compares the release tag first and does not download an unchanged version.
Selection and per-theme overrides use dedicated settings rows. Deployment bindings are not backed up.
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
responses; ordinary homepage requests do not consume a theme-selection cookie. A
`monitor_revision` URL context pins each page and its imports to an immutable release,
so an update or removal does not break assets for an already-open page.

## Install the original upstream package

Use the site's existing `DB` D1 binding. No R2, new database or extra deployment variable
is needed. The first runtime install creates the dedicated `monitor_theme_chunks` table;
builtin selection and configuration do not create it. Existing D1 capacity applies:
500 MB per database on Free or 10 GB on Workers Paid. Retained theme releases share that
space with site data; see [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Choose **Install theme**, then enter `https://github.com/owner/repository` or upload its
original `theme.tar.gz`. The repository route uses the latest release's exact `theme.tar.gz`
asset, not a source archive or a GitHub tree theme. Themes execute same-origin JavaScript
with access to site data; the dialog asks administrators to trust the author before installation.

Admission checks gzip/tar paths, checksums, duplicates, entry types and size budgets:
32 MiB compressed, 2000 entries, 8 MiB per file and 64 MiB file payload. The package needs
root `theme.json` and `dist/index.html`. Links, devices, traversal and nested source archives
are rejected. The uncompressed tar is streamed into indexed immutable D1 BLOB chunks
of at most 512 KiB, with eight inserts per bounded transaction;
only a complete validated upload publishes the D1 registry pointer. Failed/conflicting
updates leave the previous release active. Theme JS/CSS files are not patched.

Installation does not write the saved selection. A previously removed selected short
resumes its saved selection when reinstalled. **Update theme** keeps configuration and
requires the same short; upload-only themes without a GitHub source can be updated by
uploading another package. **Remove theme** removes the active registry pointer, restores
the builtin of the same short or falls back to Default, and retains config and revision bytes.
Old revisions are not automatically garbage-collected; removal does not reclaim their D1
rows. Failed installs remove only their unpublished revision. Files are read in bounded
chunk ranges, and same-origin/revision-pinned Worker cache entries speed subsequent reads.
Cache eviction or a cache outage recovers from D1, not from the remote theme author.
Browser-facing resource requests still enforce viewer/preview policy and use `no-store`.

The shared adapter provides native me/nodes/history/live and generic theme config GET/PUT.
Theme-specific SPA routes such as `/instance/:id` work without a CF theme implementation.
Unknown API/admin/Agent paths never become SPA HTML. Optional integrations such as
`/chicken/api/nodes` still require their own service. CF does not invent absent daily totals,
virtualization details or aggregate packet-loss metrics. The package's own missing-data UI remains in use.

## Back up settings and reinstall packages separately

Server settings backups retain the old `{selected,configs}` format for builtin-only state.
Dynamic state uses `settings.monitor_theme = {version:2,selected,configs,packages}`. The
package entries record short, version, URL and optional GitHub repository, not executable
bytes or live D1 revision pointers. Import restores choices/configs but never installs code.
Keep the original packages separately and reinstall the recorded versions after restoring
to another deployment. Until a selected custom short is installed, the effective homepage is Default.

For isolated development QA, build with `npm run build:frontend`, then run
`npm run preview:monitor-theme -- default`, or pass a local `theme.tar.gz` path. The script uses
ephemeral local D1 and prints a Monitor hostname URL and a
local-only auto-login `/_fixture/admin` URL; `localhost` on the same printed port exercises
the actual default homepage without a hostname binding and authenticated preview. All data and fixture login authority
are ephemeral, with no Cloudflare credentials or production connection.
