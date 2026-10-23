import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { each, expect } from "./expect.mjs";

import {
  classifyQueued,
  commandHead,
  decide,
  heavyQueue,
  queuedForm,
  queuedSlots,
  repoManaged,
} from "../../skills/conductor/tools/hooks/pretooluse.mjs";
import { parseRunArgs, processStartTime, resolveSlots } from "../../skills/conductor/tools/queue.mjs";

const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command, ...extra } });
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason;
const queueOf = (command) => heavyQueue(commandHead(command));
const none = { queueStatus: () => null };
const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));

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
    "playwright test e2e/login.spec.ts",
    "cypress run --spec cypress/e2e/a.cy.ts",
    "gradle test --tests Foo",
    "mvn test -Dtest=Foo",
    "pnpm --filter web test",
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
    "yarn e2e:headed",
    "pnpm build:dev",
    "pnpm ci:watch",
    "turbo run test:watch",
  ])("never queues the watch mode %s", (command) => expect(queueOf(command)).toBeNull());
});

describe("decide", () => {
  it("denies an until-sleep loop", () => {
    expect(reason(decide(bash("until grep -q x f; do sleep 20; done"), {}, none))).toMatch(/sleeping or polling/);
  });

  it("allows an ordinary command", () => {
    expect(decide(bash("ls"), {}, none)).toBeNull();
  });

  it("denies an unqueued heavy command with the whole command queued and no slot count", () => {
    const text = reason(decide(bash("cd pkg && pytest | tail -5"), {}, { ...none, queueMjs: "/skill/tools/queue.mjs" }));
    expect(text).toContain(`node '/skill/tools/queue.mjs' run --queue=tests -- bash -c 'cd pkg && pytest | tail -5'`);
    expect(text).not.toMatch(/--slots/);
    expect(text).toContain("background");
  });

  it("allows an already queued heavy command when the queue has room", () => {
    const command = "node /skill/tools/queue.mjs run --queue=tests -- bash -c 'pytest'";
    expect(decide(bash(command), {}, { queueStatus: () => ({ slots: 2, holders: [], waiters: [] }) })).toBeNull();
  });

  it("exempts only the queued segment, not every segment after it", () => {
    const text = reason(decide(bash("node /s/queue.mjs run -- x && pytest"), {}, none));
    expect(text).toMatch(/heavy command/);
  });

  it("denies a foreground queued command on a full queue, naming the holder", () => {
    const command = "node /skill/tools/queue.mjs run --queue=e2e -- bash -c 'playwright test'";
    const status = () => ({ slots: 1, holders: [{ slot: 0, cwd: "/w/lane-a", acquiredAt: Date.now() }], waiters: [] });
    expect(reason(decide(bash(command), {}, { queueStatus: status }))).toMatch(/"e2e" queue is full \(held by lane-a/);
    expect(decide(bash(command, { run_in_background: true }), {}, { queueStatus: status })).toBeNull();
  });

  it("judges full with the slot count queue.mjs would use", () => {
    const dir = tmp("cq-");
    const holders = path.join(dir, "v1", "tests", "holders");
    mkdirSync(holders, { recursive: true });
    writeFileSync(
      path.join(holders, "slot-0.json"),
      JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid), cwd: "/w/lane-a", acquiredAt: Date.now() }),
    );
    const queued = "node /s/queue.mjs run --queue=tests -- bash -c 'pytest'";
    const env = { CONDUCTOR_QUEUE_DIR: dir };
    expect(reason(decide(bash(queued), env))).toMatch(/"tests" queue is full/);
    expect(decide(bash(queued), { ...env, CONDUCTOR_QUEUE_SLOTS_TESTS: "2" })).toBeNull();
    expect(decide(bash("node /s/queue.mjs run --queue=tests --slots=2 -- bash -c 'pytest'"), env)).toBeNull();
  });

  it("managed mode leaves heavy commands alone but still denies a wait loop", () => {
    const env = { CONDUCTOR_QUEUE_MANAGED: "1" };
    expect(decide(bash("pytest"), env, none)).toBeNull();
    expect(reason(decide(bash("while true; do sleep 5; done"), env, none))).toMatch(/sleeping or polling/);
  });

  it("is bypassed from the environment or the command", () => {
    expect(decide(bash("pytest"), { CONDUCTOR_HOOKS: "off" }, none)).toBeNull();
    expect(decide(bash("CONDUCTOR_HOOKS=off pytest"), {}, none)).toBeNull();
  });

  it("fails open on bad input, a non-Bash tool and a throwing status", () => {
    expect(decide(null, {})).toBeNull();
    expect(decide({ tool_name: "Read", tool_input: { command: "pytest" } }, {})).toBeNull();
    expect(decide(bash("node /s/queue.mjs run -- x"), {}, { queueStatus: () => { throw new Error("x"); } })).toBeNull();
    expect(decide(bash("node /s/queue.mjs run -- x"), {}, { classify: () => { throw new Error("x"); } })).toBeNull();
  });

  it("reads a real empty queue state as not full", () => {
    const dir = tmp("cq-");
    mkdirSync(path.join(dir, "v1", "tests"), { recursive: true });
    const env = { CONDUCTOR_QUEUE_DIR: dir };
    expect(decide(bash("node /s/queue.mjs run --queue=tests -- bash -c 'pytest'"), env)).toBeNull();
  });
});

