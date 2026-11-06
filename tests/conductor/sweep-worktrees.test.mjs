import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { dockerMounts, ghPrs, linuxProcStart, lockState, parseWorktrees, sweep, verdict } from "../../skills/conductor/tools/sweep-worktrees.mjs";

const HOUR = 3_600_000;
const facts = (over = {}) => ({ lock: "none", inUse: false, dirty: false, head: "aaa", prs: [], onTrunk: false, ageMs: 2 * HOUR, ...over });
const merged = { state: "MERGED", headRefOid: "aaa" };

describe("the verdict on one worktree", () => {
  it("removes a clean worktree whose PR merged at its own head", () => {
    expect(verdict(facts({ prs: [merged] })).remove).toBe(true);
  });

  it("removes one whose lock outlived its session", () => {
    expect(verdict(facts({ prs: [merged], lock: "stale" })).remove).toBe(true);
  });

  for (const [name, over] of [
    ["a live lock", { prs: [merged], lock: "live" }],
    ["a process or container using it", { prs: [merged], inUse: true }],
    ["uncommitted or untracked work", { prs: [merged], dirty: true }],
    ["commits past the merged head", { prs: [{ state: "MERGED", headRefOid: "bbb" }] }],
    ["an open PR beside a merged one", { prs: [merged, { state: "OPEN", headRefOid: "aaa" }] }],
    ["an open PR even when its head is on trunk", { prs: [{ state: "OPEN", headRefOid: "aaa" }], onTrunk: true }],
    ["a PR closed without merging", { prs: [{ state: "CLOSED", headRefOid: "aaa" }] }],
    ["no PR and commits off trunk", {}],
    ["no answer from the PR lookup", { prs: null, onTrunk: true }],
    ["a stale lock and no merged PR, even on trunk", { lock: "stale", onTrunk: true }],
    ["a head on trunk that is under an hour old, which may not be locked yet", { onTrunk: true, ageMs: HOUR - 1 }],
  ]) {
    it(`keeps one with ${name}`, () => {
      const out = verdict(facts(over));
      expect(out.remove).toBe(false);
      expect(out.why.length).toBeGreaterThan(0);
    });
  }

  it("removes one on trunk whose PR closed or merged elsewhere", () => {
    expect(verdict(facts({ onTrunk: true, prs: [{ state: "CLOSED", headRefOid: "aaa" }] })).remove).toBe(true);
    expect(verdict(facts({ onTrunk: true, prs: [{ state: "MERGED", headRefOid: "bbb" }] })).remove).toBe(true);
  });

  it("removes one with no PR once its head is on trunk and it is over an hour old", () => {
    expect(verdict(facts({ onTrunk: true })).remove).toBe(true);
  });
});

describe("a worktree's lock", () => {
  const reason = "claude agent agent-a1 (pid 99 start 500)";

  it("is none without a reason line, and live for a lock it cannot read", () => {
    expect(lockState(undefined, () => null)).toBe("none");
    expect(lockState("", () => null)).toBe("live");
    expect(lockState("moved to a USB disk", () => null)).toBe("live");
  });

  it("is stale when the pid is gone or now belongs to a newer process", () => {
    expect(lockState(reason, () => null)).toBe("stale");
    expect(lockState(reason, () => "501")).toBe("stale");
  });

  it("is live while the same process holds it, or where the process table cannot be read", () => {
    expect(lockState(reason, () => "500")).toBe("live");
    expect(lockState(reason, () => undefined)).toBe("live");
  });
});

describe("the process table", () => {
  it("reads the start time git's lock reason records, and null for a gone pid", () => {
    const stat = execFileSync("cat", [`/proc/${process.pid}/stat`], { encoding: "utf8" });
    expect(linuxProcStart(process.pid)).toBe(stat.split(") ")[1].split(" ")[19]);
    expect(linuxProcStart(4_000_000_000)).toBeNull();
    expect(lockState(`x (pid ${process.pid} start ${linuxProcStart(process.pid)})`, linuxProcStart)).toBe("live");
  });
});

describe("the PR lookup", () => {
  it("answers null, which keeps the worktree, when gh prints something that is not JSON", () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "sweep-gh-"));
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'rate limited'\n");
    chmodSync(path.join(bin, "gh"), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    try {
      expect(ghPrs("any", bin)).toBeNull();
    } finally {
      process.env.PATH = before;
    }
  });
});

