# Noor merchant — API tests

Backend API tests for the **Noor merchant panel** on the test environment, written with
[Playwright Test](https://playwright.dev/docs/api-testing) in TypeScript. Everything lives in
[`noor-api-tests/`](noor-api-tests/).

> Browser (E2E) tests are on the [`e2e-testing`](../../tree/e2e-testing) branch.

## What is covered

| Suite (Playwright project) | Folder | Covers |
|---|---|---|
| `delivery` | `tests/delivery` | branch addresses, order search & status tabs, pricing, reports (Excel content), support chats |
| `eats` | `tests/eats` | categories, products, modifiers, branches (restaurants), promotions, orders, moderation (merchant side) |
| `common` | `tests/common` | login/logout, employees & roles, merchant profile (name/logo), change password |
| `admin` | `tests/admin` | cpanel moderation: approve/reject, overlaps & races, parent/child dependencies, admin actions, data correctness |

Known backend bugs stay in the suite as `test.fail(true, 'Known: …')`: they show ✘ in the list but don't fail the run,
and turn red once fixed — then remove the marker.

## Run locally

```bash
cd noor-api-tests
npm install
cp .env.example .env        # fill in phones and passwords (never commit .env)

npm test                    # all API suites
npm run test:eats           # one suite: test:delivery | test:eats | test:common | test:admin
npx playwright test tests/eats/products.spec.ts   # one file
npm run report              # open the HTML report
```

`npm run test:password` runs the change-password tests on their own (they log every session out).

## Credentials (`.env` locally, repository secrets in CI)

| Variable | Needed for |
|---|---|
| `MERCHANT_PHONE`, `MERCHANT_PASSWORD` | everything (merchant admin) |
| `ADMIN_PHONE`, `ADMIN_PASSWORD` | `admin` suite — cpanel moderator |
| `CASHIER_*`, `MANAGER_*` | role tests (skipped when unset) |
| `EMPLOYEE_TEST_PHONE`, `EMPLOYEE_TEST_PHONE_2` | adding employees — **sends a real SMS**, use numbers you control (skipped when unset) |

## CI

- **GitHub Actions:** Actions → *Noor API tests* → **Run workflow** (pick a suite). Add the variables above as repository secrets.
- **GitLab CI:** the `noor-api-tests` job is manual; set the variables under Settings → CI/CD → Variables.

Both are manual on purpose — see the safety notes.

## Safety notes (shared test environment)

- Test data is named `QA-autotest…` and always cleaned up, even when a test fails.
- Each run **opens one support chat** (seen by the support team) and **creates one report** (reports cannot be deleted).
- The admin suite only approves/rejects change requests it created itself.
- Promotions use dates ~2 months ahead, so today's prices never change.
