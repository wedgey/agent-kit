import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { codeOnly, commandSegments, segments, shellBodies } from "../../skills/conductor/tools/hooks/shell.mjs";

describe("segments", () => {
  it("ignores operators inside quotes and after escapes", () => {
    expect(segments(String.raw`a "b; c" && d \; e | f`)).toEqual([`a "b; c"`, String.raw`d \; e`, "f"]);
  });

  it("splits on newlines outside quotes only", () => {
    expect(segments(`cd x\npnpm test`)).toEqual(["cd x", "pnpm test"]);
    expect(segments(`echo "a\nb"`)).toEqual([`echo "a\nb"`]);
  });
});

describe("commandSegments", () => {
  it("drops heredoc bodies", () => {
    expect(commandSegments("cat <<EOF\ntsc\nEOF\nls")).toEqual(["cat <<EOF", "ls"]);
  });
});

describe("codeOnly", () => {
  it("empties quotes, drops heredocs and maps newlines to separators", () => {
    expect(codeOnly(`echo "a\\"b" 'c'\nx \\y\ncat <<-E\nbody\nE\nz`)).toBe(`echo "" '';x  ;cat <<-E;z`);
  });
});

describe("heredoc detection", () => {
  it("ignores here-strings and arithmetic shifts", () => {
    expect(commandSegments("cat <<<x\nls")).toEqual(["cat <<<x", "ls"]);
    expect(commandSegments("echo $((1<<2))\nls")).toEqual(["echo $((1<<2))", "ls"]);
  });
});

describe("comments", () => {
  it("drops a comment so its apostrophe opens no quote", () => {
    expect(codeOnly("# don't\nls #x\necho a#b")).toBe(";ls ;echo a#b");
  });
});

describe("shellBodies", () => {
  it("returns the quoted body of sh -c, bash -lc and zsh -c", () => {
    expect(shellBodies(`timeout 5 bash -c 'a b' && sh -lc "c \\" d" && zsh -c 'e'`)).toEqual(["a b", 'c " d', "e"]);
    expect(shellBodies("echo bash -c")).toEqual([]);
  });
});
