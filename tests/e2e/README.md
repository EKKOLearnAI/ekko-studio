# Browser tests for new features

Every new browser journey must include focused `*.spec.ts` tests here.
Use API and WebSocket mocks and run the relevant feature file before the PR:

```bash
npm run test:e2e -- tests/e2e/<feature>.spec.ts
```

Install Chromium once with `npx playwright install chromium`, or use an installed
browser through `PLAYWRIGHT_CHANNEL=chrome`. See `../README.md` for test policy.

OMP is an independent plugin and is not installed as a Studio test dependency.
`studio-omp-settings.spec.ts` is optional: set
`STUDIO_TEST_OMP_DIR=/absolute/path/to/ekko-studio-plugin-omp` to check its client through the host bridge.
It is skipped when no external checkout is supplied and does not install or activate a plugin.
The optional server integration test `tests/server/studio-omp-plugin.test.ts` uses the same variable
and installs that checkout only into temporary test state.

The independent E2E workflow (`.github/workflows/playwright.yml`) installs Chromium
when test files are present and runs the current E2E suite automatically. It can
also be run manually. Available HTML reports, screenshots and traces are uploaded
as the `e2e-results` artifact, including when tests fail. Empty suites are allowed
during the reset; added tests must pass, and new browser journeys still require tests.
