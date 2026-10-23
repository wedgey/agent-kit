#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * A box-wide FIFO-plus-priority queue in front of heavy commands, on flock(1).
 * Zero dependencies, Node built-ins only; safe to copy verbatim into another repo.
 *
 *   queue.mjs run [--queue=<name>] [--slots=<n>] [--priority=gate|normal] [--timeout=<minutes>] -- <command...>
 *   queue.mjs status [--json]
 *   queue.mjs stop <queue> <slot>
 *   queue.mjs move <ticket> top|up|down
 *
 * State lives under `<stateDir>/v1/<queue>/`:
 *   slot-<i>                  flock lock file; the kernel frees it when the holder dies
 *   holders/slot-<i>.json     who holds it
 *   tickets/<prio>-<ms>-<pid>.json   who is waiting; its JSON `createdAt` is the order key `move` rewrites
 */

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os, { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = 1;
export const STATE_DIR_ENV = "CONDUCTOR_QUEUE_DIR";
export const HELD_ENV = "CONDUCTOR_QUEUE_HELD";
export const POLL_ENV = "CONDUCTOR_QUEUE_POLL_MS";
export const SLOTS_ENV_PREFIX = "CONDUCTOR_QUEUE_SLOTS_";
export const MIN_FREE_ENV = "CONDUCTOR_QUEUE_MIN_FREE_MB";
export const PROC_ENV = "CONDUCTOR_QUEUE_PROC";
export const DEFAULT_MIN_FREE_MB = 4096;
export const DEFAULT_QUEUE = "default";
export const PRIORITIES = ["gate", "normal"];
export const EXEC_FLAG = "--exec";
export const START_FD = 3;
export const CONFLICT_EXIT = 200;
/** `--timeout` expired. */
export const TIMEOUT_EXIT = 76;
/** The same command already runs or waits from the same directory. */
export const DUPLICATE_EXIT = 75;
export const STOP_GRACE_MS = 5000;
// USER_HZ: /proc/<pid>/stat counts CPU time in these ticks on every Linux build that matters.
const CLOCK_TICKS = 100;
export const MIN_BACKOFF_MS = 250;
export const MAX_BACKOFF_MS = 2000;
export const NOTICE_INTERVAL_MS = 30_000;
export const IDLE_SAMPLE_GAP_MS = 1000;
export const ORPHAN_PROBE_BUDGET_MS = 1000;
const COMMAND_SHOWN = 80;

const readText = (f) => readFileSync(f, "utf8");

export function stateDir(env = process.env, home = os.homedir()) {
  if (env[STATE_DIR_ENV]) return env[STATE_DIR_ENV];
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "conductor-queue");
}

export function queueDir(env, name) {
  return path.join(stateDir(env), `v${PROTOCOL_VERSION}`, name);
}

export const validQueueName = (name) => /^[A-Za-z0-9_-]+$/.test(name);

const positive = (v) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The box's slot count for a queue from `CONDUCTOR_QUEUE_SLOTS_<QUEUE>`, or null when unset. */
export const envSlots = (env, queue) => positive(env[SLOTS_ENV_PREFIX + queue.toUpperCase().replace(/[^A-Z0-9]/g, "_")]);

export function resolveSlots({ flag, env = process.env, queue }) {
  return positive(flag) ?? envSlots(env, queue) ?? 1;
}

/** MemTotal and MemAvailable in kB from `<CONDUCTOR_QUEUE_PROC or /proc>/meminfo`, each null when unreadable. */
export function meminfo(env = process.env, readFile = readText) {
  let text = "";
  try {
    text = readFile(path.join(env[PROC_ENV] || "/proc", "meminfo"));
  } catch {
    /* no /proc: unknown */
  }
  const kb = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  return { memTotalKb: kb("MemTotal"), memAvailKb: kb("MemAvailable") };
}

/** Whether a slot past slot 0 may start: MemAvailable is at least the floor. Unknown memory admits. */
export function memoryAdmits(env = process.env, readFile = readText) {
  const mb = Number.parseInt(env[MIN_FREE_ENV] ?? "", 10);
  const floorKb = (Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_MIN_FREE_MB) * 1024;
  const { memAvailKb } = meminfo(env, readFile);
  return memAvailKb === null || memAvailKb >= floorKb;
}

/** Slot 0 always admits, so a full machine still runs one heavy command at a time. */
export const defaultCanTake = (env) => (i) => i === 0 || memoryAdmits(env);

const priorityRank = (p) => (p === "gate" ? 0 : 1);

export function orderTickets(tickets) {
  return [...tickets].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.createdAt - b.createdAt ||
      a.pid - b.pid,
  );
}

const usableOf = (t) => t.usable ?? Array.from({ length: t.slots ?? 1 }, (_, i) => i);

/**
 * Slot indexes this waiter should try. Nobody ahead: every slot it may use, since `flock -n`
 * is the truth. Otherwise each waiter ahead takes the lowest free slot it can use (its
 * `usable` list, else `0..slots-1`), and only what is left over is ours.
 */
