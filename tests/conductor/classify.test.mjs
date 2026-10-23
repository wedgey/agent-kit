import { describe, it } from "node:test";
import { each, expect } from "./expect.mjs";

import { commandHead, dupeKey, findUnqueuedHeavy, heavyQueue, queuedBodies, triage } from "../../skills/conductor/tools/hooks/classify.mjs";

const queueOf = (command) => heavyQueue(commandHead(command));

describe("triage from the text alone", () => {
  each([
    ["ls", false, {}, { pass: true }],
    ["pytest", false, {}, { host: true }],
    ["pytest", true, {}, { host: true }],
    ["node /s/queue.mjs run -- x", false, {}, { host: true }],
    ["pytest", false, { CI: "1" }, { pass: true }],
    ["pytest", false, { CONDUCTOR_HOOKS: "off" }, { pass: true }],
    ["CONDUCTOR_HOOKS=off pytest", false, {}, { pass: true }],
    ["until true; do sleep 1; done", true, {}, { pass: true }],
  ])("%s (background %s, env %j) is %j", (command, background, env, expected) => {
    expect(triage(command, background, env)).toEqual(expected);
  });

  it("denies a foreground wait loop with the bypass hint", () => {
    expect(triage("until true; do sleep 1; done", false, {}).deny).toMatch(/^Do not block the turn by sleeping or polling\..*CONDUCTOR_HOOKS=off/);
  });

  it("passes what is not a string", () => {
    expect(triage(undefined, false, {})).toEqual({ pass: true });
  });
});

describe("heavy command classifier", () => {
  each([
    ["vitest run", "tests"],
    ["npx jest", "tests"],
    ["mocha", "tests"],
    ["pytest", "tests"],
    ["pytest -v", "tests"],
    ["pytest -x tests/", "tests"],
    ["jest tests/unit", "tests"],
    ["python -m pytest -q", "tests"],
    ["go test ./...", "tests"],
    ["go test -v ./...", "tests"],
    ["cargo test", "tests"],
    ["cargo test -v", "tests"],
    ["cargo build --release", "tests"],
    ["tsc --noEmit", "tests"],
    ["next build", "tests"],
    ["./gradlew test", "tests"],
    ["mvn verify", "tests"],
    ["npm run test", "tests"],
    ["npm test", "tests"],
    ["npm exec -- vitest run", "tests"],
    ["pnpm build", "tests"],
    ["pnpm run typecheck", "tests"],
    ["pnpm ci:local", "tests"],
    ["pnpm run ci", "tests"],
    ["npm run ci:check", "tests"],
    ["yarn ci:check", "tests"],
    ["pnpm vitest run", "tests"],
    ["pnpm tsc --noEmit", "tests"],
    ["yarn test", "tests"],
    ["bun run build", "tests"],
    ["FOO=1 nice -n 5 vitest", "tests"],
    ["timeout 600 pytest", "tests"],
    ["timeout -s KILL 600 pytest", "tests"],
    ["timeout --preserve-status 10m vitest run", "tests"],
    ["uv run pytest", "tests"],
    ["poetry run pytest", "tests"],
    ["turbo run test", "tests"],
    ["turbo build", "tests"],
    ["nx run-many -t test", "tests"],
    ["nx run-many --targets=lint,build", "tests"],
    ["make test", "tests"],
    ["make -j8 build", "tests"],
    ["dotnet test", "tests"],
    ["dotnet build", "tests"],
    ["bundle exec rspec", "tests"],
    ["mix test", "tests"],
    ["swift test", "tests"],
    ["deno test", "tests"],
    ["node --test", "tests"],
    ["cargo check", "tests"],
    ["cargo clippy --all-targets", "tests"],
    ["cargo nextest run", "tests"],
    ["go build ./...", "tests"],
    ["go vet ./...", "tests"],
    ["pnpm -C apps/web test", "tests"],
    ["pnpm --dir apps/web run build", "tests"],
    ["npm --prefix x test", "tests"],
    ["npm -w web run test", "tests"],
    ["npm --workspace web test", "tests"],
    ["yarn --cwd x test", "tests"],
    ["yarn workspace web test", "tests"],
    ["pnpm -w test", "tests"],
    ["vitest run --config vitest.config.ts", "tests"],
    ["playwright test", "e2e"],
    ["npx cypress run", "e2e"],
    ["pnpm test:e2e", "e2e"],
    ["npm run e2e", "e2e"],
    ["pnpm playwright test", "e2e"],
    ["playwright test e2e/login.spec.ts", "e2e"],
    ["npx playwright test --grep login", "e2e"],
    ["cypress run --spec cypress/e2e/a.cy.ts", "e2e"],
    ["pnpm test:e2e:chromium e2e/x.spec.ts", "e2e"],
    ["pnpm test:e2e --grep login", "e2e"],
    ["npm run e2e -- e2e/x.spec.ts", "e2e"],
    ["pnpm playwright test e2e/x.spec.ts:12", "e2e"],
  ])("%s goes to %s", (command, queue) => expect(queueOf(command)).toBe(queue));

  each([
    "ls",
    "git status",
    "vitest src/a.test.ts",
    "pytest tests/test_a.py::test_x",
    "pytest -k login",
    "vitest run -t login",
    "jest --testNamePattern=login",
    "npm test -- -t login",
    "pnpm test -- --testNamePattern login",
    "go test ./pkg/a",
    "go test -run TestX ./...",
    "cargo test my_filter",
    "cargo build -p crate",
    "tsc src/a.ts",
    "gradle test --tests Foo",
    "mvn test -Dtest=Foo",
    "pnpm --filter web test",
    "pnpm --filter web test:e2e e2e/x.spec.ts",
    "playwright test --list e2e/x.spec.ts",
    "playwright test --help",
    "turbo run test --filter=web",
    "pnpm test src/a.test.ts",
    "bundle exec rspec spec/a_spec.rb:12",
    "swift test --filter Foo",
    "node --test tests/a.test.mjs",
    "make lint",
    "pnpm test:watch",
    "npm install",
    "npm ci",
    "pnpm ci",
    "bun ci",
    "pnpm lint",
    "vitest --version",
    "tsc --help",
    "pytest --help -x",
    "vitest -v",
    "jest -h",
    "pytest --collect-only",
    "jest --listTests",
    "cargo test -- --list",
    "cargo nextest run my_filter",
    "go vet ./pkg/a",
    "pytest --co -q",
    "pytest --fixtures",
    "pytest --markers",
    "jest --showConfig",
    "vitest list",
  ])("%s passes", (command) => expect(queueOf(command)).toBeNull());

  each([
    "npx vitest --watch",
    "vitest watch",
    "vitest dev",
    "vitest --ui",
    "jest --watchAll",
    "jest -w",
    "tsc -w",
    "tsc --watch --noEmit",
    "pnpm test --watch",
    "npm test -- --watch",
    "pnpm test:ui",
    "pnpm test:e2e:ui",
    "pnpm run test:e2e:watch",
    "npm run e2e:open",
    "playwright test --ui e2e/x.spec.ts",
    "pnpm test:e2e:ui e2e/x.spec.ts",
    "cypress open --spec cypress/e2e/a.cy.ts",
    "yarn e2e:headed",
    "pnpm build:dev",
    "pnpm ci:watch",
    "turbo run test:watch",
  ])("never queues the watch mode %s", (command) => expect(queueOf(command)).toBeNull());
});

