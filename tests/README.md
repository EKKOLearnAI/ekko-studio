# Focused feature tests

The legacy test suite and its fixtures were removed. Every new feature must
include tests limited to the behavior introduced by that change. New browser
journeys must include focused Playwright coverage. Do not restore the old suite
or require full coverage/browser sweeps for routine changes.

- Put Vitest tests in `tests/<area>/*.test.ts` and run
  `npm test -- tests/<area>/<feature>.test.ts`.
- Put browser tests for new user journeys in `tests/e2e/*.spec.ts`, and run
  `npm run test:e2e -- tests/e2e/<feature>.spec.ts`.
- Keep fixtures and setup local to the feature. Mock external APIs and sockets;
  use isolated temporary state instead of live application data.
- Keep assertions about behavior. Avoid source-string assertions, duplicated
  matrices, real provider calls and unrelated whole-application setup.

Run the tests added for each new feature before opening a PR. `npm test`,
`npm run test:coverage` and `npm run test:e2e` explicitly allow an empty suite
during the reset; this does not exempt new features from adding tests. Once
matching tests are added, assertion failures still fail the command.

Independent Test (`.github/workflows/test.yml`) and E2E
(`.github/workflows/playwright.yml`) workflows automatically run `npm test` and
`npm run test:e2e` on pushes to `main` and pull requests targeting `main` or `base`.
Both can also be run manually. Build reports the repository harness and production
build separately. E2E installs Chromium only when browser test files exist, and
uploads available HTML reports, screenshots and traces even when tests fail.
New tests are picked up without editing the workflows, and any assertion failure
fails the corresponding Test or E2E check. Lockfile checks remain separate.
Blanket coverage, browser shards and cross-platform regression matrices are not
required.