export function claimableSlots({ ahead, free, mine }) {
  if (ahead.length === 0) return mine;
  const left = [...free];
  for (const t of ahead) {
    const usable = usableOf(t);
    const k = left.findIndex((i) => usable.includes(i));
    if (k >= 0) left.splice(k, 1);
  }
  return mine.filter((i) => left.includes(i));
}

/** The longest a waiter goes between ticket refreshes: its fixed poll, else the backoff cap. */
export const pollCeilingMs = (env = {}) => Number.parseInt(env[POLL_ENV] ?? "", 10) || MAX_BACKOFF_MS;

/**
 * A waiter refreshes its ticket every poll, but the idle sample can hold one loop for a second,
 * hence the floor. A ticket older than this is stopped, not waiting.
 */
export const staleAfterMs = (ticket = {}) => 3 * Math.max(ticket.pollMs || MAX_BACKOFF_MS, 2 * IDLE_SAMPLE_GAP_MS);

export const isFreshTicket = (ticket, now) => now - ticket.mtimeMs <= staleAfterMs(ticket);

export const freshTickets = (tickets, now) => tickets.filter((t) => isFreshTicket(t, now));

/** Field 22 of /proc/<pid>/stat, in clock ticks since boot; null where unreadable. */
export function processStartTime(pid, readFile = readText) {
  try {
    const stat = readFile(`/proc/${pid}/stat`);
    // comm (field 2) is parenthesised and may hold spaces or parentheses itself.
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * The pid runs with the start time it recorded; a reused pid reads as gone. Where no start
 * time was recorded (no /proc), a bare pid check is all there is.
 */
export function isLive(record, startTimeOf = processStartTime, alive = pidAlive) {
  if (!record || !Number.isInteger(record.pid)) return false;
  if (record.startTime === null || record.startTime === undefined) return alive(record.pid);
  return startTimeOf(record.pid) === record.startTime;
}

export function readJson(file, readFile = readText) {
  try {
    return JSON.parse(readFile(file));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
    return true;
  } catch {
    rmSync(temp, { force: true });
    return false;
  }
}

const TICKET_NAME = /^([a-z]+)-(\d+)-(\d+)\.json$/;

/**
 * Live tickets in queue order, each with the file's mtime. A ticket the owner cannot be read
 * from is judged by the pid in its name and kept while that runs: deleting one read mid-write
 * would drop a live waiter. Only dead ones are deleted, by whoever lists them.
 */
export function listTickets(dir, startTimeOf = processStartTime, alive = pidAlive) {
  const tdir = path.join(dir, "tickets");
  let names;
  try {
    names = readdirSync(tdir);
  } catch {
    return [];
  }
  const live = [];
  for (const name of names) {
    const m = TICKET_NAME.exec(name);
    if (!m) continue;
    const file = path.join(tdir, name);
    const parsed = readJson(file);
    const fromName = { priority: m[1], createdAt: Number(m[2]), pid: Number(m[3]), cwd: "?", command: "?", slots: 1 };
    if (!(parsed ? isLive(parsed, startTimeOf, alive) : alive(fromName.pid))) {
      rmSync(file, { force: true });
      continue;
    }
    try {
      // The file name keeps when it was enqueued; the JSON `createdAt` is the order key and may move.
      live.push({ ...fromName, ...parsed, ticket: name.slice(0, -".json".length), enqueuedAt: fromName.createdAt, mtimeMs: statSync(file).mtimeMs });
    } catch {
      /* removed between listing and stat */
    }
  }
  return orderTickets(live);
}

export function listHolders(dir, startTimeOf = processStartTime, alive = pidAlive) {
  const hdir = path.join(dir, "holders");
  let names;
  try {
    names = readdirSync(hdir);
  } catch {
    return [];
  }
  const holders = [];
  for (const name of names) {
    const m = /^slot-(\d+)\.json$/.exec(name);
    const h = m && readJson(path.join(hdir, name));
    if (h && isLive(h, startTimeOf, alive)) holders.push({ ...h, slot: Number(m[1]) });
  }
  return holders.sort((a, b) => a.slot - b.slot);
}

export function snapshotProc(proc = {}) {
  const pids = proc.pids ?? (() => readdirSync("/proc").filter((n) => /^\d+$/.test(n)));
  const read = proc.stat ?? ((pid) => readText(`/proc/${pid}/stat`));
  let list;
  try {
    list = pids();
  } catch {
    return null;
  }
  const map = new Map();
  for (const pid of list) {
    try {
      const stat = read(pid);
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // After comm: f[0]=state, f[1]=ppid, f[11]=utime, f[12]=stime.
      map.set(Number(pid), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) });
    } catch {
      /* process exited mid-scan */
    }
  }
  return map;
}

