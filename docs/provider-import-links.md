# Provider import links (version 1)

An installed Ekko Studio desktop application accepts:

```text
ekko-studio://import/provider?data=<base64url-encoded-UTF8-JSON>
```

Web and Docker deployments use the same payload in the **hash route**, relative
to their own Studio address:

```text
https://studio.example/#/hermes/models?importProvider=<base64url-encoded-UTF8-JSON>
```

The desktop handler always opens its configured Studio server. A link cannot
select another server, run a command, choose a Profile, or overwrite an existing
provider. This is an Ekko Studio protocol; it does not register or take ownership
of `ccswitch://` or the mobile app's `hermes-studio://` session-sharing scheme.

## Payload

```json
{
  "version": 1,
  "name": "Example Relay",
  "baseUrl": "https://relay.example/v1",
  "model": "example-model",
  "apiMode": "codex_responses"
}
```

`apiMode` is optional and defaults to `chat_completions`; allowed values are
`chat_completions`, `codex_responses`, `anthropic_messages`, and `auto`.
`auto` preselects **Auto (match model)** in the confirmation dialog and saves the
provider without a fixed API mode, so each model uses its matching protocol. Use it
for relays that serve several protocol families (for example Claude and Codex
models) behind one endpoint. An optional
`apiKey` can prefill the password field. Prefer omitting it from public links:
base64url is **not encryption**, and whoever receives a link can decode it.
The user can enter the key in the confirmation dialog.

Names are 1–80 characters, begin with a letter or number, and contain only letters,
numbers, spaces, dots, underscores, and hyphens. URLs must use HTTP(S), with no
embedded credentials, query, or fragment. Model IDs are limited to 256 characters,
API keys to 8192, and the encoded payload to 32768. Unknown fields, control
characters and unsupported versions are rejected.

Example generator (Node.js):

```js
const payload = { version: 1, name: 'Example Relay', baseUrl: 'https://relay.example/v1',
  model: 'example-model', apiMode: 'codex_responses' }
const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
console.log(`ekko-studio://import/provider?data=${data}`)
console.log(`https://studio.example/#/hermes/models?importProvider=${data}`)
```

## Confirmation and storage

The client removes the import parameter from browser history before authentication
redirects. The decoded configuration stays only in memory until the user confirms
or cancels; it is not persisted in localStorage/sessionStorage. Reloading the page
discards an unconfirmed import.

After login the dialog shows the endpoint, model, API mode, masked key, and target
Profile. The user can choose an accessible Profile and change the provider name.
No model fetch or provider write is triggered by opening a link. Confirming invokes
the existing authenticated provider creation API with `create_only: true` and an
explicit Profile header; it adds a custom provider and selects its model as that
Profile's default. The server checks duplicate names in both supported config
schemas inside the config-update lock and returns HTTP 409 rather than overwriting.
Cancellation makes no changes.

Packaged desktop builds register the `ekko-studio` scheme through Electron Builder
and handle initial arguments, second-instance arguments, and macOS `open-url`
events. Development checkouts do not automatically change OS protocol ownership.
The Web import URL works independently of native protocol registration.

## Incomplete drafts

`name` and `model` may be omitted. The confirmation form derives a name from the
endpoint hostname and lets the user fetch/select models and adjust the API mode.
Fetching models requires an explicit button click; opening a link never contacts
the provider. Fetching does not update the persistent catalog. Saving still
requires a model, key, name and explicit target Profile; duplicate protection
remains enabled. Existing complete version-1 links remain supported.
