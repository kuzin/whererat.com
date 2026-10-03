# End-to-end tests (Playwright)

Real browser, production build, throwaway Postgres. Nothing here can touch real
data: the suite refuses any database that isn't on localhost **and** named `*e2e*`
(`e2e/support/safety.ts`), forces every DB variable on the server under test to it,
blanks e-mail/blob/OMDb/TMDB credentials, and sets `WHERERAT_OFFLINE=1` so no
third-party service is called.

## Run it

```bash
yarn e2e:db:start     # throwaway Postgres on :54330 (Homebrew/system Postgres, else Docker)
yarn e2e              # build the app, then run the suite
yarn e2e --no-build   # reuse the existing build
yarn e2e --no-build e2e/tests/auth.spec.ts -g "lockout"   # a subset
yarn playwright show-report                               # last HTML report
yarn e2e:db:stop
```

First time on a machine: `yarn playwright install chromium`.

CI runs the same thing against a Postgres service container (job “End-to-end (Playwright)”).

## How it works

- `e2e/global-setup.ts` applies `db/schema.sql` to the e2e database.
- `e2e/fixtures.ts` — every test starts from a freshly seeded database (two movies, three
  accounts) and a unique client IP, so rate limits never leak between tests. Use the
  `login` fixture to sign in as the owner.
- `e2e/support/db.ts` — direct DB access for seeding and asserting (`query`, `seedSubmission`, …).
- Tests run serially (one shared database).

## Conventions

- Prefer role/label selectors; assert on the database as well as the UI for anything that writes.
- A known bug is marked `test.fail(true, "reason")` (shows as ✘ but counts as passing) so it stays
  visible and flips red when fixed — remove the marker then.