/** The root and its descendants in a snapshot, or null when the root is not in it. */
export function treePids(snapshot, root) {
  if (!snapshot?.has(root)) return null;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.pop();
    for (const [child, info] of snapshot) {
      if (info.ppid === pid && !seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return [...seen];
}

export function treeTicks(snapshot, root) {
  return treePids(snapshot, root)?.reduce((sum, pid) => sum + snapshot.get(pid).ticks, 0) ?? null;
}

/**
 * Percent of one core the tree used between two snapshots (340 is 3.4 cores), counting only
 * processes in both, so one that started or ended between them adds nothing.
 */
export function treeCpuPct(a, b, root, ms) {
  const pids = treePids(b, root);
  if (!pids || !a || ms <= 0) return null;
  const ticks = pids.reduce((sum, pid) => sum + (a.has(pid) ? Math.max(0, b.get(pid).ticks - a.get(pid).ticks) : 0), 0);
  return Math.round((ticks / CLOCK_TICKS / (ms / 1000)) * 100);
}

/** Resident memory of the tree in kB, from each process's VmRSS; null when none could be read. */
export function treeMemKb(snapshot, root, readStatus = (pid) => readText(`/proc/${pid}/status`)) {
  let total = null;
  for (const pid of treePids(snapshot, root) ?? []) {
    try {
      const m = /^VmRSS:\s+(\d+)/m.exec(readStatus(pid));
      if (m) total = (total ?? 0) + Number(m[1]);
    } catch {
      /* exited mid-scan */
    }
  }
  return total;
}

/** Unreadable /proc is unknown, never idle. */
export function activity(before, after) {
  if (before === null || after === null || Number.isNaN(before) || Number.isNaN(after)) return "unknown";
  return before === after ? "idle" : "busy";
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Each holder with `state`, `cpuPct` and `memKb` from two process snapshots `gapMs` apart. */
export function withActivity(holders, { proc, sleep = sleepSync, gapMs = IDLE_SAMPLE_GAP_MS } = {}) {
  if (holders.length === 0) return [];
  const a = snapshotProc(proc);
  sleep(gapMs);
  const b = snapshotProc(proc);
  return holders.map((h) => ({
    ...h,
    state: activity(treeTicks(a, h.pid), treeTicks(b, h.pid)),
    cpuPct: treeCpuPct(a, b, h.pid, gapMs),
    memKb: treeMemKb(b, h.pid, proc?.status),
  }));
}

export function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export const truncate = (text, max = COMMAND_SHOWN) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function holderLine(h, now = Date.now()) {
  if (h.orphan && !h.pid) return `slot ${h.slot}: held (no record; orphaned run)`;
  if (h.orphan) return `slot ${h.slot}: orphaned run (no record), pid ${h.pid}, ${formatAge(h.ageMs ?? 0)}, ${h.cwd ?? "?"}, ${truncate(h.command ?? "?")}`;
  return `slot ${h.slot}: ${h.state ?? "unknown"}, ${formatAge(now - h.acquiredAt)}, ${h.cwd}, ${truncate(h.command)}`;
}

export function waiterLine(t, rank, now = Date.now()) {
  return `#${rank + 1} ${t.priority}: ${formatAge(now - (t.enqueuedAt ?? t.createdAt))}, ${t.cwd}, ${truncate(t.command)}`;
}

/**
 * Every process with `file` open, found by its /proc/<pid>/fd links the way fuser(1) does. Slow on
 * a busy box (one readdir per process), so callers ask only about a slot held with no record.
 */
export function lockHolders(file, deps = {}) {
  const list = deps.pids ?? (() => readdirSync("/proc").filter((n) => /^\d+$/.test(n)));
  const fds = deps.fds ?? ((pid) => readdirSync(`/proc/${pid}/fd`));
  const link = deps.link ?? ((pid, fd) => readlinkSync(`/proc/${pid}/fd/${fd}`));
  let target;
  let pids;
  try {
    target = (deps.real ?? realpathSync)(file);
    pids = list();
  } catch {
    return [];
  }
  return pids.map(Number).filter((pid) => {
    try {
      return fds(pid).some((fd) => safeLink(() => link(pid, fd)) === target);
    } catch {
      return false;
    }
  });
}

/**
 * The run behind an orphaned slot: the earliest-started of the processes holding its lock (a
 * waiter's `flock -n` probe holds it for an instant too), with its cwd, command line and age.
 * Empty when nothing can be found.
 */
export function orphanProcess(file, deps = {}) {
  const read = deps.readFile ?? readText;
  const holders = (deps.lockHolders ?? lockHolders)(file)
    .map((pid) => ({ pid, startTime: processStartTime(pid, read) }))
    .filter((p) => p.startTime !== null)
    .sort((a, b) => a.startTime - b.startTime);
  if (holders.length === 0) return {};
  const { pid, startTime } = holders[0];
  let cwd = null;
  let command = null;
  let ageMs = null;
  try {
    cwd = (deps.readlink ?? readlinkSync)(`/proc/${pid}/cwd`);
  } catch {}
  try {
    command = read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean).join(" ") || null;
  } catch {}
  try {
    ageMs = Math.max(0, Math.round(Number(read("/proc/uptime").split(" ")[0]) * 1000 - (startTime / CLOCK_TICKS) * 1000));
  } catch {}
  return { pid, startTime, cwd, command, ageMs };
}

const lockBusy = (spawn, file) => spawn("flock", ["-n", file, "true"], { stdio: "ignore" }).status === 1;

/**
 * One queue at one moment: tickets, holders, then (unless `sample: false`) the 1 s activity
 * sample. A slot with no live holder record but a held lock is an orphaned run, reported as a
 * holder with `orphan: true`. `waiters` are fresh-filtered, the way `run` ranks them.
 */
export function queueSnapshot(dir, deps = {}) {
  const now = deps.now ?? Date.now();
  const spawn = deps.spawn ?? spawnSync;
  const waiters = freshTickets(listTickets(dir, deps.startTimeOf), now).map((t, i) => ({
    ...t,
    rank: i,
    waitedMs: now - (t.enqueuedAt ?? t.createdAt),
  }));
  const recorded = listHolders(dir, deps.startTimeOf);
  let files = [];
  try {
    files = readdirSync(dir).filter((n) => /^slot-\d+$/.test(n));
  } catch {
    /* no such queue */
  }
  const held = new Set(recorded.map((h) => h.slot));
  const budgetEnd = Date.now() + (deps.budgetMs ?? ORPHAN_PROBE_BUDGET_MS);
  const orphans = [];
  for (const name of files) {
    const slot = Number(name.slice("slot-".length));
    if (held.has(slot) || Date.now() > budgetEnd) continue;
    const file = path.join(dir, name);
    if (lockBusy(spawn, file)) orphans.push({ slot, orphan: true, ...(deps.orphanProcess ?? orphanProcess)(file) });
  }
  const found = orphans.filter((o) => o.pid);
  const live = [...recorded.map((h) => ({ ...h, ageMs: now - h.acquiredAt })), ...found];
  const sampled = deps.sample === false ? live : withActivity(live, deps);
  const holders = [...sampled, ...orphans.filter((o) => !o.pid)].sort((a, b) => a.slot - b.slot);
  // Lock files are never deleted, so after a resize they overcount; live records are the truth.
  const slots = Math.max(0, ...[...recorded, ...waiters].map((r) => r.slots ?? 0));
  return slots > 0
    ? { slots, slotsSource: "records", holders, waiters }
    : { slots: files.length, slotsSource: "files", holders, waiters };
}

export const queueStatus = (dir, name, deps = {}) => ({ name, ...queueSnapshot(dir, deps) });

export function allQueues(env, deps = {}) {
  const root = path.join(stateDir(env), `v${PROTOCOL_VERSION}`);
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    names = [];
  }
  return names.sort().map((n) => {
    const q = queueStatus(path.join(root, n), n, deps);
    const slots = envSlots(env, n);
    return slots ? { ...q, slots, slotsSource: "env" } : q;
  });
}

const orNull = (v) => v ?? null;

/** The `status --json` shape the session pane reads: every field always present, null where unknown. */
export function statusJson(queues, env = process.env, deps = {}) {
  const { memTotalKb, memAvailKb } = meminfo(env, deps.readFile);
  return {
    protocol: PROTOCOL_VERSION,
    queues: queues.map((q) => ({
      name: q.name,
      slots: q.slots,
      slotsSource: q.slotsSource,
      holders: q.holders.map((h) => ({
        slot: h.slot,
        pid: orNull(h.pid),
        cwd: orNull(h.cwd),
        command: orNull(h.command),
        ageMs: orNull(h.ageMs),
        state: h.orphan ? "orphan" : (h.state ?? "unknown"),
        cpuPct: orNull(h.cpuPct),
        memKb: orNull(h.memKb),
      })),
      waiters: q.waiters.map((w) => ({
        ticket: w.ticket,
        pid: w.pid,
        cwd: orNull(w.cwd),
        command: orNull(w.command),
        priority: w.priority,
        rank: w.rank,
        waitedMs: w.waitedMs,
      })),
    })),
    machine: {
      cores: deps.cores ?? os.availableParallelism(),
      load1: deps.load1 ?? os.loadavg()[0],
      memAvailKb,
      memTotalKb,
    },
  };
}

const sameCommand = (a, b) => {
  // `bash -c 'x'` and a bare `x` are one run: the mod queues the first, a person types the second.
  const norm = (c) => String(c ?? "").replace(/\s+/g, " ").trim().replace(/^(?:ba)?sh -c /, "");
  return norm(a) === norm(b);
};

/**
 * A live holder or a fresh waiter running `command` from `cwd`, as `{ where, slot | rank, ageMs }`,
 * or null. With `self` (a waiter's own pid and enqueuedAt), only waiters ahead of it count.
 */
export function findDuplicate(dir, { command, cwd }, { self, now = Date.now() } = {}) {
  const holder = listHolders(dir).find((h) => h.cwd === cwd && sameCommand(h.command, command));
  if (holder) return { where: "running", slot: holder.slot, ageMs: now - holder.acquiredAt };
  const waiters = freshTickets(listTickets(dir), now);
  const before = (t) => !self || t.enqueuedAt < self.enqueuedAt || (t.enqueuedAt === self.enqueuedAt && t.pid < self.pid);
  const rank = waiters.findIndex((t) => t.pid !== self?.pid && t.cwd === cwd && sameCommand(t.command, command) && before(t));
  return rank < 0 ? null : { where: "waiting", rank, ageMs: now - waiters[rank].enqueuedAt };
}

export function duplicateNotice(dupe, { queue, command, cwd, tag = "[queue]" }) {
  const place =
    dupe.where === "running"
      ? `already running in slot ${dupe.slot} of the ${queue} queue (${formatAge(dupe.ageMs)})`
      : `already waiting at #${dupe.rank + 1} in the ${queue} queue (${formatAge(dupe.ageMs)})`;
  return (
    `${tag} not starting it twice: "${truncate(command)}" is ${place}, from ${cwd}. ` +
    `Wait for that run's completion notice instead.` +
    (dupe.where === "running" ? ` If it is stale, ask the operator to stop it (queue.mjs stop ${queue} ${dupe.slot}).` : "") +
    "\n"
  );
}

export function statusText(queues, now = Date.now()) {
  if (queues.length === 0) return "no queues yet\n";
  return queues
    .map((q) => {
      const unit = q.slotsSource === "files" ? "slot file(s)" : "slot(s)";
      const lines = [`${q.name}: ${q.slots} ${unit}, ${q.holders.length} held, ${q.waiters.length} waiting`];
      for (const h of q.holders) lines.push(`  ${holderLine(h, now)}`);
      q.waiters.forEach((w, i) => lines.push(`  ${waiterLine(w, i, now)}`));
      return lines.join("\n");
    })
    .join("\n")
    .concat("\n");
}

export function waitNotice({ tag, label, hint, slotCount, waitedMs, rank, holders, now = Date.now() }) {
  const lines = [
    `${tag} waiting for ${label}: all ${slotCount} in use box-wide, you are #${rank + 1} in line` +
      (waitedMs >= 500 ? ` (${Math.round(waitedMs / 1000)}s)` : "") +
      ". This is a queue, not a hang.",
    ...holders.map((h) => `  ${holderLine(h, now)}`),
  ];
  if (hint) lines.push(`  ${hint}`);
  return `${lines.join("\n")}\n`;
}

export const timeoutNotice = ({ tag, label, waitedMs, slotCount }) =>
  `${tag} queue full: gave up waiting for ${label} after ${Math.round(waitedMs / 1000)}s (${slotCount} in use). Not running the command; retry later.\n`;

export function backoffMs(attempt, env = {}) {
  const fixed = Number.parseInt(env[POLL_ENV] ?? "", 10);
  if (fixed > 0) return fixed;
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt);
}

