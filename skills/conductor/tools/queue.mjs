#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * A box-wide FIFO-plus-priority queue in front of heavy commands, on flock(1).
 * Zero dependencies, Node built-ins only; safe to copy verbatim into another repo.
 *
 *   queue.mjs run [--queue=<name>] [--slots=<n>] [--priority=gate|normal] [--timeout=<minutes>] -- <command...>
 *   queue.mjs status [--json]
 *
 * State lives under `<stateDir>/v1/<queue>/`:
 *   slot-<i>                  flock lock file; the kernel frees it when the holder dies
 *   holders/slot-<i>.json     who holds it
 *   tickets/<prio>-<ms>-<pid>.json   who is waiting
 */

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
  accessSync,
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
export const DEFAULT_QUEUE = "default";
export const PRIORITIES = ["gate", "normal"];
export const EXEC_FLAG = "--exec";
export const START_FD = 3;
export const CONFLICT_EXIT = 200;
/** `--timeout` expired. Not 75 (EX_TEMPFAIL), which wrappers may use. */
export const TIMEOUT_EXIT = 76;
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

export function resolveSlots({ flag, env = process.env, queue }) {
  const positive = (v) => {
    const n = Number.parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const envName = SLOTS_ENV_PREFIX + queue.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return positive(flag) ?? positive(env[envName]) ?? 1;
}

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
      live.push({ ...fromName, ...parsed, mtimeMs: statSync(file).mtimeMs });
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

export function treeTicks(snapshot, root) {
  if (!snapshot?.has(root)) return null;
  let total = 0;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.pop();
    total += snapshot.get(pid).ticks;
    for (const [child, info] of snapshot) {
      if (info.ppid === pid && !seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
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

export function withActivity(holders, { proc, sleep = sleepSync, gapMs = IDLE_SAMPLE_GAP_MS } = {}) {
  if (holders.length === 0) return [];
  const a = snapshotProc(proc);
  sleep(gapMs);
  const b = snapshotProc(proc);
  return holders.map((h) => ({ ...h, state: activity(treeTicks(a, h.pid), treeTicks(b, h.pid)) }));
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
  if (h.orphan) return `slot ${h.slot}: held (no record; orphaned run)`;
  return `slot ${h.slot}: ${h.state ?? "unknown"}, ${formatAge(now - h.acquiredAt)}, ${h.cwd}, ${truncate(h.command)}`;
}

export function waiterLine(t, rank, now = Date.now()) {
  return `#${rank + 1} ${t.priority}: ${formatAge(now - t.createdAt)}, ${t.cwd}, ${truncate(t.command)}`;
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
    waitedMs: now - t.createdAt,
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
    if (lockBusy(spawn, path.join(dir, name))) orphans.push({ slot, orphan: true });
  }
  const sampled = deps.sample === false ? recorded : withActivity(recorded, deps);
  const holders = [...sampled.map((h) => ({ ...h, ageMs: now - h.acquiredAt })), ...orphans].sort(
    (a, b) => a.slot - b.slot,
  );
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
  return names.sort().map((n) => queueStatus(path.join(root, n), n, deps));
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
  "       queue.mjs status [--json]\n";

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
    canTake = () => true,
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

  const modulePath = fileURLToPath(import.meta.url);
  const startedAt = Date.now();
  let lastNoticeMs = -NOTICE_INTERVAL_MS;
  try {
    for (let attempt = 0; ; attempt += 1) {
      // The veto can flip between polls (memory recovers), so usable slots are recomputed each pass.
      const mine = files.map((_, i) => i).filter((i) => canTake(i));
      // Rewriting, not touching, so a deleted ticket comes back and others see our usable slots.
      writeJson(ticketFile, { ...self, usable: mine });
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
  if (flags.ticket) rmSync(flags.ticket, { force: true });
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

export function main(argv, env, log, out = (m) => process.stdout.write(m)) {
  const [sub, ...rest] = argv;
  if (sub === EXEC_FLAG) return execUnderLock(rest);
  if (sub === "status") {
    const queues = allQueues(env);
    out(rest.includes("--json") ? `${JSON.stringify({ protocol: PROTOCOL_VERSION, queues }, null, 2)}\n` : statusText(queues));
    return 0;
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
