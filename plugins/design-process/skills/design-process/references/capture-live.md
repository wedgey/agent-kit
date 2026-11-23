# Capturing the running app

Every runbook that starts from an existing product shoots its current screens. Drive a real
browser against the local dev server and put the app into each state by hand. Do not write a
test spec to do it: a capture spec is throwaway code in the repo's test folder, it runs the whole
test harness for a few screenshots, and when one step breaks you cannot see why or change course.

## Pick the browser

Use the browser the repo or the owner names. Otherwise use any browser-automation tool the session
has, such as `agent-browser`, a browser built into the host app, or a Playwright MCP; check the skill
and tool lists and `command -v`. If there is none, use the [fallback](#fallback-a-throwaway-spec).

## Get the app into the state

1. **Server.** Reuse the dev server already running for this worktree. Otherwise start it the way
   the repo documents (its run or verify skill, its README). Note the port in `<work>/capture.md`.
2. **Sign in.** Read how the repo's e2e fixtures sign a user in (a test user, a dev login, a
   cookie or storage entry), then do the same in the browser.
3. **Data.** Seed one realistic set from the canon: the repo's seed command, or a small script in
   the working folder that calls the same API or REST endpoint the fixtures call. Never put it in the
   repo. Stamp every row so you can delete them afterwards.
4. **States seeding cannot reach** (an error, a slow load, an empty list, an AI reply): mock the
   request in the browser, e.g. `agent-browser network route <url> --body <json>`.

## Shoot

- One browser session named after the worktree, viewport 1440x900.
- Per screen and state: navigate, snapshot to find the controls, act, then screenshot to
  `<work>/live/<screen>-<state>.png`. If one fails, note it and go on to the next.
- Read every PNG back once. A blank page, a spinner or an "Untitled" object is a failed shot.
- Write the recipe in `<work>/capture.md`: URL, seed script, the clicks for each state. Re-shoots
  with the canon data, and each ticket's match proof, reuse it.
- Close the session and delete the seeded rows when the round's shots are final.

## Fallback: a throwaway spec

Only when no browser tool exists, or a state is reachable only through test-only hooks. Name it so
it sorts last (`zz-<work>-capture.spec.ts`), head it `THROWAWAY design capture. NEVER COMMIT.`, wrap
each screen in its own step that logs and continues on failure, and delete the file once the shots
are read. Never commit it.