/** Why this run skips the queue, or null. A reason string so the notice can say which. */
export function bypassReason({ env = process.env, hasFlock = true }) {
  if (env.CI) return "CI";
  // Any queue, not just the same one: hold-and-wait across queues could deadlock.
  if (env[HELD_ENV]) return `already holding ${env[HELD_ENV]}`;
  if (!hasFlock) return "flock(1) not available on this platform";
  return null;
}

export function bypassNotice(reason, tag = "[queue]") {
  return `${tag} queue inactive (${reason}), running unguarded.\n`;
}

/** The exit code alone is **not** trusted to mean "slot busy": see `isConflict`. */
export function flockArgs({ slot, nodePath, modulePath, execArgs, command }) {
  return ["-n", "-E", String(CONFLICT_EXIT), slot, nodePath, modulePath, EXEC_FLAG, ...execArgs, "--", ...command];
}

/**
 * A conflict is the exit code **and** silence on `START_FD`: on a real conflict flock never
 * runs exec mode, so its byte is absent. A wrapped command that itself exits with the code
 * would otherwise read as "busy" and be run again, in a loop, until the timeout.
 */
const startedMarker = (result) => (result?.output?.[START_FD]?.length ?? 0) > 0;

export function isConflict(result) {
  return result?.status === CONFLICT_EXIT && !startedMarker(result);
}

