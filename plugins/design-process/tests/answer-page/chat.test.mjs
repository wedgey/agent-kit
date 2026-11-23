// node --test plugins/design-process/tests/answer-page/chat.test.mjs : the answer page's thread logic (index.html, script#chat-logic)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(new URL("../../skills/design-process/assets/answer-page/index.html", import.meta.url), "utf8");
const Chat = new Function(page.match(/<script id="chat-logic">([\s\S]*?)<\/script>/)[1] + "; return Chat;")();

const T = Date.parse("2026-11-23T09:00:00Z"), min = 60_000;
const iso = t => new Date(t).toISOString();
const owner = (t, x = {}) => ({ id: `${iso(t)}-ab12`, from: "owner", text: "q", sentAt: t, seen: t, ...x });
const claude = (t, x = {}) => ({ id: `${iso(t)}-c`, from: "claude", text: "a", sentAt: t, seen: t, ...x });
const ids = rows => rows.map(r => r.id);

test("rows sort by sentAt, then id", () => {
  const a = owner(T), b = claude(T + min), c = owner(T + 2 * min);
  assert.deepEqual(ids(Chat.order([c, b, a])), ids([a, b, c]));
});

test("a reply whose id and sentAt run ahead sorts where it arrived, not in the future", () => {
  const q = owner(T), late = owner(T + 10 * min);
  const skewed = { ...claude(T + 5 * min), id: `${iso(T + 3 * 3600_000)}-c`, sentAt: T + 3 * 3600_000 };
  assert.deepEqual(ids(Chat.order([late, skewed, q])), ids([q, skewed, late]));
});

test("a reply with replyTo sorts after the row it answers, even with a clock behind", () => {
  const q = owner(T + 10 * min), early = { ...claude(T - 60 * min), replyTo: q.id };
  assert.deepEqual(ids(Chat.order([early, q])), ids([q, early]));
});

test("a row with no sentAt falls back to the time in its id", () => {
  const a = owner(T), b = { id: `${iso(T + min)}-c`, from: "claude", text: "a" };
  assert.deepEqual(ids(Chat.order([b, a])), ids([a, b]));
});

test("the owner's own message keeps its place when its row lands from the database", () => {
  const reply = claude(T + min), mine = owner(T + 2 * min);
  const landed = { ...mine, sentAt: T + 2 * min };
  assert.deepEqual(ids(Chat.order([mine, reply])), ids(Chat.order([reply, landed])));
});

test("pending: an owner message waits until any claude answer", () => {
  const q = owner(T);
  assert.deepEqual(Chat.pending([q]), { redraw: false, since: T, acked: false, ack: "" });
  assert.equal(Chat.pending([q, claude(T + min)]), null);
});

test("pending: a status row is an acknowledgement, not an answer", () => {
  const p = Chat.pending([owner(T, { kind: "redraw" }), claude(T + min, { kind: "status", text: "Working on a redraw" })]);
  assert.deepEqual(p, { redraw: true, since: T, acked: true, ack: "Working on a redraw" });
});

test("pending: a redraw waits for a board, or an answer to it", () => {
  const r = owner(T, { kind: "redraw" }), q = owner(T + min);
  const toQ = claude(T + 2 * min, { replyTo: q.id });
  assert.equal(Chat.pending([r, q, toQ]).redraw, true, "an answer to another message leaves the redraw open");
  assert.equal(Chat.pending([r, q, toQ, claude(T + 3 * min, { board: "A1v2" })]), null);
  assert.equal(Chat.pending([r, claude(T + min, { replyTo: r.id, text: "Can't: which tab?" })]), null);
  assert.equal(Chat.pending([r, claude(T + min)]), null, "a reply with no replyTo answers everything before it");
});

test("pending: a status row before the owner's message is not its acknowledgement", () => {
  assert.equal(Chat.pending([claude(T, { kind: "status" }), owner(T + min)]).acked, false);
});

test("pending: a status row with no text still acknowledges", () => {
  const p = Chat.pending([owner(T), claude(T + min, { kind: "status", text: "" })]);
  assert.equal(p.acked, true);
  assert.equal(Chat.stateOf(p, 1, T + 10 * min).stuck, false);
});

test("a reply with no replyTo and a clock behind sorts after the owner row it arrived after", () => {
  const q = owner(T + 10 * min), r = { ...claude(T - 60 * min), after: q.id };
  assert.deepEqual(ids(Chat.order([r, q])), ids([q, r]));
  assert.equal(Chat.pending(Chat.order([r, q])), null);
});

test("state line: waiting, working, redrawing, and stuck after five minutes", () => {
  const wait = { redraw: false, since: T, acked: false, ack: "" };
  assert.match(Chat.stateOf(wait, 2, T).line, /^Sent\. Waiting for Claude/);
  assert.equal(Chat.stateOf(wait, 2, T).ago, "just now");
  assert.equal(Chat.stateOf(wait, 2, T + 3 * min).ago, "3 min");
  assert.equal(Chat.stateOf(wait, 2, T + 3 * min).line, Chat.stateOf(wait, 2, T).line, "the line holds while minutes tick");
  assert.match(Chat.stateOf({ ...wait, redraw: true }, 2, T).line, /^Redraw requested/);
  const stuck = Chat.stateOf(wait, 2, T + 6 * min);
  assert.ok(stuck.stuck); assert.match(stuck.line, /^No sign of Claude yet/); assert.equal(stuck.ago, "6 min");
  assert.equal(Chat.stateOf(wait, 2, T + 7 * min).line, stuck.line, "the stuck line holds, so it is announced once");
  const busy = Chat.stateOf({ redraw: true, since: T, acked: true, ack: "on it" }, 2, T + 20 * min);
  assert.ok(!busy.stuck); assert.match(busy.line, /Claude is redrawing screen 2/);
  assert.match(Chat.stateOf({ ...wait, acked: true, ack: "on it" }, 2, T).line, /Claude is working on a reply/);
  assert.equal(Chat.stateOf(null, 2, T), null);
});

test("unread: claude answers not yet read; status rows and the owner's never count", () => {
  const a = claude(T), b = claude(T + min, { kind: "status" }), c = owner(T + 2 * min), d = claude(T + 3 * min, { board: "A1v2" });
  assert.deepEqual(ids(Chat.unread([a, b, c, d], { [a.id]: 1 })), [d.id]);
});