describe("managed is decided for the repo the command runs in", () => {
  const repo = (settings) => {
    const top = tmp("repo-");
    mkdirSync(path.join(top, ".git"));
    mkdirSync(path.join(top, "pkg", "deep"), { recursive: true });
    if (settings !== undefined) {
      mkdirSync(path.join(top, ".claude"));
      writeFileSync(path.join(top, ".claude", "settings.json"), settings);
    }
    return top;
  };
  const managedRepo = JSON.stringify({ env: { CONDUCTOR_QUEUE_MANAGED: "1" } });
  const inRepo = (cwd) => ({ ...bash("pytest"), cwd });

  it("a repo whose settings set the flag is managed from any folder inside it", () => {
    const top = repo(managedRepo);
    expect(repoManaged(path.join(top, "pkg", "deep"), {})).toBe(true);
    expect(decide(inRepo(top), {}, none)).toBeNull();
  });

  it("a repo whose settings lack the flag is not managed, whatever the session env says", () => {
    const top = repo(JSON.stringify({ env: { OTHER: "1" } }));
    expect(repoManaged(top, { CONDUCTOR_QUEUE_MANAGED: "1" })).toBe(false);
    expect(reason(decide(inRepo(top), { CONDUCTOR_QUEUE_MANAGED: "1" }, none))).toMatch(/heavy command/);
  });

  it("a repo without a settings file is not managed, whatever the session env says", () => {
    expect(repoManaged(repo(), { CONDUCTOR_QUEUE_MANAGED: "1" })).toBe(false);
  });

  it("falls back to the session env only outside any repo", () => {
    const env = { CONDUCTOR_QUEUE_MANAGED: "1" };
    expect(repoManaged(undefined, env)).toBe(true);
    expect(repoManaged(undefined, {})).toBe(false);
    expect(repoManaged(path.join(tmp("missing-"), "gone"), env)).toBe(true);
    expect(decide(bash("pytest"), env, none)).toBeNull();
  });

  it("invalid JSON or a settings file it cannot read is not managed", () => {
    expect(repoManaged(repo("{nope"), { CONDUCTOR_QUEUE_MANAGED: "1" })).toBe(false);
    const top = repo();
    mkdirSync(path.join(top, ".claude", "settings.json"), { recursive: true });
    expect(repoManaged(top, { CONDUCTOR_QUEUE_MANAGED: "1" })).toBe(false);
  });
});

