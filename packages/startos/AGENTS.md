# Package development

- Work from a StartOS packaging workspace and read its packaging guide first.
- Run `npm ci`, `npx tsc --noEmit`, then `make x86` and `make arm`; Docker image export requires Engine API 1.48 or newer.
- Treat the credential bootstrap script in `startos/utils.ts` as an integration with upstream CLI/API. Verify a real login and rotation whenever changing it or the image pin; never log generated passwords.
- In the main repository, CI is `.github/workflows/startos-package.yml`; the nested workflow is for a standalone review export. Registry publishing is manual and requires separate review; do not add automatic publication while this is a submission candidate.
