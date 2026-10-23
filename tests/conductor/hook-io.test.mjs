import { describe } from "node:test";
import { each, expect } from "./expect.mjs";

import { bypassed } from "../../skills/conductor/tools/hooks/hook-io.mjs";

describe("bypassed", () => {
  each([
    ["ls", {}, false],
    ["ls", { CI: "1" }, true],
    ["ls", { X: "off" }, true],
    ["ls", { X: "on" }, false],
    ["X=off ls", {}, true],
  ])("%s with %j is %s", (command, env, expected) => {
    expect(bypassed(command, env, "X")).toBe(expected);
  });
});
