import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { events, snapshot, watch } from "../../skills/conductor/tools/watch-pr.mjs";

const run = (name, conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion });
const ctx = (context, state) => ({ __typename: "StatusContext", context, state });
const pr = (over = {}) => ({
  state: "OPEN",
  mergeable: "MERGEABLE",
  baseRefName: "main",
  headRefOid: "aaa",
  statusCheckRollup: [run("unit", "SUCCESS"), run("lint", "SKIPPED")],
  comments: [],
  reviews: [],
  ...over,
});
const snap = (over = {}, base = null) => snapshot(pr(over), base);

describe("the PR snapshot", () => {
  it("reads failing and pending checks from check runs and status contexts", () => {
    const s = snap({ statusCheckRollup: [run("unit", "FAILURE"), run("e2e", null, "IN_PROGRESS"), ctx("mergify", "ERROR"), ctx("deploy", "PENDING"), run("docs", "SUCCESS")] });
    expect(s.failing).toEqual(["mergify", "unit"]);
    expect(s.pending).toBe(2);
  });

  it("counts comments and reviews together, and keeps the base PR's state and head", () => {
    const s = snap({ comments: [{}, {}], reviews: [{}] }, { state: "OPEN", headRefOid: "bbb" });
    expect([s.talk, s.baseState, s.baseHead]).toEqual([3, "OPEN", "bbb"]);
    expect(snap().baseState).toBeNull();
  });
});

describe("the events between two snapshots", () => {
  it("reports nothing when nothing moved", () => {
    expect(events(snap(), snap())).toEqual([]);
  });

  it("reports a merge or a close, and nothing else with it", () => {
    expect(events(snap(), snap({ state: "MERGED", statusCheckRollup: [run("unit", "FAILURE")] }))).toEqual(["merged"]);
    expect(events(snap(), snap({ state: "CLOSED" }))).toEqual(["closed"]);
  });

  it("reports only checks that newly failed, and green once the last pending check passes", () => {
    const red = snap({ statusCheckRollup: [run("unit", "FAILURE"), run("e2e", "FAILURE")] });
    expect(events(snap({ statusCheckRollup: [run("unit", "FAILURE"), run("e2e", null, "QUEUED")] }), red)).toEqual(["check-failed: e2e"]);
    expect(events(snap({ statusCheckRollup: [run("unit", null, "IN_PROGRESS")] }), snap())).toEqual(["checks-green"]);
  });

  it("reports a conflict, a new comment or review, and a push by someone else", () => {
    expect(events(snap(), snap({ mergeable: "CONFLICTING" }))).toEqual(["conflict"]);
    expect(events(snap(), snap({ reviews: [{}] }))).toEqual(["new-review"]);
    expect(events(snap(), snap({ headRefOid: "ccc" }))).toEqual(["head-moved"]);
  });

  it("reports the base PR merging, moving, or the base branch changing", () => {
    const open = snap({ baseRefName: "feat/a" }, { state: "OPEN", headRefOid: "b1" });
    expect(events(open, snap({ baseRefName: "feat/a" }, { state: "MERGED", headRefOid: "b1" }))).toEqual(["base-merged"]);
    expect(events(open, snap({ baseRefName: "feat/a" }, { state: "OPEN", headRefOid: "b2" }))).toEqual(["base-moved"]);
    expect(events(open, snap({ baseRefName: "main" }))).toEqual(["base-changed: main"]);
  });

  it("takes the first look as the baseline, because the lane read that state before it started the watch", () => {
    expect(events(null, snap())).toEqual([]);
    expect(events(null, snap({ mergeable: "CONFLICTING", statusCheckRollup: [run("ci-pass", "FAILURE")] }))).toEqual([]);
    expect(events(null, snap({ state: "MERGED" }))).toEqual(["merged"]);
  });

  it("does not report a check that was already red, such as a draft's required check", () => {
    const draft = snap({ statusCheckRollup: [run("ci-pass", "FAILURE"), run("unit", null, "IN_PROGRESS")] });
    expect(events(draft, snap({ statusCheckRollup: [run("ci-pass", "FAILURE"), run("unit", "SUCCESS")] }))).toEqual([]);
  });
});

describe("the watch loop", () => {
  const looks = (...prs) => {
    let i = 0;
    return async () => {
      const next = prs[Math.min(i++, prs.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    };
  };
  const noSleep = async () => {};

  it("returns the first change, with the snapshot it saw", async () => {
    const out = await watch({ look: looks(snap(), snap(), snap({ state: "MERGED" })), sleep: noSleep, maxLooks: 10 });
    expect(out.events).toEqual(["merged"]);
    expect(out.snapshot.state).toBe("MERGED");
  });

  it("gives up after too many failed looks in a row, and after its last look", async () => {
    const boom = new Error("gh: HTTP 502");
    expect((await watch({ look: looks(snap(), boom, boom, boom), sleep: noSleep, maxLooks: 10, maxErrors: 3 })).events).toEqual(["watch-error: gh: HTTP 502"]);
    expect((await watch({ look: looks(snap(), boom, snap()), sleep: noSleep, maxLooks: 10, maxErrors: 3 })).events).toEqual(["timeout"]);
    expect((await watch({ look: looks(snap()), sleep: noSleep, maxLooks: 3 })).events).toEqual(["timeout"]);
  });
});
