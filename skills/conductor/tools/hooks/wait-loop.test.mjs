import { describe, expect, it } from "vitest";

import { waitLoopReason } from "./wait-loop.mjs";

const DENY = [
  "until grep -q x f; do sleep 20; done",
  "while ! test -f /tmp/x; do sleep 5; done",
  "while true; do\n  gh pr checks 1\n  sleep 30\ndone",
  "for i in $(seq 1 60); do curl -s localhost:3000 && break; sleep 2; done",
  "for i in 1 2 3; do sleep 10; done",
  "until [ -f x ]; do sleep 1; done && echo ready",
  "cd app && until pgrep vite; do sleep 3; done",
  "sleep 60 && gh run view 1",
  "sleep 30; cat out.log",
  "sleep 2m && ls",
  "echo start; sleep 45 && tail log",
  "while :; do sleep 0.5; done",
  "timeout 120 bash -c 'until curl -s localhost; do sleep 1; done'",
  `sh -c "while true; do sleep 5; done"`,
  "# wait don't stop\nwhile true; do sleep 5; done",
  "gh run rerun 1 && sleep 300",
  'I=5; until test -f x; do sleep "$I"; done',
  "gh pr checks 12 --watch",
  "gh run watch 123 && echo done",
  "watch -n 5 gh pr status",
  "timeout 600 tail -f out.log | grep -m1 ready",
  "tail -F out.log | grep -m 1 ready",
];

const ALLOW = [
  "ls",
  "sleep 1",
  "sleep 2 && ls",
  "sleep 60",
  "echo 'until x; do sleep 5; done'",
  'git commit -m "wait: while true; do sleep 5; done"',
  "cat <<'EOF'\nuntil x; do sleep 5; done\nEOF",
  "cat <<EOF > f.sh\nsleep 60\nEOF\nls",
  "for f in *.ts; do echo $f; done",
  "while read l; do echo $l; done < f",
  "grep -rn sleep src",
  "echo 'sleep 60' && ls",
  "sleep; ls",
  "cat <<<'sleep 60' && ls",
  "echo $((1<<2)); for f in a; do echo $f; done; sleep 1",
  "echo 'don'\\''t' # sleep 60\nls",
  "sleep $N && ls",
  "for f in a b; do echo $f; done; sleep 1; for g in c; do echo $g; done",
  "tail -n 20 out.log | grep error",
  "git log --grep watch",
];

describe("waitLoopReason", () => {
  it.each(DENY)("denies %j", (command) => {
    expect(waitLoopReason(command, false)).toMatch(/run_in_background/);
  });

  it.each(ALLOW)("allows %j", (command) => {
    expect(waitLoopReason(command, false)).toBeNull();
  });

  it("allows anything already run in the background", () => {
    expect(waitLoopReason("until grep -q x f; do sleep 20; done", true)).toBeNull();
    expect(waitLoopReason("sleep 60 && ls", true)).toBeNull();
  });

  it("stays linear on a huge input", () => {
    const start = performance.now();
    waitLoopReason("for i in 1 2 3; do echo x; ".repeat(2000), false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("names the Monitor tool and appends the caller's bypass hint", () => {
    expect(waitLoopReason("sleep 60 && ls", undefined)).toMatch(/Monitor/);
    expect(waitLoopReason("sleep 60 && ls", false, "Bypass with X=off.")).toMatch(/ Bypass with X=off\.$/);
  });
});
