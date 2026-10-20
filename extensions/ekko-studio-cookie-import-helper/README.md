# Ekko Studio Cookie Import Helper

A Manifest V3 extension for importing selected cookies from **Chrome on the same
computer** into a specific Ekko Studio Desktop browser profile. Adapted from the
user-supplied `cloakbrowser-cookie-import-helper-v1.0.8.zip`; the attachment did not include a separate upstream license notice. Confirm redistribution
rights before publishing the extension outside this review.

## Install and use

1. Download the extension directory (or extract the distributed helper ZIP).
2. Open Chrome's Extensions page, enable Developer mode, choose **Load unpacked**,
   and select the directory containing `manifest.json`.
3. Start Studio Desktop. The extension automatically connects to the local Studio
   instance and targets the browser profile active when the connection prompt opens.
4. Click **扫描**, select domains (search / select all / clear / batch select), then **导入**.
5. Import runs directly into the profile active when the connection is established.
   There are no connection, review or completion dialogs in Studio. Results appear
   in the extension. Matching cookies are overwritten. Refresh the website afterward.

Chrome Web Store installation is not provided. The receiving Desktop feature must
be present in your Studio build; older versions and ordinary Web UI do not support it.

## Security and limitations

- Cookie permissions and access to all websites are required to enumerate domains.
  Scanning reads cookie metadata and values through Chrome's cookie API; only
  selected domains are transmitted. No passwords, passkeys or OS keychains are read.
- The extension sends only to `http://127.0.0.1:<port>`. The discovery listener uses loopback port 19489 while Studio is running. A temporary
  staging listener is loopback-only, validates extension origins/Host/JSON/size, uses a
  random 256-bit one-time code, and only stages cookies in memory. Automatic requests from the bundled extension are applied directly after its Import click. Do not share codes or cookie values.
- Codes are not saved in extension storage. A successful submission consumes the
  code. Cancelling, expiry or app shutdown drops pending data. The first local Studio
  instance that binds port 19489 receives automatic requests; close other instances
  if the wrong instance responds.
- Matching name/domain/path cookies are overwritten; there is no automatic rollback.
  Individual write failures are counted without returning cookie values or raw errors.
- Partitioned cookies are skipped rather than silently converted to unpartitioned
  cookies. Import is limited to 1000 cookies / 1 MiB per submission.
- Cookies do not transfer localStorage, IndexedDB, device keys or passkeys. Google
  and other sites may require re-authentication. Network/proxy settings must still work.
- Cookie persistence uses Studio's existing profile cookie store. It is sensitive
  local data, not an encrypted backup or a substitute for protecting the host account.

## v1.2.0

Compact popup with scan/import, domain search and selection controls only. Extension
icons are resized from Studio's existing `packages/client/public/logo.png`. The
manifest no longer requests storage permission. Native Studio approval replaces
manual copy/paste binding, without permitting silent cookie writes.

## v1.3.0 — no native prompts

The extension's Import click now performs the complete import without connection,
domain-review or completion dialogs in Studio. Results appear only in the extension.
The local discovery and automatic staging endpoints accept only the stable extension
ID derived from the manifest's public key. This is browser-origin isolation, not
protection against malicious local processes or an extension intentionally reusing
the public manifest key. Protect the host account and install only trusted builds.
The target is the active Studio browser profile at connection time; matching cookies
are overwritten without a second confirmation. Earlier approval instructions above
apply only to v1.1/v1.2, not v1.3.