/** `status ?? 1` would report an OOM-killed child as an ordinary failure. */
export function exitCodeFor(result, signals = osConstants.signals) {
  if (result?.signal) return 128 + (signals[result.signal] ?? 0);
  return result?.status ?? 1;
}

/** Not `import.meta.url === file://${argv[1]}`: that breaks on a path with a space and exits 0 having done nothing. */
export function isDirectInvocation(entryPath, moduleUrl) {
  return Boolean(entryPath) && fileURLToPath(moduleUrl) === entryPath;
}

export function detectFlock(run = spawnSync) {
  const probe = run("flock", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/** `mkdir -p` succeeds on an existing unwritable dir and flock then exits 66, so check writability. */
export function ensureDir(dir, deps = {}) {
  const mkdir = deps.mkdir ?? ((d) => mkdirSync(d, { recursive: true }));
  const access = deps.access ?? ((d) => accessSync(d, fsConstants.W_OK | fsConstants.X_OK));
  try {
    mkdir(dir);
    access(dir);
    return true;
  } catch {
    return false;
  }
}

function parseFlags(args, spec) {
  const out = {};
  let i = 0;
  for (; i < args.length && args[i] !== "--"; i += 1) {
    const m = /^--([a-z]+)=(.*)$/.exec(args[i]);
    if (!m || !spec.includes(m[1])) return { error: `unknown option ${args[i]}` };
    out[m[1]] = m[2];
  }
  return { flags: out, command: args.slice(i + 1) };
}

export function parseRunArgs(args) {
  const parsed = parseFlags(args, ["queue", "slots", "priority", "timeout"]);
  if (parsed.error) return parsed;
  const { flags, command } = parsed;
  const queue = flags.queue ?? DEFAULT_QUEUE;
  if (!validQueueName(queue)) return { error: `invalid queue name ${queue}` };
  const priority = flags.priority ?? "normal";
  if (!PRIORITIES.includes(priority)) return { error: `priority must be ${PRIORITIES.join(" or ")}` };
  if (command.length === 0) return { error: "no command after --" };
  const minutes = Number.parseFloat(flags.timeout ?? "");
  return {
    queue,
    slots: flags.slots,
    priority,
    timeoutMs: minutes > 0 ? minutes * 60_000 : Infinity,
    command,
  };
}

const USAGE =
  "usage: queue.mjs run [--queue=<name>] [--slots=<n>] [--priority=gate|normal] [--timeout=<minutes>] -- <command...>\n" +
  "       queue.mjs status [--json]\n" +
  "       queue.mjs stop <queue> <slot>\n" +
  "       queue.mjs move <ticket> top|up|down\n";

export function runDirect(command, env, spawn = spawnSync) {
  return exitCodeFor(spawn(command[0], command.slice(1), { stdio: "inherit", env }));
}

const lockFree = (spawn, file) => spawn("flock", ["-n", file, "true"], { stdio: "ignore" }).status === 0;

/**
 * Wait in line, then run `command` under a slot. Returns the exit code: the command's, `TIMEOUT_EXIT` on
 * `timeoutMs`, never an unguarded run once queueing has started. Infra failures run unguarded
 * with a notice, so a scheduler cannot block the work it schedules.
 */
export function run(opts) {
  const {
    queue = DEFAULT_QUEUE,
    slots,
    priority = "normal",
    timeoutMs = Infinity,
    command,
    env = process.env,
    log = (m) => process.stderr.write(m),
    canTake = defaultCanTake(env),
    tag = "[queue]",
    label = `a slot in the ${queue} queue`,
    hint = "",
    spawn = spawnSync,
    hasFlock = detectFlock(spawn),
    ensure = ensureDir,
  } = opts;

  const bypass = bypassReason({ env, hasFlock });
  if (bypass) {
    if (!env.CI) log(bypassNotice(bypass, tag));
    return runDirect(command, env, spawn);
  }
  const dir = queueDir(env, queue);
  // The queue dir holds the slot files: unwritable, flock exits 66 and the gate would fail closed.
  if (![dir, path.join(dir, "tickets"), path.join(dir, "holders")].every((d) => ensure(d))) {
    log(bypassNotice(`${dir} is not writable`, tag));
    return runDirect(command, env, spawn);
  }

  const slotCount = resolveSlots({ flag: slots, env, queue });
  const files = Array.from({ length: slotCount }, (_, i) => path.join(dir, `slot-${i}`));
  const pid = process.pid;
  const self = {
    pid,
    startTime: processStartTime(pid),
    cwd: process.cwd(),
    command: command.join(" "),
    priority,
    slots: slotCount,
    pollMs: pollCeilingMs(env),
    createdAt: Date.now(),
  };
  const ticketFile = path.join(dir, "tickets", `${priority}-${self.createdAt}-${pid}.json`);
  writeJson(ticketFile, self);
  // After the ticket is written, so of two identical runs started together exactly one refuses.
  const dupe = findDuplicate(dir, self, { self: { pid, enqueuedAt: self.createdAt } });
  if (dupe) {
    rmSync(ticketFile, { force: true });
    log(duplicateNotice(dupe, { queue, command: self.command, cwd: self.cwd, tag }));
    return DUPLICATE_EXIT;
  }

  const modulePath = fileURLToPath(import.meta.url);
  const startedAt = Date.now();
  let lastNoticeMs = -NOTICE_INTERVAL_MS;
  try {
    for (let attempt = 0; ; attempt += 1) {
      // The veto can flip between polls (memory recovers), so usable slots are recomputed each pass.
      const mine = files.map((_, i) => i).filter((i) => canTake(i));
      // `move` rewrites our order key on disk, so adopt it; rewrite only when `usable` changed or the
      // ticket vanished, else touch it, so a move landing between our read and our write is not lost.
      const onDisk = readJson(ticketFile);
      if (onDisk?.pid === pid && Number.isFinite(onDisk.createdAt)) self.createdAt = onDisk.createdAt;
      if (!(onDisk?.pid === pid && String(onDisk.usable) === String(mine) && touch(ticketFile))) {
        writeJson(ticketFile, { ...self, usable: mine });
      }
      const others = listTickets(dir).filter((t) => t.pid !== pid);
      const ordered = orderTickets([...freshTickets(others, Date.now()), self]);
      const rank = ordered.findIndex((t) => t.pid === pid);
      const ahead = ordered.slice(0, rank);
      const free = ahead.length ? files.map((_, i) => i).filter((i) => lockFree(spawn, files[i])) : [];
      for (const i of claimableSlots({ ahead, free, mine })) {
        const result = spawn(
          "flock",
          flockArgs({
            slot: files[i],
            nodePath: process.execPath,
            modulePath,
            execArgs: [
              `--holder=${path.join(dir, "holders", `slot-${i}.json`)}`,
              `--ticket=${ticketFile}`,
              `--priority=${priority}`,
              `--slots=${slotCount}`,
              `--lock=${files[i]}`,
            ],
            command,
          }),
          {
            // fd 3 is the pipe exec mode reports its start on; 0-2 stay the caller's.
            stdio: ["inherit", "inherit", "inherit", "pipe"],
            env: { ...env, [HELD_ENV]: `${queue}:${i}` },
          },
        );
        if (result.error) {
          log(bypassNotice(`flock failed to spawn (${result.error.code ?? "unknown"})`, tag));
          return runDirect(command, env, spawn);
        }
        if (!isConflict(result)) {
          // No start marker and a plain failure: flock never ran the command (missing node, bad lock file).
          if (!startedMarker(result) && !result.signal && result.status !== 0) {
            log(bypassNotice(`flock exited ${result.status} before starting the command`, tag));
            return runDirect(command, env, spawn);
          }
          return exitCodeFor(result);
        }
      }

      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= timeoutMs) {
        log(timeoutNotice({ tag, label, waitedMs, slotCount }));
        return TIMEOUT_EXIT;
      }
      if (waitedMs - lastNoticeMs >= NOTICE_INTERVAL_MS) {
        log(waitNotice({ tag, label, hint, slotCount, waitedMs, rank, holders: withActivity(listHolders(dir)) }));
        lastNoticeMs = waitedMs;
      }
      sleepSync(Math.min(backoffMs(attempt, env), timeoutMs - waitedMs));
    }
  } finally {
    rmSync(ticketFile, { force: true });
  }
}

function touch(file) {
  try {
    const now = new Date();
    utimesSync(file, now, now);
    return true;
  } catch {
    return false;
  }
}

/** The fd number flock opened the lock file on, found by what /proc says it points at. */
export function findLockFd(lockPath, deps = {}) {
  const list = deps.list ?? (() => readdirSync("/proc/self/fd"));
  const link = deps.link ?? ((fd) => readlinkSync(`/proc/self/fd/${fd}`));
  try {
    const target = (deps.real ?? realpathSync)(lockPath);
    const fd = list().map(Number).find((n) => n > 2 && safeLink(link, n) === target);
    return fd ?? null;
  } catch {
    return null;
  }
}

function safeLink(link, fd) {
  try {
    return link(fd);
  } catch {
    return null;
  }
}

/** Child stdio that inherits 0-2 and the lock fd at its own number, so the lock lives as long as the command. */
export function childStdio(lockFd) {
  if (lockFd === null) return "inherit";
  return Array.from({ length: lockFd + 1 }, (_, i) => (i < 3 ? "inherit" : i === lockFd ? lockFd : "ignore"));
}

const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

export async function execUnderLock(args, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const signals = deps.signals ?? process;
  const writeMarker = deps.writeMarker ?? (() => writeSync(START_FD, "1"));
  const parsed = parseFlags(args, ["holder", "ticket", "priority", "slots", "lock"]);
  if (parsed.error || parsed.command.length === 0) return 2;
  const { flags, command } = parsed;
  try {
    writeMarker();
  } catch {
    /* hand-run, no fd 3: the command still runs */
  }
  // Holder first, then ticket: a duplicate check between the two must see one of them.
  if (flags.holder) {
    writeJson(flags.holder, {
      pid: process.pid,
      startTime: processStartTime(process.pid),
      cwd: process.cwd(),
      command: command.join(" "),
      priority: flags.priority ?? "normal",
      slots: Number(flags.slots) || 1,
      acquiredAt: Date.now(),
    });
  }
  if (flags.ticket) rmSync(flags.ticket, { force: true });
  // If this wrapper is SIGKILLed the slot must stay held while the command runs, so the command
  // gets its own copy of the lock fd. Where the fd cannot be found the lock dies with the wrapper.
  const lockFd = flags.lock ? (deps.lockFd ?? findLockFd)(flags.lock) : null;
  try {
    return await new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { stdio: childStdio(lockFd) });
      const forwarders = FORWARDED_SIGNALS.map((sig) => [sig, () => child.kill(sig)]);
      for (const [sig, fn] of forwarders) signals.on(sig, fn);
      const done = (code) => {
        for (const [sig, fn] of forwarders) signals.off(sig, fn);
        resolve(code);
      };
      child.on("error", () => done(1));
      child.on("exit", (status, signal) => done(exitCodeFor({ status, signal })));
    });
  } finally {
    if (flags.holder && readJson(flags.holder)?.pid === process.pid) rmSync(flags.holder, { force: true });
  }
}