describe("docker's mounts", () => {
  const fail = (code) => () => { throw Object.assign(new Error("no"), { code }); };

  it("lists every container's mount sources, stopped ones included", () => {
    const calls = [];
    const docker = (...args) => {
      calls.push(args[0] === "ps" ? args.join(" ") : args[0]);
      return args[0] === "ps" ? "c1\nc2\n" : JSON.stringify([{ Mounts: [{ Source: "/a" }] }, { Mounts: [{ Source: "/b" }] }]);
    };
    expect(dockerMounts(docker)).toEqual(["/a", "/b"]);
    expect(calls).toEqual(["ps -aq", "inspect"]);
  });

  it("has no mounts without docker, and answers null when docker fails", () => {
    expect(dockerMounts(fail("ENOENT"))).toEqual([]);
    expect(dockerMounts(fail("ETIMEDOUT"))).toBeNull();
    expect(dockerMounts(fail(1))).toBeNull();
  });
});

describe("git's worktree list", () => {
  it("reads path, head, branch and lock, with a detached head and an empty lock reason", () => {
    const text = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/w\nHEAD bbb\ndetached\nlocked\n\nworktree /r/x\nHEAD ccc\nbranch refs/heads/a/b\nlocked why not\n";
    expect(parseWorktrees(text)).toEqual([
      { path: "/r", head: "aaa", branch: "main" },
      { path: "/r/w", head: "bbb", lock: "" },
      { path: "/r/x", head: "ccc", branch: "a/b", lock: "why not" },
    ]);
  });
});

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A clone of a bare origin, on main, with a commit to branch from. */
function repo() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sweep-")));
  git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(dir, "clone", "-q", "origin.git", "work");
  const root = path.join(dir, "work");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "switch", "-q", "-c", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "first");
  git(root, "push", "-q", "-u", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
  mkdirSync(path.join(root, ".claude/worktrees"), { recursive: true });
  return root;
}

/** A worktree under the harness's folder, with one commit of its own unless `commit` is false. */
function lane(root, name, { commit = true, at = ".claude/worktrees" } = {}) {
  const wt = path.join(root, at, name);
  git(root, "worktree", "add", "-q", "-b", name, wt, "origin/main");
  if (commit) git(wt, "commit", "-q", "--allow-empty", "-m", name);
  const old = new Date(Date.now() - 2 * HOUR);
  utimesSync(wt, old, old);
  return { wt, head: git(wt, "rev-parse", "HEAD") };
}

const run = (root, prs, over = {}) => {
  const lines = [];
  sweep(root, { prs: (branch) => prs[branch] ?? [], mounts: () => [], procStart: () => null, inUse: () => false, out: (l) => lines.push(l), ...over });
  return lines;
};
const branches = (root) => git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n");

