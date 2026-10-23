import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { classifyQueued, commandHead, decide, defaultSlots, heavyQueue } from "./pretooluse.mjs";

const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command, ...extra } });
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason;
const queueOf = (command) => heavyQueue(commandHead(command));
const none = { queueStatus: () => null };

describe("heavy command classifier", () => {
  it.each([
    ["vitest run", "tests"],
    ["npx jest", "tests"],
    ["mocha", "tests"],
    ["pytest", "tests"],
    ["python -m pytest -q", "tests"],
    ["go test ./...", "tests"],
    ["cargo test", "tests"],
    ["cargo build --release", "tests"],
    ["tsc --noEmit", "tests"],
    ["next build", "tests"],
    ["./gradlew test", "tests"],
    ["mvn verify", "tests"],
    ["npm run test", "tests"],
    ["npm test", "tests"],
    ["pnpm build", "tests"],
    ["pnpm run typecheck", "tests"],
    ["yarn test", "tests"],
    ["bun run build", "tests"],
    ["FOO=1 nice -n 5 vitest", "tests"],
    ["playwright test", "e2e"],
    ["npx cypress run", "e2e"],
    ["pnpm test:e2e", "e2e"],
    ["npm run e2e", "e2e"],
  ])("%s goes to %s", (command, queue) => expect(queueOf(command)).toBe(queue));

  it.each([
    "ls",
    "git status",
    "vitest src/a.test.ts",
    "jest tests/unit",
    "pytest tests/test_a.py::test_x",
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
    "pnpm test src/a.test.ts",
    "pnpm test:watch",
    "npm install",
    "pnpm lint",
    "vitest --version",
    "tsc --help",
  ])("%s passes", (command) => expect(queueOf(command)).toBeNull());
});

describe("decide", () => {
  it("denies an until-sleep loop", () => {
    expect(reason(decide(bash("until grep -q x f; do sleep 20; done"), {}, none))).toMatch(/sleeping or polling/);
  });

  it("allows an ordinary command", () => {
    expect(decide(bash("ls"), {}, none)).toBeNull();
  });

  it("denies an unqueued heavy command with the queued form", () => {
    const text = reason(decide(bash("pytest"), {}, { ...none, queueMjs: "/skill/tools/queue.mjs" }));
    expect(text).toContain("node '/skill/tools/queue.mjs' run --queue=tests --slots=");
    expect(text).toContain("-- sh -c 'pytest'");
    expect(text).toContain("background");
  });

  it("allows an already queued heavy command when the queue has room", () => {
    const command = "node /skill/tools/queue.mjs run --queue=tests -- sh -c 'pytest'";
    expect(decide(bash(command), {}, { queueStatus: () => ({ slots: 2, holders: [], waiters: [] }) })).toBeNull();
  });

  it("denies a foreground queued command on a full queue, naming the holder", () => {
    const command = "node /skill/tools/queue.mjs run --queue=e2e -- sh -c 'playwright test'";
    const status = () => ({ slots: 1, holders: [{ slot: 0, cwd: "/w/lane-a", acquiredAt: Date.now() }], waiters: [] });
    expect(reason(decide(bash(command), {}, { queueStatus: status }))).toMatch(/"e2e" queue is full \(held by lane-a/);
    expect(decide(bash(command, { run_in_background: true }), {}, { queueStatus: status })).toBeNull();
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
    const dir = mkdtempSync(path.join(os.tmpdir(), "cq-"));
    mkdirSync(path.join(dir, "v1", "tests"), { recursive: true });
    const env = { CONDUCTOR_QUEUE_DIR: dir };
    expect(decide(bash("node /s/queue.mjs run --queue=tests -- sh -c 'pytest'"), env)).toBeNull();
  });
});

describe("slots and queue names", () => {
  it("defaults tests to a quarter of the cores, e2e to 1, and honours the env override", () => {
    expect(defaultSlots("tests", {}, 16)).toBe(4);
    expect(defaultSlots("tests", {}, 2)).toBe(1);
    expect(defaultSlots("e2e", {}, 16)).toBe(1);
    expect(defaultSlots("tests", { CONDUCTOR_QUEUE_SLOTS_TESTS: "3" }, 16)).toBe(3);
    expect(defaultSlots("e2e", { CONDUCTOR_QUEUE_SLOTS_E2E: "0" }, 16)).toBe(1);
  });

  it("names the queue of a queue.mjs run segment", () => {
    expect(classifyQueued("node /s/queue.mjs run --queue=e2e -- x")).toBe("e2e");
    expect(classifyQueued("node /s/queue.mjs run -- x")).toBe("default");
    expect(classifyQueued("node /s/queue.mjs status")).toBeNull();
    expect(classifyQueued("pytest")).toBeNull();
  });
});

describe("process wiring", () => {
  const file = fileURLToPath(new URL("./pretooluse.mjs", import.meta.url));
  const run = (stdin, env = {}) =>
    spawnSync("node", [file], { input: stdin, env: { ...process.env, CI: "", ...env }, encoding: "utf8" });

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
});
