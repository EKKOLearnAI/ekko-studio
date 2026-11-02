# Browser tests for new features

Add focused `*.spec.ts` tests here when new browser behavior needs coverage.
Use API and WebSocket mocks and run only the relevant feature file:

```bash
npm run test:e2e -- tests/e2e/<feature>.spec.ts
```

Install Chromium once with `npx playwright install chromium`, or use an installed
browser through `PLAYWRIGHT_CHANNEL=chrome`. See `../README.md` for test policy.
