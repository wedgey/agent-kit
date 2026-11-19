// node serve.mjs [port] [fixtureDir] : serves answer-page/index.html + proto.js + fixture, injecting stub.js (set ?null to drop it)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname), ap = path.join(here, "../../skills/design-process/assets/answer-page");
const fx = path.resolve(process.argv[3] || path.join(ap, "example"));
http.createServer((q, s) => {
  const u = new URL(q.url, "http://x"), p = u.pathname === "/" ? "/index.html" : u.pathname;
  const f = [path.join(here, p), path.join(fx, p), path.join(ap, p)].find(x => fs.existsSync(x) && fs.statSync(x).isFile());
  if (!f) { s.writeHead(404); return s.end(); }
  let b = fs.readFileSync(f); if (p === "/index.html" && u.searchParams.get("stub") !== "0") b = b.toString().replace("<head>", `<head><script>${u.searchParams.has("null") ? "window.__null=1;" : ""}</script><script src="/stub.js"></script>`);
  s.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg" }[path.extname(f)] || "application/octet-stream" }); s.end(b);
}).listen(+process.argv[2] || 8765);
