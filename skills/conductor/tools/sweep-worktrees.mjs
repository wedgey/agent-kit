#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it.
/**
 * Removes the worktrees and branches that finished delegates leave behind. It only ever removes
 * what the remote already holds, so a lost worktree costs a reinstall and its gitignored files.
 *
 *   sweep-worktrees.mjs [--dry-run] [--background]
 *
 * Works on the repo holding the current folder. Prints one line per worktree and branch it acted on
 * or kept. --background is the session-start hook's form: at most one run per repo per hour, with
 * the lines appended to <temp>/conductor-worktree-sweep/<repo>.log.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKTREES = ".claude/worktrees";
const SPENT_BRANCH_PREFIX = "worktree-agent-";
const HOUR = 3_600_000;

/** Whether to remove one worktree. `prs` is null when the lookup failed, and every doubt keeps it. */
export function verdict({ lock, inUse, dirty, head, prs, onTrunk, ageMs }) {
  const keep = (why) => ({ remove: false, why });
  if (lock === "live") return keep("locked by a live process");
  if (inUse) return keep("in use by a process or container");
  if (dirty) return keep("uncommitted or untracked files");
  if (!prs) return keep("could not read its PRs");
  if (prs.some((pr) => pr.state === "OPEN")) return keep("open PR");
  if (prs.some((pr) => pr.state === "MERGED" && pr.headRefOid === head)) return { remove: true, why: "PR merged" };
  if (!onTrunk) {
    if (prs.some((pr) => pr.state === "MERGED")) return keep("commits past its merged PR");
    return keep(prs.length ? "PR closed without merging" : "no PR, and commits not on trunk");
  }
  // A lock looks stale to a process in another PID namespace, so only a merged PR outweighs one.
  if (lock === "stale") return keep("on trunk, with a lock that may be live elsewhere");
  // A brand-new worktree also sits on trunk, and it may not hold its lock yet.
  if (ageMs < HOUR) return keep("on trunk, but under an hour old");
  return { remove: true, why: "nothing beyond trunk" };
}

/** `procStart(pid)` is the process's start time, null when it is gone, undefined when nothing can tell. */
export function lockState(reason, procStart) {
  if (reason === undefined) return "none";
  const owner = /\(pid (\d+) start (\d+)\)/.exec(reason);
  if (!owner) return "live";
  const started = procStart(owner[1]);
  return started === undefined || started === owner[2] ? "live" : "stale";
}

export function parseWorktrees(text) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const w = {};
    for (const line of block.split("\n")) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") w.path = value;
      else if (key === "HEAD") w.head = value;
      else if (key === "branch") w.branch = value.replace("refs/heads/", "");
      else if (key === "locked") w.lock = value;
    }
    return w;
  });
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
}).trim();

const quietly = (fn) => { try { return fn(); } catch { return null; } };
const within = (file, dir) => file === dir || file.startsWith(`${dir}/`);

export function ghPrs(branch, root) {
  return quietly(() => JSON.parse(execFileSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "state,headRefOid"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 })));
}

export function linuxProcStart(pid) {
  if (!quietly(() => statSync("/proc/self"))) return undefined;
  const stat = quietly(() => readFileSync(`/proc/${pid}/stat`, "utf8"));
  // The name in field 2 may hold spaces, so count from the bracket that closes it. Start time is field 22.
  return stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] : null;
}

// shortcut: without /proc every worktree counts as in use, so no worktree is removed off Linux. Read lsof there if that ever matters.
export function anyProcessIn(dir, proc = "/proc") {
  const pids = quietly(() => readdirSync(proc));
  if (!pids?.includes("self")) return true;
  return pids.some((pid) => /^\d+$/.test(pid) && within(quietly(() => readlinkSync(`${proc}/${pid}/cwd`)) ?? "", dir));
}

const runDocker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });

// A container bind-mounting a removed worktree comes back from its next restart with empty folders
// in place of those files, and fails far from here. So stopped containers count, and null, for
// docker failing, keeps every worktree. Only a machine without docker has no mounts.
export function dockerMounts(docker = runDocker) {
  try {
    const ids = docker("ps", "-aq").split("\n").filter(Boolean);
    return ids.length ? JSON.parse(docker("inspect", ...ids)).flatMap((c) => c.Mounts.map((m) => m.Source)) : [];
  } catch (error) {
    return error.code === "ENOENT" ? [] : null;
  }
}

