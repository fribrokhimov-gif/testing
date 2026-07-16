# Playwright + CI/CD practice repo

A minimal, self-contained project for practicing e2e test automation with CI.

- `public/index.html` — a tiny todo-list app (vanilla JS, no build step, no external network calls)
- `tests/add-todo.spec.js` — adds an item, checks the list and count
- `tests/delete-todo.spec.js` — adds two items, deletes one, checks the list and count
- `.github/workflows/playwright.yml` — GitHub Actions pipeline
- `.gitlab-ci.yml` — GitLab CI pipeline (uses Microsoft's prebuilt Playwright image, so no browser-install step needed)

## Run locally

```bash
npm install
npx playwright install --with-deps chromium   # one-time browser download
npx playwright test                           # headless run
npx playwright test --headed                  # watch it click through the browser
npx playwright show-report                    # open the HTML report
```

## Exercise the CI pipeline

**GitHub:**
1. Create a new empty repo on GitHub.
2. From this folder: `git init && git add -A && git commit -m "init"`
3. `git remote add origin <your-repo-url> && git branch -M main && git push -u origin main`
4. Open the "Actions" tab on the repo — the workflow runs automatically on push.

**GitLab:**
1. Create a new empty project on GitLab.
2. Same `git init`/commit/push flow, pointed at the GitLab remote.
3. Open "CI/CD > Pipelines" — it runs automatically since `.gitlab-ci.yml` is at the repo root.

You only need one of the two CI files depending on where you push — feel free to delete the other, or keep both (GitHub will ignore `.gitlab-ci.yml` and vice versa).

## Things worth practicing once it's running

- Break a test on purpose (e.g. change `'1'` to `'2'` in an assertion) and watch CI go red.
- Open the uploaded `playwright-report` artifact from a failed run and read the trace.
- Add a third test and watch the matrix pick it up automatically.
- Try adding a second browser project (`firefox`, `webkit`) in `playwright.config.js`.
- Make the pipeline required to pass before merging a PR (GitHub branch protection / GitLab merge request rules).
