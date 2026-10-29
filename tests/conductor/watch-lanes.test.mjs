import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { lookAtLanes, turnState, watchLanes } from "../../skills/conductor/tools/watch-lanes.mjs";

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

  it("skips entries with no message and lines that are not JSON", () => {
    expect(turnState([said(tool), got(result), noise, "{broken"].join("\n"))).toBe("owes-reply");
    expect(turnState("")).toBe("unknown");
  });
});

describe("looking at lanes", () => {
  function lane(lines, minutesAgo) {
    const file = join(mkdtempSync(join(tmpdir(), "watch-lanes-")), "lane-a.output");
    writeFileSync(file, lines.join("\n") + "\n");
    const when = (Date.now() - minutesAgo * 60_000) / 1000;
    utimesSync(file, when, when);
    return file;
  }

  it("reports a lane quiet past the limit mid-turn, and names its state", () => {
    const look = lookAtLanes([lane([said(tool), got(result)], 20)], 15);
    expect(look()).toEqual([{ event: "stalled", lane: "lane-a", state: "owes-reply", quietMinutes: 20 }]);
  });

  it("leaves a lane alone that is quiet because its turn ended, or that is quiet for less than the limit", () => {
    expect(lookAtLanes([lane([got(result), said(text)], 300)], 15)()).toEqual([]);
    expect(lookAtLanes([lane([said(tool), got(result)], 5)], 15)()).toEqual([]);
  });

  it("reports a lane whose transcript is gone", () => {
    expect(lookAtLanes(["/nope/lane-b.output"], 15)()).toEqual([{ event: "gone", lane: "lane-b" }]);
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