/** Running and not a zombie, with the start time it had when first seen. */
function stillRunning(pid, startTime, readFile = readText) {
  try {
    const stat = readFile(`/proc/${pid}/stat`);
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z" && processStartTime(pid, readFile) === startTime;
  } catch {
    return false;
  }
}

/**
 * SIGTERM to a slot holder's whole process tree, then SIGKILL to what is left after `graceMs`.
 * The tree is read once, before any signal: a child whose parent died is reparented and lost.
 */
export function stopSlot(env, queue, slot, { graceMs = STOP_GRACE_MS, kill = process.kill, spawn = spawnSync } = {}) {
  if (!validQueueName(queue) || !/^\d+$/.test(String(slot))) return { ok: false, reason: `invalid queue or slot ${queue} ${slot}` };
  const dir = queueDir(env, queue);
  const holder = listHolders(dir).find((h) => h.slot === Number(slot));
  const lock = path.join(dir, `slot-${slot}`);
  // An orphaned slot has no record: every process still holding its lock is the run.
  const roots = holder ? [holder.pid] : existsSync(lock) && lockBusy(spawn, lock) ? lockHolders(lock) : [];
  if (roots.length === 0) return { ok: false, reason: `no live holder in slot ${slot} of ${queue}` };
  const snap = snapshotProc();
  const pids = new Set(roots.flatMap((r) => treePids(snap, r) ?? [r]));
  const tree = [...pids].map((pid) => [pid, processStartTime(pid)]);
  const signal = (sig, list) => {
    for (const [pid] of list) {
      try {
        kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  const left = () => tree.filter(([pid, start]) => start !== null && stillRunning(pid, start));
  signal("SIGTERM", tree);
  for (const end = Date.now() + graceMs; left().length > 0 && Date.now() < end; ) sleepSync(100);
  const stubborn = left();
  signal("SIGKILL", stubborn);
  return { ok: true, stopped: tree.length, killed: stubborn.length };
}

const MOVES = ["top", "up", "down"];

/**
 * Moves a waiter within its priority by rewriting the order keys (`createdAt`) of the tickets
 * whose place changed. Each write is an atomic rename, and only over a ticket that still exists,
 * so a waiter that just took its slot is not brought back.
 */
export function moveTicket(env, ticket, where) {
  if (!MOVES.includes(where)) return { ok: false, reason: `where must be ${MOVES.join(", ")}` };
  const root = path.join(stateDir(env), `v${PROTOCOL_VERSION}`);
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    /* no queues */
  }
  const name = TICKET_NAME.test(`${ticket}.json`)
    ? names.find((n) => validQueueName(n) && statSafe(path.join(root, n, "tickets", `${ticket}.json`)))
    : undefined;
  if (!name) return { ok: false, reason: `no waiting ticket ${ticket}` };
  const dir = path.join(root, name);
  const all = freshTickets(listTickets(dir), Date.now());
  const mine = all.find((t) => t.ticket === ticket);
  if (!mine) return { ok: false, reason: `no waiting ticket ${ticket}` };
  const line = all.filter((t) => t.priority === mine.priority);
  const at = line.indexOf(mine);
  const toward = where === "down" ? 1 : -1;
  if (at === (toward < 0 ? 0 : line.length - 1)) {
    // At the end of its own priority already: a step further would cross into another one.
    const other = all[all.indexOf(mine) + toward];
    if (other && toward < 0) return { ok: false, reason: `a ${mine.priority} run can't pass a ${other.priority} run` };
    if (other) return { ok: false, reason: `a ${mine.priority} run can't drop behind a ${other.priority} run` };
    return { ok: true, note: toward < 0 ? "already at the top" : "already at the bottom" };
  }
  const keys = line.map((t) => t.createdAt);
  const order = line.filter((t) => t !== mine);
  order.splice(where === "top" ? 0 : where === "up" ? at - 1 : at + 1, 0, mine);
  let last = -Infinity;
  order.forEach((t, i) => {
    // Strictly increasing, so equal keys never fall back to the pid tiebreak.
    const key = keys[i] > last ? keys[i] : last + 0.001;
    last = key;
    if (key === t.createdAt) return;
    const file = path.join(dir, "tickets", `${t.ticket}.json`);
    const onDisk = readJson(file);
    if (onDisk && statSafe(file)) writeJson(file, { ...onDisk, createdAt: key });
  });
  return { ok: true };
}

function statSafe(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function main(argv, env, log, out = (m) => process.stdout.write(m)) {
  const [sub, ...rest] = argv;
  if (sub === EXEC_FLAG) return execUnderLock(rest);
  if (sub === "status") {
    const queues = allQueues(env);
    out(rest.includes("--json") ? `${JSON.stringify(statusJson(queues, env), null, 2)}\n` : statusText(queues));
    return 0;
  }
  if ((sub === "stop" || sub === "move") && rest.length === 2) {
    const result = sub === "stop" ? stopSlot(env, rest[0], rest[1]) : moveTicket(env, rest[0], rest[1]);
    out(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  if (sub === "run") {
    const parsed = parseRunArgs(rest);
    if (parsed.error) {
      log(`${parsed.error}\n${USAGE}`);
      return 2;
    }
    return run({ ...parsed, env, log });
  }
  log(USAGE);
  return 2;
}

/* c8 ignore start -- process-level wiring */
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  Promise.resolve(main(process.argv.slice(2), process.env, (m) => process.stderr.write(m))).then((code) =>
    process.exit(code),
  );
}
/* c8 ignore stop */
