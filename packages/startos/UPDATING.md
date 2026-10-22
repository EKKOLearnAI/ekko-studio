# Updating Ekko Studio

Upstream is `EKKOLearnAI/ekko-studio`; the documented Docker distribution is
`ekkoye8888/hermes-web-ui`. Read the upstream GitHub Releases and Docker Hub
manifest list before choosing a version.

1. Verify the release tag and both linux/amd64 and linux/arm64 manifests.
2. Change the upstream image tag and immutable index digest in `Dockerfile`;
   separately review the pinned Node base image. Keep `manifest` on `dockerBuild`.
3. Update `startos/versions/current.ts` using `<upstream-version>:<package-revision>`.
   Add localized release notes. Do not copy an old migration into a new version.
4. Recheck the upstream entrypoint, data paths, reset-default-login CLI, login and
   password-change API. Credential setup deliberately uses those upstream APIs.
5. Refresh `LICENSE` and `icon.svg` from upstream if they changed.
6. Run the package checks/builds and test initial password setup, old-password
   rejection, rotation, persistence, interfaces, and backup/restore on StartOS.
7. Review limitations in README and instructions. Uploading a build or creating
   a GitHub Release does not publish it to a Start9 registry.

The Studio payload pin is upstream `v0.7.36`, source commit
`1242ac63556491c92ba6dd49d89fd19c91a6bdd5`, image index digest
`sha256:06a3c3fc30c850f3f68c9c144afedee9c575ece848e55857e97915fd358c91f4`.
The icon is upstream `packages/tos/icon.svg`; the license is upstream `LICENSE`.

Do not restore `/opt/hermes`, a system-wide `hermes` executable, or a hardcoded
`HERMES_BIN` in this package. Verify fresh startup without Hermes, runtime
download/install/selection, and runtime/data preservation across image recreation.