describe("wrappers and shell syntax around a heavy command", () => {
  each([
    "(pnpm test)",
    "{ pnpm test; }",
    "if true; then pnpm test; fi",
    "for f in a; do pnpm test; done",
    "while false; do :; done; until pnpm test; do :; done",
    "env -u DATABASE_URL pnpm test",
    "env -i PATH=/bin pnpm test",
    "env --unset=X pnpm test",
    "time -p pnpm test",
    "nohup pnpm test",
    "exec pnpm test",
    "command pnpm test",
    "stdbuf -oL pnpm test",
    "stdbuf -o L -e L pnpm test",
    "! pnpm test",
    "bash -c 'pnpm test'",
    'sh -c "cd pkg && pnpm test"',
    "bash -lc 'pnpm test 2>&1 | tail -5'",
  ])("finds the heavy command in %s", (command) => expect(findUnqueuedHeavy(command)?.queue).toBe("tests"));

  each(["command -v pnpm", "bash -c 'echo pnpm test'", "env -u X ls", "nohup sleep 5"])("passes %s", (command) =>
    expect(findUnqueuedHeavy(command)).toBeNull(),
  );

  it("never reads a queued form's own bash -c body as unqueued", () => {
    expect(findUnqueuedHeavy("node /s/queue.mjs run --queue=tests -- bash -c 'pnpm test'")).toBeNull();
  });
});

describe("the duplicate key", () => {
  each([
    ["pnpm test 2>&1 | tail -40", "pnpm test 2>&1 | tail -80"],
    ["pnpm test > out.log", "pnpm  test"],
    ["cd a && pnpm test | tail", "cd a &&  pnpm test 2>/dev/null"],
    ["bash -c 'pnpm test | tail -5'", "pnpm test"],
  ])("%s and %s are one run", (a, b) => expect(dupeKey(a)).toBe(dupeKey(b)));

  each([
    ["cd a && pnpm test", "cd b && pnpm test"],
    ["pnpm test", "pnpm build"],
    ["echo a", "echo b"],
  ])("%s and %s are two runs", (a, b) => expect(dupeKey(a) === dupeKey(b)).toBe(false));

  it("keys a command with no heavy segment on its whole normalized text", () => {
    expect(dupeKey("  node  -e 1 ")).toBe("node -e 1");
  });
});

describe("the body a typed queued form runs", () => {
  each([
    ["node /s/queue.mjs run --queue=tests -- bash -c 'touch /tmp/x && vitest'", ["touch /tmp/x && vitest"]],
    ['node /s/queue.mjs run -- sh -c "pnpm test"', ["pnpm test"]],
    ["node /s/queue.mjs run --queue=e2e -- playwright test", ["playwright test"]],
    ["cd a && node /s/queue.mjs run -- x y", ["x y"]],
    ["pytest", []],
    ["node /s/queue.mjs run --queue=tests", []],
  ])("%s runs %j", (command, bodies) => expect(queuedBodies(command)).toEqual(bodies));
});
