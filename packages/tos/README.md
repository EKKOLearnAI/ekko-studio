# Ekko Studio for TerraMaster TOS 7

This is a separate, headless **Deb / external Web UI** target. It does not use
Electron or the Linux desktop Deb. The first target is **x86_64 / amd64**.
Packages are marked `beta: true` until their lifecycle and data retention are verified on a TNAS.
Generating or uploading a package is not App Center approval.

## Independent packaging workflow

Use the independent **Build TOS 7 Deb Package** workflow
(`.github/workflows/tos-package-test.yml`). Like Docker and npm packaging, it
automatically runs on GitHub `release.published`, builds that event's tag and
attaches the TOS package to the same Release, then validates with TerraMaster.
No manual tag/input is required on a Release event. It does not submit for review.

TOS-related pull requests only build/test the package. A manual
`workflow_dispatch` entry also remains available: choose **Run workflow** and
select a branch that includes the packager. The workflow keeps packaging tools
at the event commit. On a Release event or with manual `release_tag`
selected, it checks out that exact Git tag into a separate source directory;
without a tag, PR/build-only runs use the event commit. It builds the chosen
source on Ubuntu 22.04, prunes development dependencies, verifies Sharp and
packages the staged production Web UI.

Download **tos7-x86_64-test** from the run's **Artifacts** section; artifacts
are retained for 7 days. The download contains:

```text
com.hermeswebui.studio_<version>_x86_64.deb
com.hermeswebui.studio_<version>_x86_64.deb.sha256
com.hermeswebui.studio_<version>_x86_64.deb.verification.json
```

The build job uses read-only repository permissions. Ordinary PR runs and manual
runs with `upload_to_tdp` disabled only create Actions artifacts. This workflow
remains a separate file/job graph from the main Web UI/desktop release workflows;
those workflows are unchanged. Release publication is their shared trigger.
Only PR runs cancel older in-progress builds; Release/manual runs for a tag
serialize so an upload is not cancelled halfway through.

### Optional Developer Platform parsing test

Configure repository Actions secret `TDP_API_TOKEN` with `version:write` and,
for the first registration, `app:write`. Release events automatically enable
upload/validation and use `github.event.release.tag_name`. For manual runs, use
`upload_to_tdp` enabled and `release_tag` set to the existing versioned Release
(for example `v0.7.35`). Uploads require that tag; the same `0.7.35` / `v0.7.35`
convention used by normal npm releases is accepted. A separate job:

1. Verifies the package SHA-256 and beta/ID/architecture metadata.
2. Checks the token's developer identity and registers the TOS application if
   absent. An existing registration must match the repository and architecture;
   it is never silently modified.
3. Verifies that the package version and built source commit match the selected
   published Release. Attaches the Deb, SHA-256 and report to that Release using
   the built-in `github.token`. It does not create a Release, change its title,
   prerelease/latest flags or existing assets, or invoke the main release
   workflows. Identical assets with matching server SHA-256 digests are reused;
   differing or unverifiable same-name assets fail rather than being overwritten.
4. Asks TerraMaster to download and parse that asset; polls until passed/failed,
   then compares version, architecture, size and SHA-256 with the local bytes.
   The API version tag is the package version (`0.7.35`), and the download URL
   points to the matching GitHub Release (`v0.7.35`). Run numbers are not versions.

Download `tos-platform-test-receipt` for the Release/version tags, built source
and workflow commits, release URL, application UUID, task
UUID, parser diagnostics and parsed metadata. A parser failure is a failed job,
even when HTTP status is 200. Polling is bounded and timed-out task identity is
preserved for inspection. Passed tasks expire after one hour.
If an existing Version is already under review, the workflow can still attach
the assets to the selected Release, but records
`validationSkipped: application_under_review` instead of starting another
parse task. This is not a successful parser result. The existing review is
never withdrawn or altered; retry parsing after it finishes using the same
verified artifacts. Existing submitted Version labels are not renamed.

This test never calls `/confirm`, never creates a Version in review, and never
withdraws/deletes existing versions. It does not establish device compatibility
or App Center approval. Complete TNAS acceptance before a separate decision to
submit for review. Do not pass API tokens through command arguments, repository
variables, source code or public logs.

API reference: `terramaster-tos/tos-app-pkg-tools`, `Developer/agent-api/README.md`,
reviewed at commit `9dc7e43da051b3e4a8e704764ff57e72fc7309fc`.

