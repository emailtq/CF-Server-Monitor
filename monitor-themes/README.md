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
