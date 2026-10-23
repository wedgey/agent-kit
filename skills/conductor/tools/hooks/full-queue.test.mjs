import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { processStartTime } from "../queue.mjs";
import { fullQueueReason, readQueueStatus } from "./full-queue.mjs";

const classify = (s) => (s.startsWith("heavy") ? "q" : null);
const held = { cwd: "/w/lane-a", acquiredAt: 0, slot: 0 };
const status = (over) => () => ({ slots: 1, holders: [], waiters: [], ...over });

describe("fullQueueReason", () => {
  it("denies when every slot is held, naming holder and age", () => {
    const r = fullQueueReason("heavy x", false, status({ holders: [held] }), classify, { now: 125_000 });
    expect(r).toMatch(/lane-a \(2m05s\)/);
    expect(r).toMatch(/run_in_background/);
  });

  it("denies when someone is waiting even with a free slot", () => {
    expect(fullQueueReason("heavy", false, status({ slots: 2, waiters: [{}] }), classify)).toMatch(/full/);
  });

  it("allows a free queue", () => {
    expect(fullQueueReason("heavy", false, status({ slots: 2, holders: [held] }), classify)).toBeNull();
  });

  it("always allows a background run", () => {
    expect(fullQueueReason("heavy", true, status({ holders: [held] }), classify)).toBeNull();
  });

  it("allows commands the classifier does not know", () => {
    expect(fullQueueReason("ls && echo 'heavy'", false, status({ holders: [held] }), classify)).toBeNull();
  });

  it("allows when the status is unknown", () => {
    expect(fullQueueReason("heavy", false, () => null, classify)).toBeNull();
  });

  it("denies when the only free slot is one the memory floor refuses", () => {
    const q = status({ slots: 2, holders: [held] });
    expect(fullQueueReason("heavy", false, q, classify, { admits: (i) => i === 0 })).toMatch(/full/);
    expect(fullQueueReason("heavy", false, q, classify, { admits: () => true })).toBeNull();
  });

  it("sees a heavy command on a later line", () => {
    expect(fullQueueReason("cd apps/web\nheavy", false, status({ holders: [held] }), classify)).toMatch(/full/);
  });

  it("finds a heavy segment after another", () => {
    expect(fullQueueReason("cd x && heavy", false, status({ holders: [held] }), classify)).toMatch(/"q"/);
  });
});

describe("orphaned slots", () => {
  it("reports a locked slot with no live record as held, and denies on it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hooks-"));
    const q = path.join(dir, "v1", "q");
    mkdirSync(q, { recursive: true });
    writeFileSync(path.join(q, "slot-0"), "");
    const spawn = () => ({ status: 1 });
    const s = readQueueStatus({ CONDUCTOR_QUEUE_DIR: dir }, "q", 1, { spawn });
    expect(s.holders).toEqual([{ slot: 0, orphan: true }]);
    expect(fullQueueReason("heavy", false, () => s, classify)).toMatch(/orphaned run/);
  });

  it("uses the caller's slot count", () => {
    const env = { CONDUCTOR_QUEUE_DIR: mkdtempSync(path.join(os.tmpdir(), "hooks-")) };
    expect(readQueueStatus(env, "none", 3).slots).toBe(3);
  });
});

describe("waiter freshness", () => {
  it("counts a fresh ticket and drops one that stopped polling", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hooks-"));
    const tickets = path.join(dir, "v1", "q", "tickets");
    mkdirSync(tickets, { recursive: true });
    const waiter = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const file = path.join(tickets, `normal-1-${waiter.pid}.json`);
      writeFileSync(file, JSON.stringify({ pid: waiter.pid, startTime: processStartTime(waiter.pid) }));
      const read = () => readQueueStatus({ CONDUCTOR_QUEUE_DIR: dir }, "q", 2, {}).waiters;
      expect(read().map((t) => t.pid)).toEqual([waiter.pid]);
      utimesSync(file, 1, 1);
      expect(read()).toEqual([]);
    } finally {
      waiter.kill();
    }
  });
});

describe("readQueueStatus", () => {
  it("reads holders and waiters from the state dir", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hooks-"));
    const env = { CONDUCTOR_QUEUE_DIR: dir };
    const q = path.join(dir, "v1", "q");
    mkdirSync(path.join(q, "holders"), { recursive: true });
    writeFileSync(
      path.join(q, "holders", "slot-0.json"),
      JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid), cwd: "/w/x", acquiredAt: 1 }),
    );
    const s = readQueueStatus(env, "q", 2, {});
    expect(s.slots).toBe(2);
    expect(s.holders.map((h) => h.cwd)).toEqual(["/w/x"]);
    expect(readQueueStatus(env, "missing", 1, {})).toMatchObject({ slots: 1, holders: [], waiters: [] });
  });
});
