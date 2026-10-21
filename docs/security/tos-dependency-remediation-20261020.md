# TOS dependency remediation checkpoint — 2026-10-20

This is an npm advisory checkpoint, **not** a complete final-artifact/native CVE
scan or a declaration that the T1 review finding is closed.

## Locked version changes

| Component | Before | After |
| --- | --- | --- |
| axios | 1.16.1 | 1.20.0 |
| adm-zip | 0.6.0 | 0.6.1 |
| sharp | 0.35.3 | 0.35.5 |
| @modelcontextprotocol/client | 2.0.0 | 2.3.1 |
| @vue/server-renderer | 3.5.35 | 3.5.44 |
| engine.io | 6.6.9 | 6.6.11 |
| form-data | 4.0.5 | 4.0.6 |
| nanoid | 3.3.17 | 3.3.20 |
| source-map-js | 1.2.1 | 1.2.2 |
| vue | 3.5.35 | 3.5.44 |
| pdfjs-dist | 5.7.284 | 6.4.299 |
| vite | 8.0.14 | 8.3.4 |

## Reproduction and results

Use the official registry (the configured mirror returns 404 for audit):

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org --json
npm audit --include=dev --registry=https://registry.npmjs.org --json
```

After updates, the production-only advisory result is **0 HIGH, 0 CRITICAL,
2 LOW**. The low findings are KaTeX and its markdown wrapper; no compatible
fix is reported. Before updates the same check reported 10 HIGH / 0 CRITICAL.

Important: production-only omits some browser-bundled packages classified as
devDependencies. Vue and PDF.js were therefore explicitly upgraded, along with
Vite. PDF.js 6 document teardown now uses the loading task API. The full graph
still reports **4 HIGH and 2 CRITICAL** (plus lower severities), including
dev/test-tool chains such as Vitest/tinypool and nodemon/ts-node-dev. These
must not be presented as a clean full-repository audit. Major tool migrations
and their validation are separate remaining work.

Also scan private Node/npm, native libraries and the actual final Deb using the
reviewer's scanner/advisory database. Obtain the original CVE/GHSA/path details
and map them to final versions. npm package metadata is not native provenance.

## Release gates still open

- S4: loopback-only HTTP and prefix proxy support are implemented. Actual TOS
  platform access control, uploads and WebSocket acceptance remain required.
- V6: binary source/build/license provenance and separate security review.
- Verify the policy's public URL after merge and approve operator contact/regions.
- Real TNAS install/upgrade/uninstall acceptance: no authorized test TNAS is
  available. The user explicitly chose code/container verification first.
- Do not withdraw the held submission or submit while these gates remain open.
