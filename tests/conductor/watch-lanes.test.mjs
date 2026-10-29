import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { lastEntryState, lookAtLanes, turnState, watchLanes } from "../../skills/conductor/tools/watch-lanes.mjs";

const said = (...blocks) => JSON.stringify({ type: "assistant", message: { content: blocks } });
const got = (...blocks) => JSON.stringify({ type: "user", message: { content: blocks } });
const text = { type: "text", text: "done" };
const tool = { type: "tool_use", name: "Bash", input: {} };
const result = { type: "tool_result", content: "ok" };
const noise = JSON.stringify({ type: "progress" });

describe("a lane's turn state, from the tail of its transcript", () => {
  it("owes a reply after a tool result or a message, which is where a stalled stream sits", () => {
    expect(turnState([said(tool), got(result)].join("\n"))).toBe("owes-reply");
    expect(turnState([said(text), got({ type: "text", text: "resume" })].join("\n"))).toBe("owes-reply");
  });

  it("is running a tool after a tool call, and has ended its turn after text alone", () => {
    expect(turnState([got(result), said(tool)].join("\n"))).toBe("tool-running");
    expect(turnState([got(result), said(text)].join("\n"))).toBe("turn-ended");
  });

  it("has ended its turn after handing its report back, or after the operator interrupted it", () => {
    const handback = { type: "tool_use", id: "h1", name: "SubagentHandback", input: {} };
    expect(turnState([said(handback), got({ type: "tool_result", tool_use_id: "h1", content: "Report delivered" })].join("\n"))).toBe("turn-ended");
    expect(turnState([said(tool), got({ type: "text", text: "[Request interrupted by user]" })].join("\n"))).toBe("turn-ended");
  });

  it("is mid-turn after thinking alone, which never ends a turn", () => {
    expect(turnState([got(result), said({ type: "thinking", thinking: "hm" })].join("\n"))).toBe("owes-reply");
  });

  it("skips entries with no message and lines that are not JSON", () => {
    expect(turnState([said(tool), got(result), noise, "{broken"].join("\n"))).toBe("owes-reply");
    expect(turnState("")).toBe("unknown");
  });
});

describe("reading a lane's last entry", () => {
  it("widens the read until an entry with a message fits, so one huge entry cannot hide the state", () => {
    const file = join(mkdtempSync(join(tmpdir(), "watch-lanes-")), "lane-a.output");
    const huge = JSON.stringify({ type: "api-request-blob", body: "x".repeat(600_000) });
    writeFileSync(file, [said(tool), got(result), huge].join("\n") + "\n");
    expect(lastEntryState(file, 1024)).toBe("owes-reply");
  });

  it("judges only the bytes the look found unchanged, not a write that lands during the look", () => {
    const file = join(mkdtempSync(join(tmpdir(), "watch-lanes-")), "lane-a.output");
    const before = [said(tool), got(result)].join("\n") + "\n";
    writeFileSync(file, before + said(text) + "\n");
    expect(lastEntryState(file, 1024, Buffer.byteLength(before))).toBe("owes-reply");
  });
});

describe("looking at lanes, on the watch's own clock", () => {
  const file = (lines) => {
    const path = join(mkdtempSync(join(tmpdir(), "watch-lanes-")), "lane-a.output");
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  };
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (minutes) => (t += minutes * 60_000) };
  };
  const minute = 60_000;
  const box = () => ({ load1: 1, cores: 8, freeMB: 9000 });

  it("reports a lane mid-turn once the watch has seen it unchanged for the quiet limit", () => {
    const c = clock();
    const look = lookAtLanes([file([said(tool), got(result)])], { quietMinutes: 3, intervalMs: minute, now: c.now, box });
    expect(look()).toEqual([]);
    c.advance(1);
    expect(look()).toEqual([]);
    c.advance(1);
    expect(look()).toEqual([]);
    c.advance(1);
    expect(look()).toEqual([{ event: "stalled", lane: "lane-a", state: "owes-reply", quietMinutes: 3, box: box() }]);
  });

  it("blames the box, not the lanes, when two or more go quiet in the same look", () => {
    const c = clock();
    const stuck = [said(tool), got(result)];
    const look = lookAtLanes([file(stuck), file(stuck)], { quietMinutes: 1, intervalMs: minute, now: c.now, box });
    look();
    c.advance(1);
    expect(look()).toEqual([{ event: "box-slow", lanes: ["lane-a", "lane-a"], box: box() }]);
  });

  it("gives a tool call three times the quiet limit, because healthy foreground calls ran past it", () => {
    const c = clock();
    const look = lookAtLanes([file([got(result), said(tool)])], { quietMinutes: 3, intervalMs: minute, now: c.now, box });
    for (let i = 0; i < 9; i++) {
      expect(look()).toEqual([]);
      c.advance(1);
    }
    expect(look()).toEqual([{ event: "stalled", lane: "lane-a", state: "tool-running", quietMinutes: 9, box: box() }]);
  });

  it("leaves a lane alone that ended its turn, however long it waits", () => {
    const c = clock();
    const look = lookAtLanes([file([got(result), said(text)])], { quietMinutes: 1, intervalMs: minute, now: c.now });
    for (let i = 0; i < 5; i++) {
      expect(look()).toEqual([]);
      c.advance(1);
    }
  });

  it("starts counting again after a long gap between looks, so a sleeping machine reports no lane on waking", () => {
    const c = clock();
    const look = lookAtLanes([file([said(tool), got(result)])], { quietMinutes: 3, intervalMs: minute, now: c.now });
    look();
    c.advance(120);
    expect(look()).toEqual([]);
    c.advance(1);
    expect(look()).toEqual([]);
  });

  it("reports a transcript that vanished, and one that never appeared within the quiet limit", () => {
    const c = clock();
    const look = lookAtLanes(["/nope/lane-b.output"], { quietMinutes: 2, intervalMs: minute, now: c.now });
    expect(look()).toEqual([]);
    c.advance(1);
    expect(look()).toEqual([]);
    c.advance(1);
    expect(look()).toEqual([{ event: "gone", lane: "lane-b" }]);
  });
});

describe("the lane watch", () => {
  it("returns the first look that finds something", async () => {
    const looks = [[], [], [{ event: "stalled", lane: "x" }]];
    let slept = 0;
    const out = await watchLanes({ look: () => looks.shift(), sleep: async () => slept++, maxLooks: 10 });
    expect(out).toEqual({ events: [{ event: "stalled", lane: "x" }] });
    expect(slept).toBe(2);
  });

  it("times out when every look is quiet", async () => {
    expect(await watchLanes({ look: () => [], sleep: async () => {}, maxLooks: 3 })).toEqual({ events: [{ event: "timeout" }] });
  });

  it("gives up after repeated failed looks", async () => {
    const out = await watchLanes({ look: () => { throw new Error("disk\nmore"); }, sleep: async () => {}, maxLooks: 10, maxErrors: 2 });
    expect(out).toEqual({ events: [{ event: "watch-error", message: "disk" }] });
  });
});