const isAncestor = (root, commit, trunk) => trunk !== null && quietly(() => git(root, "merge-base", "--is-ancestor", commit, trunk)) !== null;

export function sweep(root, { dryRun = false, prs = ghPrs, procStart = linuxProcStart, inUse = anyProcessIn, mounts = dockerMounts, out = console.log } = {}) {
  if (!existsSync(path.join(root, WORKTREES))) return;
  if (!dryRun) quietly(() => git(root, "fetch", "--quiet", "origin"));
  const trunk = quietly(() => git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"));
  const trunkBranch = trunk?.replace("origin/", "");
  const mounted = mounts();
  const list = () => parseWorktrees(git(root, "worktree", "list", "--porcelain"));

  for (const w of list()) {
    if (!within(w.path, path.join(root, WORKTREES)) || w.path === path.join(root, WORKTREES)) continue;
    try {
      const current = () => list().find((other) => other.path === w.path);
      if (lockState(current()?.lock, procStart) === "live") {
        out(`kept ${w.path}: locked by a live process`);
        continue;
      }
      const found = w.branch ? prs(w.branch, root) : [];
      // Judge what is there after the slow PR lookup. A session can commit, switch or relock meanwhile,
      // and git's remove and branch -D would drop a late commit without complaint.
      const now = current();
      if (!now) {
        out(`kept ${w.path}: no longer registered`);
        continue;
      }
      if (now.branch !== w.branch) {
        out(`kept ${w.path}: changed branch during the sweep`);
        continue;
      }
      const lock = lockState(now.lock, procStart);
      const { remove, why } = verdict({
        lock,
        inUse: mounted === null || inUse(w.path) || mounted.some((m) => within(m, w.path)),
        // Explicit flags, because status.showUntrackedFiles=no blinds both this and `git worktree remove`.
        dirty: git(w.path, "--no-optional-locks", "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none") !== "",
        head: now.head,
        prs: found,
        onTrunk: isAncestor(root, now.head, trunk),
        ageMs: Date.now() - statSync(w.path).mtimeMs,
      });
      if (!remove) {
        out(`kept ${w.path}: ${why}`);
        continue;
      }
      const line = `${w.path}, branch ${w.branch ?? "(detached)"} at ${now.head}: ${why}`;
      if (dryRun) {
        out(`would remove ${line}`);
        continue;
      }
      if (lock === "stale") git(root, "worktree", "unlock", w.path);
      // Never --force. A refusal here means git saw something this check did not.
      git(root, "worktree", "remove", w.path);
      out(`removed ${line}`);
      if (w.branch && w.branch !== trunkBranch && quietly(() => git(root, "branch", "-D", w.branch)) === null) out(`kept branch ${w.branch}: could not delete it`);
    } catch (error) {
      out(`kept ${w.path}: ${String(error.stderr || error.message).trim()}`);
    }
  }

  if (trunk === null) return;
  const refs = git(root, "for-each-ref", "--format=%(refname:short) %(worktreepath)", `refs/heads/${SPENT_BRANCH_PREFIX}*`);
  for (const [branch, holder] of refs.split("\n").filter(Boolean).map((line) => line.split(" "))) {
    if (holder) continue;
    if (!isAncestor(root, branch, trunk)) out(`kept branch ${branch}: commits not on trunk`);
    else if (dryRun) out(`would delete branch ${branch}: on trunk`);
    else if (quietly(() => git(root, "branch", "-D", branch)) !== null) out(`deleted branch ${branch}: on trunk`);
  }
}

/* c8 ignore start -- process wiring */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const common = quietly(() => git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir"));
  if (!common) process.exit(0);
  const root = path.dirname(common);
  let out = console.log;
  if (args.includes("--background")) {
    const dir = path.join(os.tmpdir(), "conductor-worktree-sweep");
    const log = path.join(dir, `${root.replaceAll("/", "-")}.log`);
    const last = quietly(() => statSync(log).mtimeMs);
    if (last !== null && Date.now() - last < HOUR) process.exit(0);
    mkdirSync(dir, { recursive: true });
    out = (line) => appendFileSync(log, `${line}\n`);
    out(`sweep ${new Date().toISOString()}`);
  }
  sweep(root, { dryRun: args.includes("--dry-run"), out });
}
