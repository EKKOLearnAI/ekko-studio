# Hermes CLI and managed Runtime

Hermes can be available as a user-installed CLI or as a Studio-managed Runtime. A visible user CLI intentionally takes precedence over a managed Runtime, so always report the selected source and path.

## Detect and validate an existing Hermes CLI

Studio resolves `HERMES_BIN` when it names a path, then searches every `hermes` visible to its process. It calls each candidate with `--version` and marks paths inside installed Runtime directories as `managed-runtime`; all others are `user-cli`.

Validate outside Studio with:

```bash
hermes --version
```

On macOS/Linux inspect all candidates with `which -a hermes`; on Windows use `where hermes`. Then refresh the Agents page. If the terminal and Studio disagree, restart Studio and compare the PATH visible to the Studio process before installing another copy.

An unmanaged package installation is supported when a managed Desktop Runtime is not desired:

```bash
python -m pip install hermes-agent
hermes --version
```

Remember that this user CLI will win over a downloaded Runtime during Studio selection.

## Download and activate a managed Runtime

Use **Agents → Hermes → Install now / Manage Runtime**. Choose a version and either Cloudflare or GitHub as the download source.

For version `<version>` and platform `<platform>`, Version Management resolves:

- release tag: `hermes-<version>-runtime`
- manifest: `hermes-runtime-<platform>.json`
- archive: the manifest's `asset.name`

The default platform key is `mac-<arch>`, `win-<arch>`, or `linux-<arch>`. The default storage root is:

```text
<HERMES_WEB_UI_HOME>/desktop-runtime
```

The installed Runtime is placed at:

```text
<runtime-root>/hermes/<version>/<platform>
```

The installer performs these stages:

1. Resolve the remote manifest.
2. Download to a temporary `.download` file.
3. Verify SHA-256 when the manifest supplies `asset.sha256`.
4. Extract into a temporary directory.
5. Validate the platform and required files.
6. Replace the target directory by rename only after validation succeeds.
7. Activate the installed version and refresh Runtime status.

Required Runtime contents include Python, the Hermes executable, Node, and `runtime-manifest.json`; Windows also requires bundled Git. Schema 2 and newer additionally require an updateable Hermes Git checkout (`python/.git/HEAD`, `python/pyproject.toml`) and valid repository, ref, commit, and `installMethod: "git"` metadata.

After download, verify all of the following:

- the download job reached `completed`, not merely `download`;
- Version Management marks the same platform/version installed and active;
- the Runtime directory passes validation and contains `runtime-manifest.json`;
- the Agents page reports Hermes installed after refresh;
- after restart, `ekko-studio cli --version` reports a usable version.

## Upgrade distinctions

There are three separate upgrades:

- **Desktop application:** use Desktop **Check for Updates**.
- **Managed Runtime package:** download a newer Runtime version in Version Management, let it validate and activate, then restart. Previous inactive versions remain available until explicitly deleted.
- **Hermes Agent source inside Runtime 0.19.1 or newer:** fully exit Ekko Studio, then run `ekko-studio cli update`. This does not upgrade Desktop or Web UI.

Do not run `ekko-studio cli update` while Studio still owns Runtime processes. Reopen Studio afterward and verify the Hermes version and Runtime path.

An active Runtime cannot be deleted. Activate and restart into another valid version first, then delete the inactive version through Version Management.

## Installer state files

These files are written by Studio and should normally be inspected, not hand-authored.

Each Runtime contains `runtime-manifest.json`, which records at least its schema, platform, Hermes Agent version, asset identity/checksum, and—for updateable source Runtimes—Hermes Git source metadata.

Desktop Runtime selection is stored at:

```text
<HERMES_WEB_UI_HOME>/desktop-runtime/active-version.json
```

It uses schema 1 and may contain:

- `desktopAppVersion`
- `hermesRuntimeVersion`
- `runtimeDirectory`
- `runtimeRootDirectory`
- `pendingRuntimeRootDirectory`
- `runtimeMigrationError`
- `runtimeActivationError`
- `webUiVersion`
- `platform`
- `updatedAt`

Activation writes the selected Runtime directory/version/platform and clears the activation error. A missing, incomplete, or wrong-platform active Runtime causes Desktop to record `runtimeActivationError` and fall back to another valid installed Runtime when possible.

## Migrate Runtime storage

Use Version Management's **Choose directory** action. The destination must already exist, be writable, not be inside the current Runtime storage, and not be the active Runtime directory or one of its children. Migration is unavailable while `HERMES_DESKTOP_RUNTIME_DIR` forces an override.

Scheduling writes `pendingRuntimeRootDirectory` to `active-version.json`; it does not move files immediately. Restart Ekko Studio to apply the migration before local services start.

On restart Desktop:

1. validates the current Runtime;
2. stages a copy at the destination;
3. repairs moved Hermes editable references and launchers;
4. validates the staged Runtime again;
5. copies valid downloaded Web UI versions that are missing at the destination;
6. atomically places the Runtime at `<new-root>/hermes/<version>/<platform>`;
7. writes `runtimeRootDirectory` and `runtimeDirectory`, then removes `pendingRuntimeRootDirectory`;
8. retains the previous storage directory for recovery.

On failure it removes staging directories, records `runtimeMigrationError`, clears the pending request, and continues using the previous storage. Do not manually rewrite paths to force success; correct the destination or Runtime integrity problem and schedule the migration again.
