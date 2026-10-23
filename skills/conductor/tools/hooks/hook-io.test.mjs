import { describe, expect, it } from "vitest";

import { bypassed, denyOutput } from "./hook-io.mjs";

describe("denyOutput", () => {
  it("builds a PreToolUse deny with the reason", () => {
    const out = denyOutput("why").hookSpecificOutput;
    expect([out.permissionDecision, out.permissionDecisionReason]).toEqual(["deny", "why"]);
  });
});

describe("bypassed", () => {
  it.each([
    ["ls", {}, false],
    ["ls", { CI: "1" }, true],
    ["ls", { X: "off" }, true],
    ["ls", { X: "on" }, false],
    ["X=off ls", {}, true],
  ])("%s with %j is %s", (command, env, expected) => {
    expect(bypassed(command, env, "X")).toBe(expected);
  });
});
