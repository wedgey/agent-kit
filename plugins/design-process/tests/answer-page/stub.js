// In-memory claude.use("db"|"user"); window.__store is the data, window.__emit(path) re-fires listeners.
(() => {
  const store = window.__store = {}, subs = [];
  const snap = path => { const v = store[path]; return { data: () => v }; };
  const coll = p => ({ docs: Object.keys(store).filter(k => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).map(k => ({ id: k.slice(p.length + 1), data: () => store[k] })) });
  window.__emit = () => subs.forEach(s => s());
  const db = {
    doc: p => ({ set: async v => { store[p] = JSON.parse(JSON.stringify(v)); window.__emit(); }, onSnapshot: cb => { const f = () => cb(snap(p)); subs.push(f); setTimeout(f, 0); } }),
    collection: p => ({ onSnapshot: cb => { const f = () => cb(coll(p)); subs.push(f); setTimeout(f, 0); } }),
  };
  window.claude = { use: async n => window.__null ? null : n === "db" ? db : { id: async () => "u1" } };
})();