describe("slots and queue names", () => {
  it("resolves a queued segment's slots exactly as queue.mjs does", () => {
    const viaQueue = (segment, env) => {
      const argv = segment.split(/\s+/);
      const { queue, slots } = parseRunArgs(argv.slice(argv.indexOf("run") + 1));
      return resolveSlots({ flag: slots, env, queue });
    };
    const suggested = queuedForm("pytest", "tests", "/s/queue.mjs");
    for (const segment of [suggested, "node /s/queue.mjs run --queue=tests --slots=3 -- x", "node /s/queue.mjs run -- x"]) {
      for (const env of [{}, { CONDUCTOR_QUEUE_SLOTS_TESTS: "2" }, { CONDUCTOR_QUEUE_SLOTS_DEFAULT: "5" }]) {
        expect(queuedSlots(segment, env)).toBe(viaQueue(segment, env));
      }
    }
    expect(queuedSlots(suggested, {})).toBe(1);
  });

  it("names the queue of a queue.mjs run segment", () => {
    expect(classifyQueued("node /s/queue.mjs run --queue=e2e -- x")).toBe("e2e");
    expect(classifyQueued("node /s/queue.mjs run -- x")).toBe("default");
    expect(classifyQueued("node /s/queue.mjs status")).toBeNull();
    expect(classifyQueued("pytest")).toBeNull();
  });
});

describe("process wiring", () => {
  const file = fileURLToPath(new URL("../../skills/conductor/tools/hooks/pretooluse.mjs", import.meta.url));
  const run = (stdin, env = {}) =>
    spawnSync("node", [file], { input: stdin, env: { ...process.env, CI: "", CONDUCTOR_QUEUE_MANAGED: "", CONDUCTOR_HOOKS: "", ...env }, encoding: "utf8" });

  it("prints a deny for a poll loop and nothing for ls or garbage", () => {
    const loop = run(JSON.stringify(bash("until grep -q x f; do sleep 20; done")));
    expect(JSON.parse(loop.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(run(JSON.stringify(bash("ls"))).stdout).toBe("");
    expect(run("not json").stdout).toBe("");
    expect(run("not json").status).toBe(0);
  });

  it("prints the queued form for pytest, and nothing when managed", () => {
    expect(run(JSON.stringify(bash("pytest"))).stdout).toContain("run --queue=tests");
    expect(run(JSON.stringify(bash("pytest")), { CONDUCTOR_QUEUE_MANAGED: "1" }).stdout).toBe("");
  });

  it("the suggested form keeps a bash redirect in the foreground and its exit code", () => {
    const bin = tmp("bin-");
    writeFileSync(path.join(bin, "pytest"), "#!/bin/sh\necho ran\nexit 7\n");
    chmodSync(path.join(bin, "pytest"), 0o755);
    const log = path.join(bin, "log");
    const env = { PATH: `${bin}:${process.env.PATH}`, CONDUCTOR_QUEUE_DIR: tmp("cq-") };
    const ran = spawnSync("bash", ["-c", queuedForm(`pytest &> ${log}`, "tests")], { env: { ...process.env, ...env, CI: "" }, encoding: "utf8" });
    expect(ran.status).toBe(7);
    expect(readFileSync(log, "utf8")).toBe("ran\n");
  });

  it("the suggested form runs the whole command under the queue and keeps its exit code", () => {
    const bin = tmp("bin-");
    writeFileSync(path.join(bin, "pytest"), "#!/bin/sh\nexit 7\n");
    chmodSync(path.join(bin, "pytest"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}`, CONDUCTOR_QUEUE_DIR: tmp("cq-") };
    const out = JSON.parse(run(JSON.stringify(bash("cd / && pytest")), env).stdout);
    const form = /Run the whole command as: (.*)\n/.exec(out.hookSpecificOutput.permissionDecisionReason)[1];
    const ran = spawnSync("sh", ["-c", form], { env: { ...process.env, ...env, CI: "", CONDUCTOR_QUEUE_MANAGED: "" }, encoding: "utf8" });
    expect(ran.status).toBe(7);
  });
});
