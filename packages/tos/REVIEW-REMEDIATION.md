# TOS review remediation — 0.7.36 findings (2026-10-19)

This document records implementation scope, not a claim of App Center approval.

| Finding | Change / remaining evidence |
| --- | --- |
| Uninstall failure | Tolerate unloaded/missing systemd units during removal; register the unit through a standard systemd search-path symlink. Test stop exit code 5. Real TNAS online install/remove/reinstall remains required. |
| F11 | Upgrades retain data; removal/purge delete managed data/logs and the application-owned account. External workspaces and backups are not deleted. Export before uninstall. |
| V11 | Generate and verify beta=false, reject prerelease versions, remove test-build labels. This does not establish release quality without device acceptance. |
| S4 | Disable LAN discovery and bind HTTP to loopback. The portal proxies the application namespace, with prefix-aware assets/API/downloads/Socket.IO/terminal support. Real TNAS nginx/access-control acceptance remains required; S4 is not certified closed. |
| C3/C4/C5/C8 | Bundle PRIVACY.md and point package help to the repository policy. After merge verify the public URL without authentication. Privacy settings now links the public policy. An operator-approved private privacy contact remains a follow-up. Verify all provider/agent endpoints in the actual submitted payload, including legacy apikey.fan presets; regions must not be guessed. |
| V6 | Bundle BINARY-INVENTORY.json with per-file SHA-256 and nearest npm package metadata. Metadata is not proof of provenance. Review upstream source/license/build evidence and complete unknown entries; submit for separate binary review. |
| T1 | Partially addressed by compatible dependency updates and Vue/PDF.js upgrades. Production npm audit against the official registry reports 0 HIGH / 0 CRITICAL after updates (2 LOW remain). Browser-bundled dependencies and native binaries require separate checks. NOT closed. Obtain detailed CVE/GHSA IDs, detected paths/versions and fixed versions. Section 2 of the supplied PDF says scanning was unavailable, while T1 references 19 HIGH findings. Scan the final Deb, private Node/npm dependencies and native libraries, then attach a finding-by-finding remediation report. |

## Retained binaries and purpose

The private Node.js runtime runs the headless server and managed MCP entrypoint;
its source and releases are at https://nodejs.org/ and https://github.com/nodejs/node.
The bundled npm/npx distribution supports administrator-selected agent tooling.
node-pty supplies terminal sessions (https://github.com/microsoft/node-pty).
sharp/libvips process images (https://github.com/lovell/sharp,
https://github.com/libvips/libvips). sherpa-onnx supplies local speech processing
(https://github.com/k2-fsa/sherpa-onnx). agent-browser supplies browser automation
(https://github.com/vercel-labs/agent-browser).

The generated inventory enumerates the actual payload, not a fixed expected count.
Package version/license/repository metadata can be absent or inherited from a
wrapper; inspect every entry. Record the Node distribution checksum, npm registry
integrities, actual native source revisions/build recipes and license notices in
the submission materials. Do not describe prebuilt binaries as built from source.

## Release acceptance checklist

- [ ] Back up user data and communicate destructive uninstall behavior.
- [ ] Pass focused packaging/platform/lifecycle tests and build the production Deb.
- [ ] Install online in TNAS App Center, configure/use, upgrade with data retained.
- [ ] Remove with unit loaded and unloaded; confirm no managed data, account,
      registration or running service remains; reinstall successfully.
- [ ] Verify LAN discovery UDP listeners are absent on the real device.
- [ ] Validate S4 portal nginx integration, platform access control and Socket.IO on TNAS.
- [ ] Verify public privacy policy, in-app entry, recipient list and contact channel.
- [ ] Complete binary provenance/security review and final artifact vulnerability scan.
- [ ] Bind receipts to package version, source commit and final SHA-256.
- [ ] Only then withdraw the held submission with explicit authorization and upload
      a new version, remark: “Rectified per review comments”.