Local packaging requires Linux x64, Node.js 24 with its full npm distribution,
`dpkg-deb`, `readelf` (binutils), Python 3 (SVG validation), tar and bzip2. Build native dependencies on
Ubuntu 22.04 (TOS 7's glibc 2.35 baseline). Provide a production-only Web UI
directory containing `package.json`, `bin/`, `dist/` and `node_modules/`:

```bash
npm run pack:tos -- --webui-dir /absolute/path/to/staged/webui --output /absolute/path/to/output
npm run verify:tos -- /absolute/path/to/output/com.hermeswebui.studio_0.7.35_x86_64.deb
```

The packager bundles a private Node.js 24 and npm/npx, and refuses other runtime
architectures, broken/external symlinks or ELF requirements newer than glibc
2.35. It explicitly generates `DEBIAN/md5sums` and checks every packaged regular
file after extraction, alongside the separate SHA-256 asset. It neither prunes
nor modifies the source checkout. A standard Node.js
distribution root can be selected with `--node-root`.

## Developer Platform registration

Use these fields when creating the TOS application:

| Field | Value |
| --- | --- |
| ID | `com.hermeswebui.studio` |
| Type | Deb |
| Architecture | x86_64 |
| Repository | The public repository whose Release contains the TOS asset |

Use the existing registered application ID `com.hermeswebui.studio` exactly.
The package directory, language filename, SVG filename and upload script all
use that same dotted ID. The earlier hyphenated test ID is no longer the target.
The Debian package and systemd service remain named `ekko-studio-tos`.
Select the **TOS** Deb asset, not `Ekko.Studio-*-amd64.deb`.

The metadata is inside `data.tar` at:

```text
usr/local/com.hermeswebui.studio/
  config.ini
  com.hermeswebui.studio.lang
  images/icons/com.hermeswebui.studio.svg
  bin/ekko-studio
  init.d/ekko-studio-tos.service
  nginx/com.hermeswebui.studio.conf
  webui.bz2
  depends/bin/node
  depends/lib/node_modules/npm/
  depends/webui/
```

`config.ini` is JSON. All 14 TOS language sections have nonempty name,
publisher and description values; English fallback is used where untranslated.
The vector icon is derived from the existing desktop icon, with scanline
rectangles merged into exact contours (identical rendered pixels). Packaging
checks valid XML, a maximum of 50 KB / 50 elements, and excludes unsafe SVG
elements, event handlers, URL schemes and XML directives before uploading.

## Runtime and data

The App Center creates the non-root user/group `ekko-studio-tos`, as declared
by `config.ini`; installation scripts do not create system users. The unit
is registered with systemd from the application directory. The Web UI listens
on `0.0.0.0:8648` and opens in a new browser tab at `http://${ip}:8648`.
It uses Studio's own login; configure your login and model provider before use.
Port 8648 must be free. It is separate from TOS's system ports.

The Debian package declares the host libraries, Git, Python 3.10+ and venv
dependencies. The TOS repository must be able to resolve these dependencies;
this is part of device acceptance. No Hermes Python runtime, model credentials
or coding-agent CLI is preinstalled by this target. Ekko Agent is bundled in
the Web UI. Other agents need their normal setup under the dedicated account.
The system's Node.js 18 is not used.
Managed Studio MCP integrations explicitly use the bundled MCP entry script and
private Node runtime, independent of the service working directory.
Update this installation through the TOS App Center; the unit disables npm
update notifications so the managed installation is not replaced by a separate
per-user npm installation.

The service uses `NoNewPrivileges`, `ProtectSystem=strict` and `ProtectHome`.
Writable workspace selection is restricted by the service account and sandbox;
host `/home` and arbitrary NAS shares are not exposed automatically.

### Runtime file manifest

Paths are application-visible paths under `/usr/local/com.hermeswebui.studio/`.
TOS maps them onto the installation volume. No `/Volume*` pattern is used in
machine-read configuration.

| Path | Purpose / format | Created when / creator | Growth / rotation | Package-script lifecycle |
| --- | --- | --- | --- | --- |
| `depends/`, `bin/`, `init.d/`, `nginx/`, metadata, `webui.bz2` | Read-only installed files | Install / dpkg | Fixed package size | Replaced by upgrades |
| `webui/` | Static frontend | Configure / postinst | Fixed package size | Regenerated on upgrade, deleted on removal |
| `data/studio/` | Studio DB, tokens, uploads, managed runtimes, agent state | First use / Studio | User-managed history, uploads and installed tools; no package-level quota | Preserved |
| `data/home/` | Dedicated HOME, Hermes config and per-user tools | Configure / postinst; later tools | User-managed | Preserved |
| `data/workspaces/` | Default workspace and user files | Configure / postinst; later Agent/user | User-managed | Preserved |
| `data/npm/` | Runtime-installed coding-agent CLIs | Configure / postinst; later npm | User-managed installed tools | Preserved |
| `data/cache/` | XDG cache | Configure / postinst; later tools | Tool-specific, no package-level quota | Preserved |
| `data/tmp/` | Runtime temporary files | Configure / postinst; later tools | Tool-specific; global bounds/cleanup need TNAS acceptance | Preserved |
| `logs/` | Reserved file-log directory; unit stdout/stderr uses journald | Configure / postinst | journald rotation is system-managed | Preserved |
| systemd enablement links | Unit registration | Configure / systemctl | Fixed | Removed on uninstall |

The removal and purge scripts deliberately retain data and the platform-managed user.
TOS App Center handling of the installation volume must still be checked on a
device. This initial test target uses a private application workspace; a stable
submission must verify the guide's shared-folder mapping for user-visible business
data and temporary-file bounds/cleanup. The guide leaves shared-folder path
resolution pending platform confirmation, so this target does not guess a volume
path or advertise SMB/NFS access. Back up/export test data before uninstalling.
After uninstall, an administrator may explicitly delete the documented data
directories if no longer needed. Do not remove an installation volume wholesale.

## Required TNAS acceptance

Static/package checks and an Ubuntu startup smoke test do not establish TOS
compatibility. On an authorized TOS 7 x86_64 device:

1. Verify SHA-256 and install through the App Center; check dependency resolution.
2. Check metadata, icon and language display, the dedicated account and systemd
   unit. Confirm it runs as non-root.
3. Open the external Web UI, configure login, chat with Ekko, create a file in
   the default workspace, and exercise Socket.IO streaming.
4. Stop/start/restart from the App Center; verify the process exits and returns.
5. Upgrade with saved conversations, credentials and a workspace file; verify
   they remain. Remove and reinstall; verify the documented retention policy.
6. Check for orphaned services/processes and test on a second data volume.
7. Resolve the user-data shared-folder contract and temporary-file quotas/cleanup
   before changing `beta` or submitting this as a stable App Center application.

Reference: TerraMaster `tos-app-pkg-tools`, TOS 7 guide chapters 4, 8, 13 and 15,
reviewed at commit `9dc7e43da051b3e4a8e704764ff57e72fc7309fc`.
