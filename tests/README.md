# Focused feature tests

The legacy test suite and its fixtures were removed. Add tests alongside new
features, limited to the behavior introduced by that change. Do not restore the
old suite or require full coverage/browser sweeps for routine changes.

- Put Vitest tests in `tests/<area>/*.test.ts` and run
  `npm test -- tests/<area>/<feature>.test.ts`.
- Put browser tests in `tests/e2e/*.spec.ts` only when a new user journey needs
  browser coverage, and run `npm run test:e2e -- tests/e2e/<feature>.spec.ts`.
- Keep fixtures and setup local to the feature. Mock external APIs and sockets;
  use isolated temporary state instead of live application data.
- Keep assertions about behavior. Avoid source-string assertions, duplicated
  matrices, real provider calls and unrelated whole-application setup.

`npm test`, `npm run test:coverage` and `npm run test:e2e` explicitly allow an
empty suite. Once matching tests are added, assertion failures still fail the
command. Vitest and Playwright dependencies remain available for new work.

CI currently runs the repository harness and production build, plus the lockfile
check. Test automation can be added with future features when needed; keep it
scoped to those features instead of restoring blanket coverage or browser shards.
