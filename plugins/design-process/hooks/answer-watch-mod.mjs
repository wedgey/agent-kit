const TOOL = "answer_watch";
const CALLED_AS = `mcp__design-process__${TOOL}`;
const KEY = "answer-watch";
// The plugin store is shared by every session on the machine: an unscoped key lets any session adopt another's watch and wake on its answers.
const keyOf = async ($) => `${KEY}:${await $.session.id()}`;
const SERVER = "claude-artifacts";
const POLL_MS = 10_000;
const MAX_MS = 6 * 60 * 60 * 1000;
const MAX_ERRORS = 90; // 15 minutes of outage at POLL_MS

export const DESCRIPTION =
  "Call this once after you publish a design round to an artifact: it polls the artifact's database every 10 s and wakes this session when the owner sends answers or a chat message, " +
  "and stops by itself when rounds/<round>.status is \"handled\", after 6 h, or with stop: true. Arming again for another round replaces the watch. " +
  "Database layout it reads: rounds/<round>/answers/<uid>, rounds/<round>/threads/<n>/msgs/<msgId> (a row with from \"claude\", a kind \"status\" acknowledgement included, never wakes you).";

const SCHEMA = {
  type: "object",
  properties: {
    slug: { type: "string", description: "The artifact's slug (UUID)." },
    round: { type: "string", description: "The round id, the <id> in rounds/<id>." },
    screens: {
      description: "The thread numbers to watch: a list of integers, or a count N meaning threads 1 to N. Leave out to watch the answers only.",
      anyOf: [{ type: "array", items: { type: "integer" } }, { type: "integer" }],
    },
    stop: { type: "boolean", description: "Stop the watch instead of arming it." },
  },
  required: ["slug", "round"],
};

/** The armed watch, or null. It is the same object as the one in the store, so a stale poll can tell it was replaced. */
let current = null;
let timer = null;
let inFlight = false;
let errors = 0;

const threadsOf = (screens) =>
  Array.isArray(screens) ? screens.filter(Number.isInteger) : Number.isInteger(screens) && screens >= 0 ? Array.from({ length: screens }, (_, n) => n + 1) : [];

const jsonLines = (text) =>
  text.split("\n").flatMap((line) => {
    try {
      return line.trim().startsWith("{") ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });

async function callDb($, tool, args) {
  const r = await $.mcp.call(SERVER, tool, args);
  const text = (r?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
  if (r?.isError) throw new Error(text.slice(0, 200) || "db call failed");
  return text;
}

async function rowsOf($, slug, collection) {
  const text = await callDb($, "db_list", { slug, collection, limit: 1000 });
  return jsonLines(text)
    .filter((o) => typeof o.id === "string" && o.data && typeof o.data === "object")
    .map((o) => ({ path: `${collection}/${o.id}`, data: o.data, stamp: String(o.data.sentAt ?? o.version ?? o.updatedAt) }));
}

/** The round row's status, or undefined when it does not exist yet. */
async function statusOf($, slug, round) {
  const [summary, data] = jsonLines(await callDb($, "db_get", { slug, path: `rounds/${round}` }));
  return summary?.exists === false ? undefined : data?.status;
}

export const wakeText = (w, rows) =>
  `The owner replied on the design round page. Artifact ${w.slug}, round ${w.round}. New rows: ${rows.map((r) => (r.data.kind === "redraw" ? `${r.path} (redraw)` : r.path)).join(", ")}. ` +
  `Read them with the claude-artifacts db tools (db_get on each path) and act on them per the design-process skill: a redraw row always gets a redraw. ` +
  `Before you work on a thread, write its kind "status" row with replyTo (references/answer-page.md), so the page shows you are on it. ` +
  `When the round is handled, set rounds/${w.round}.status to "handled" so this watch stops.`;

const stoppedText = (w, why) =>
  `The answer watch for round ${w.round} of artifact ${w.slug} stopped: ${why}. Owner replies are no longer being watched. Arm answer_watch again if the round is still open, or ask the owner to say in chat when they have sent.`;

async function stop($, why, notify) {
  const w = current;
  timer?.cancel();
  timer = null;
  current = null;
  errors = 0;
  $.ui.status(undefined);
  if (w) await $.store.delete(w.key).catch(() => {});
  if (why) $.ui.toast(`Answer watch stopped: ${why}`);
  if (notify && w) await $.prompt.submit({ text: stoppedText(w, why) }).catch(() => {});
}

async function poll($, w) {
  // A poll of a replaced watch must not stop its successor.
  const stopIfCurrent = (why, notify) => (current === w ? stop($, why, notify) : undefined);
  if ((await $.clock.now()) - w.armedAt > MAX_MS) return stopIfCurrent("6 hours passed", true);
  if ((await statusOf($, w.slug, w.round)) === "handled") return stopIfCurrent(`round ${w.round} is handled`);
  const collections = [`rounds/${w.round}/answers`, ...w.screens.map((n) => `rounds/${w.round}/threads/${n}/msgs`)];
  const rows = (await Promise.all(collections.map((c) => rowsOf($, w.slug, c)))).flat();
  const fresh = rows.filter((r) => r.data.from !== "claude" && w.seen[r.path] !== r.stamp);
  if (current !== w || !fresh.length) return;
  const before = { ...w.seen };
  for (const r of fresh) w.seen[r.path] = r.stamp;
  await $.store.set(w.key, w);
  try {
    await $.prompt.submit({ text: wakeText(w, fresh) });
  } catch (error) {
    // The wake never happened, so the rows must be offered again next tick.
    // Only while still armed: a stop() during the submit has deleted the stored watch, and this would revive it.
    w.seen = before;
    if (current === w) await $.store.set(w.key, w);
    throw error;
  }
}

function start($, w) {
  timer?.cancel();
  current = w;
  errors = 0;
  $.ui.status(`Watching round ${w.round} for answers`);
  timer = $.clock.every(POLL_MS, async () => {
    if (inFlight || current !== w) return;
    inFlight = true;
    try {
      await poll($, w);
      errors = 0;
    } catch {
      if (current === w && ++errors >= MAX_ERRORS) await stop($, `${MAX_ERRORS} failed checks in a row`, true).catch(() => {});
    } finally {
      inFlight = false;
    }
  });
}

/** Re-arms from the store after a restart or a hot reload, which drop the timer. */
async function resume($) {
  if (timer) return;
  const key = await keyOf($);
  const w = await $.store.get(key).catch(() => undefined);
  if (w?.slug && w.round) start($, { ...w, key });
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("session.start", async ($, e, next) => {
    try {
      await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false });
      await resume($);
    } catch {}
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    await resume($).catch(() => {});
    return next(e);
  });

  on("tool.call", { tool: CALLED_AS }, async ($, e) => {
    const slug = typeof e.slug === "string" ? e.slug.trim() : "";
    const round = typeof e.round === "string" ? e.round.trim() : "";
    if (!slug || !round) return { result: "Not watching: give both slug and round.", isError: true };
    if (e.stop) {
      if (current?.slug === slug && current.round === round) await stop($);
      return { result: `Answer watch for round ${round} stopped.` };
    }
    const w = { key: await keyOf($), slug, round, screens: threadsOf(e.screens), armedAt: await $.clock.now(), seen: current?.slug === slug && current.round === round ? current.seen : {} };
    await $.store.set(w.key, w);
    start($, w);
    return { result: `Watching round ${round} of ${slug}: answers and ${w.screens.length} threads, every 10 s. You are woken when the owner replies; the watch stops when rounds/${round}.status is "handled", after 6 h, or with stop: true.` };
  });
};
