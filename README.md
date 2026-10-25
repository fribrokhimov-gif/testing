# Noor merchant — E2E tests

Browser end-to-end tests for the **Noor merchant panel** (https://tmerchant.noor.uz, test environment),
written with [Playwright Test](https://playwright.dev) in TypeScript. Everything lives in
[`noor-e2e-tests/`](noor-e2e-tests/).

> Backend API tests are on the [`api-testing`](../../tree/api-testing) branch.

## What is covered

| Area (Playwright project) | Folder | Covers |
|---|---|---|
| `e2e-delivery` | `tests/e2e/delivery` | reports list and period display, new-report dialog (export request intercepted — nothing is created) |
| `e2e-eats` | `tests/e2e/eats` | categories: create → search → edit → delete, cards vs API, known UI bugs |
| `e2e-common` | `tests/e2e/common` | login page (access, validation, phone mask, remember me, language, theme), logout, welcome page, profile (name/logo, restored after each test), employees (list, tabs, search, add/edit form validation — writes blocked), change-password form validation |

Each area logs in once through the real login page (`tests/e2e/auth.setup.ts`) and keeps its own session file in `.auth/`,
so areas can run in parallel. Known UI bugs stay in the suite as `test.fail(true, 'Known: …')`.

## Run locally

```bash
cd noor-e2e-tests
npm install
npx playwright install chromium     # one-time browser download
cp .env.example .env                # MERCHANT_PHONE / MERCHANT_PASSWORD (never commit .env)

npm run test:e2e                    # all areas
npm run test:e2e:eats               # one area: test:e2e:delivery | test:e2e:eats | test:e2e:common
npm run report                      # HTML report

# Watch one test slowly in a visible browser
SLOWMO=800 npx playwright test --project=e2e-eats --headed -g "create a category"
```

## CI

- **GitHub Actions:** Actions → *Noor E2E tests* → **Run workflow** (pick an area). Add `MERCHANT_PHONE` and `MERCHANT_PASSWORD` as repository secrets.
  The HTML report is attached to every run; screenshots and traces are attached when something fails.
- **GitLab CI:** the `noor-e2e-tests` job is manual and uses Microsoft's Playwright image (browsers preinstalled).

## Safety notes (shared test environment)

- Test data is named `QA-autotest…` and cleaned up, even when a test fails; nothing is submitted for moderation.
- The tests never submit delivery orders, chat messages, new employees, password changes or "forgot password" SMS —
  those requests are blocked or never sent.
- Profile tests restore the merchant name and logo after every test.