describe("the sweep on a real repo", () => {
  it("removes a merged lane's worktree and branch, and keeps an open one's", () => {
    const root = repo();
    const done = lane(root, "agent-done");
    const open = lane(root, "agent-open");
    const lines = run(root, { "agent-done": [{ state: "MERGED", headRefOid: done.head }], "agent-open": [{ state: "OPEN", headRefOid: open.head }] });
    expect([existsSync(done.wt), existsSync(open.wt)]).toEqual([false, true]);
    expect(branches(root)).toEqual(["agent-open", "main"]);
    expect(lines.find((l) => l.includes("agent-done"))).toContain(done.head);
  });

  it("removes a merged lane whose lock outlived its session", () => {
    const root = repo();
    const { wt, head } = lane(root, "agent-locked");
    git(root, "worktree", "lock", "--reason", "claude agent agent-locked (pid 99 start 500)", wt);
    run(root, { "agent-locked": [{ state: "MERGED", headRefOid: head }] });
    expect(existsSync(wt)).toBe(false);
  });

  it("leaves a stale lock on a worktree it keeps", () => {
    const root = repo();
    const { wt } = lane(root, "agent-unmerged");
    git(root, "worktree", "lock", "--reason", "claude agent x (pid 99 start 500)", wt);
    run(root, {});
    expect(git(root, "worktree", "list", "--porcelain")).toContain("locked claude agent x");
  });

  it("never touches a worktree outside the harness's folder, or the main checkout", () => {
    const root = repo();
    const mine = lane(root, "mine", { at: ".worktrees" });
    run(root, { mine: [{ state: "MERGED", headRefOid: mine.head }], main: [{ state: "MERGED", headRefOid: git(root, "rev-parse", "HEAD") }] });
    expect(existsSync(mine.wt)).toBe(true);
    expect(branches(root)).toEqual(["main", "mine"]);
  });

  it("keeps a merged worktree holding an untracked file", () => {
    const root = repo();
    const { wt, head } = lane(root, "agent-dirty");
    writeFileSync(path.join(wt, "notes.txt"), "unsaved");
    run(root, { "agent-dirty": [{ state: "MERGED", headRefOid: head }] });
    expect(existsSync(path.join(wt, "notes.txt"))).toBe(true);
  });

  it("keeps a merged worktree that a running container mounts", () => {
    const root = repo();
    const { wt, head } = lane(root, "agent-mounted");
    run(root, { "agent-mounted": [{ state: "MERGED", headRefOid: head }] }, { mounts: () => [path.join(wt, "supabase/templates/a.html")] });
    expect(existsSync(wt)).toBe(true);
  });

  it("keeps every worktree when docker cannot answer", () => {
    const root = repo();
    const { wt, head } = lane(root, "agent-done");
    run(root, { "agent-done": [{ state: "MERGED", headRefOid: head }] }, { mounts: () => null });
    expect(existsSync(wt)).toBe(true);
  });

  it("sees an untracked file even with status.showUntrackedFiles=no", () => {
    const root = repo();
    git(root, "config", "status.showUntrackedFiles", "no");
    const { wt, head } = lane(root, "agent-dirty");
    writeFileSync(path.join(wt, "notes.txt"), "unsaved");
    run(root, { "agent-dirty": [{ state: "MERGED", headRefOid: head }] });
    expect(existsSync(path.join(wt, "notes.txt"))).toBe(true);
  });

  it("leaves the registration of a worktree whose folder is out of sight", () => {
    const root = repo();
    const { wt } = lane(root, "elsewhere", { at: ".worktrees" });
    rmSync(wt, { recursive: true });
    run(root, {});
    expect(git(root, "worktree", "list", "--porcelain")).toContain(wt);
  });

  it("carries on past a locked worktree whose folder is gone", () => {
    const root = repo();
    const gone = lane(root, "agent-a-gone");
    git(root, "worktree", "lock", "--reason", "claude agent x (pid 99 start 500)", gone.wt);
    rmSync(gone.wt, { recursive: true });
    const done = lane(root, "agent-b-done");
    const lines = run(root, { "agent-b-done": [{ state: "MERGED", headRefOid: done.head }] });
    expect(existsSync(done.wt)).toBe(false);
    expect(lines.find((l) => l.includes("agent-a-gone"))).toContain("kept");
  });

  it("does nothing in a repo with no harness folder", () => {
    const root = repo();
    rmSync(path.join(root, ".claude"), { recursive: true });
    git(root, "branch", "worktree-agent-spent", "origin/main");
    expect(run(root, {})).toEqual([]);
    expect(branches(root)).toContain("worktree-agent-spent");
  });

  it("deletes a harness branch already on trunk, and keeps one with its own commits", () => {
    const root = repo();
    git(root, "branch", "worktree-agent-spent", "origin/main");
    git(root, "switch", "-q", "-c", "worktree-agent-ahead");
    git(root, "commit", "-q", "--allow-empty", "-m", "unmerged");
    git(root, "switch", "-q", "main");
    run(root, {});
    expect(branches(root)).toEqual(["main", "worktree-agent-ahead"]);
  });

  it("keeps a harness branch that a worktree still holds", () => {
    const root = repo();
    lane(root, "worktree-agent-busy", { commit: false, at: ".worktrees" });
    run(root, {});
    expect(branches(root)).toContain("worktree-agent-busy");
  });

  it("does not fetch under a dry run", () => {
    const root = repo();
    const before = git(root, "rev-parse", "origin/main");
    const other = path.join(root, "..", "other");
    git(path.dirname(root), "clone", "-q", "origin.git", "other");
    git(other, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "moved");
    git(other, "push", "-q", "origin", "main");
    run(root, {}, { dryRun: true });
    expect(git(root, "rev-parse", "origin/main")).toBe(before);
  });

  it("only reports under a dry run", () => {
    const root = repo();
    const { wt, head } = lane(root, "agent-done");
    git(root, "branch", "worktree-agent-spent", "origin/main");
    const lines = run(root, { "agent-done": [{ state: "MERGED", headRefOid: head }] }, { dryRun: true });
    expect(existsSync(wt)).toBe(true);
    expect(branches(root)).toContain("worktree-agent-spent");
    expect(lines.join("\n")).toContain("would remove");
  });
});
