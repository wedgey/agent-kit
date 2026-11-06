#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it.
/**
 * Removes the worktrees and branches that finished delegates leave behind. It only ever removes
 * what the remote already holds, so a lost worktree costs a reinstall, never work.
 *
 *   sweep-worktrees.mjs [--dry-run] [--background]
 *
 * Works on the repo holding the current folder. Prints one line per worktree and branch it acted on
 * or kept. --background is the session-start hook's form: at most one run per repo per hour, with
 * the lines appended to <temp>/conductor-worktree-sweep/<repo>.log.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
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
  if (prs.some((pr) => pr.state === "MERGED")) return keep("commits past its merged PR");
  if (prs.length) return keep("PR closed without merging");
  if (!onTrunk) return keep("no PR, and commits not on trunk");
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

function ghPrs(branch, root) {
  const json = quietly(() => execFileSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "state,headRefOid"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }));
  return json === null ? null : JSON.parse(json);
}

function linuxProcStart(pid) {
  if (!quietly(() => statSync("/proc/self"))) return undefined;
  const stat = quietly(() => readFileSync(`/proc/${pid}/stat`, "utf8"));
  // The name in field 2 may hold spaces, so count from the bracket that closes it. Start time is field 22.
  return stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] : null;
}

function anyProcessIn(dir) {
  return (quietly(() => readdirSync("/proc")) ?? []).some((pid) => /^\d+$/.test(pid) && within(quietly(() => readlinkSync(`/proc/${pid}/cwd`)) ?? "", dir));
}

// A container bind-mounting a removed worktree comes back from its next restart with empty folders
// in place of those files, and fails far from here.
function dockerMounts() {
  const ids = quietly(() => execFileSync("docker", ["ps", "-q"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }))?.split("\n").filter(Boolean) ?? [];
  if (!ids.length) return [];
  const json = quietly(() => execFileSync("docker", ["inspect", ...ids], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }));
  return json ? JSON.parse(json).flatMap((c) => c.Mounts.map((m) => m.Source)) : [];
}

const isAncestor = (root, commit, trunk) => trunk !== null && quietly(() => git(root, "merge-base", "--is-ancestor", commit, trunk)) !== null;

export function sweep(root, { dryRun = false, prs = ghPrs, procStart = linuxProcStart, inUse = anyProcessIn, mounts = dockerMounts, out = console.log } = {}) {
  quietly(() => git(root, "fetch", "--quiet", "origin"));
  if (!dryRun) git(root, "worktree", "prune");
  const trunk = quietly(() => git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"));
  const trunkBranch = trunk?.replace("origin/", "");
  const mounted = mounts();

  for (const w of parseWorktrees(git(root, "worktree", "list", "--porcelain"))) {
    if (!within(w.path, path.join(root, WORKTREES)) || w.path === path.join(root, WORKTREES)) continue;
    const lock = lockState(w.lock, procStart);
    const { remove, why } = verdict({
      lock,
      inUse: inUse(w.path) || mounted.some((m) => within(m, w.path)),
      dirty: git(w.path, "status", "--porcelain") !== "",
      head: w.head,
      prs: w.branch ? prs(w.branch, root) : [],
      onTrunk: isAncestor(root, w.head, trunk),
      ageMs: Date.now() - statSync(w.path).mtimeMs,
    });
    if (!remove) {
      out(`kept ${w.path}: ${why}`);
      continue;
    }
    const line = `${w.path}, branch ${w.branch ?? "(detached)"} at ${w.head}: ${why}`;
    if (dryRun) {
      out(`would remove ${line}`);
      continue;
    }
    try {
      if (lock === "stale") git(root, "worktree", "unlock", w.path);
      // Never --force. A refusal here means git saw something this check did not.
      git(root, "worktree", "remove", w.path);
      if (w.branch && w.branch !== trunkBranch) git(root, "branch", "-D", w.branch);
      out(`removed ${line}`);
    } catch (error) {
      out(`kept ${w.path}: ${String(error.stderr ?? error.message).trim()}`);
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
