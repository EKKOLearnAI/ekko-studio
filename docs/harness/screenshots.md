# Studio screenshots

`npm run screenshot -- --help` runs the dedicated Playwright capture script.
It writes PNG files and a `manifest.json` containing routes and absolute file
paths. By default it captures chat, Person, workflows and models at 1440×1000
in Chinese. It waits for the route's content, Studio loading overlays and fonts
before capturing; it does not wait for network idle on streaming connections.

## Current source with mock data

```bash
npm run screenshot -- --mock
npm run screenshot -- --mock --pages all --viewport 390x844
npm run screenshot -- --mock --route '/hermes/models?tab=api' --locale en
```

Mock mode starts and stops its own Vite server on an available local port. It
uses the existing E2E API/socket fixtures plus an empty Person setup fixture.
Its frontend has backend proxying disabled, so missing fixtures cannot access
the running user's backend. It never reads or saves real login state. These
screenshots show the current frontend with **simulated data**; they validate
appearance rather than live authentication or backend behavior.

## A running Studio with real login

Start Studio separately, for example with `npm run dev` (frontend on port 8649).
Provide credentials through environment variables on the first run:

```bash
export STUDIO_SCREENSHOT_USERNAME='your-user'
export STUDIO_SCREENSHOT_PASSWORD='your-password'
npm run screenshot -- --base-url http://127.0.0.1:8649 --pages chat,person
unset STUDIO_SCREENSHOT_USERNAME STUDIO_SCREENSHOT_PASSWORD
```

Alternatively set `STUDIO_SCREENSHOT_TOKEN` to a valid account token. Credentials
are checked against `/api/auth/me` before a browser opens. A failed or expired
login exits with a nonzero status rather than treating a login page as a
successful capture. Explicit environment credentials take precedence over saved
state. The script never guesses credentials or extracts tokens from Studio data.

Successful live captures save Playwright login state to
`.playwright/studio-auth.json`, excluded from Git and created with owner-only
permissions. Subsequent runs reuse it automatically. Use `--auth-state` to
choose another location; saved tokens are only reused for their original web
origin. Treat this file as a credential and keep it out of shared screenshot
folders. Delete it to forget the saved login. An expired token requires fresh
credentials. The account's existing appearance is retained; the script does
not write theme settings to the server.

## Select a page or component

```bash
npm run screenshot -- --mock --pages chat,workflow --out /tmp/studio-shots
npm run screenshot -- --mock --route '/hermes/models?tab=api' --wait-for '[data-testid="model-api-panel"]'
npm run screenshot -- --mock --pages chat --selector '.chat-view'
npm run screenshot -- --mock --pages usage --full-page --viewport 1440x1000
```

Named pages are `chat`, `person`, `workflow`, `models`, `history`, `usage` and
`settings`; `--pages all` captures all seven. Repeat `--route` for additional
hash-router paths. A custom route replaces the default pages unless `--pages`
is also supplied. Use the final route for pages that redirect, and `--wait-for`
for a specific custom page's content. `--selector` captures a single element.
`--full-page` captures document overflow; independently scrolling app panels
keep their current scroll position. Narrow `--viewport` values test responsive
web layout, not a native mobile app.

Screenshots default to a fresh directory under `test-results/studio-screenshots/`.
`--locale zh|en`, `--profile`, `--headed` and `--timeout` are also available.
The manifest labels captures as `mock` or `live` and never includes credentials.
A failed batch exits nonzero; any earlier captures remain listed in its manifest.
When possible a `.failed.png` diagnostic is saved separately from successful
captures. Unhandled mock API calls fail the capture and identify the missing
fixture, so an API error page is not silently delivered as a successful preview.

Install dependencies normally. If Chromium is missing, run
`npx playwright install chromium`, or use an installed browser with
`--channel chrome` / `PLAYWRIGHT_CHANNEL=chrome`.
