# Browser tests for new features

Every new browser journey must include focused `*.spec.ts` tests here.
Use API and WebSocket mocks and run the relevant feature file before the PR:

```bash
npm run test:e2e -- tests/e2e/<feature>.spec.ts
```

Install Chromium once with `npx playwright install chromium`, or use an installed
browser through `PLAYWRIGHT_CHANNEL=chrome`. See `../README.md` for test policy.

Build CI installs Chromium when test files are present and runs the current E2E
suite automatically. Empty suites are allowed during the reset; added tests must
pass, and new browser journeys still require tests.
