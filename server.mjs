// Glass Dashboard: a tiny local server with pluggable data adapters. No dependencies.
// Run: node server.mjs [--config path/to/config.json]   then open http://localhost:4400
// Listens on 127.0.0.1 only. Adapters read data; nothing is written anywhere.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");

// ---------- config ----------
const argConfig = (() => { const i = process.argv.indexOf("--config"); return i > -1 ? process.argv[i + 1] : null; })();
const CONFIG_PATH = resolve(ROOT, argConfig || process.env.DASHBOARD_CONFIG || "dashboard.config.json");
const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const config = {
  title: raw.title || "Dashboard",
  noun: Array.isArray(raw.noun) && raw.noun.length === 2 ? raw.noun : ["item", "items"],
  port: Number(process.env.PORT) || raw.port || 4400,
  cacheMinutes: raw.cacheMinutes ?? 5,
  sources: Array.isArray(raw.sources) ? raw.sources : [],
};
const configDir = dirname(CONFIG_PATH);

// ---------- adapters ----------
const sources = await Promise.all(config.sources.map(async (s, i) => {
  if (!/^[a-z0-9-]+$/.test(s.adapter || "")) throw new Error(`Source ${i}: "adapter" must name a file in adapters/, like "github" or "json".`);
  const mod = await import(pathToFileURL(join(ROOT, "adapters", `${s.adapter}.mjs`)).href);
  const adapter = mod.default;
  if (typeof adapter?.list !== "function") throw new Error(`adapters/${s.adapter}.mjs must export a default object with a list() function.`);
  return { key: String(i), name: s.adapter, label: s.label || s.adapter, adapter, options: s.options || {}, ttl: (adapter.ttlMinutes ?? config.cacheMinutes) * 60000 };
}));
const ctx = { root: ROOT, configDir };

// ---------- normalising ----------
const str = (v) => (v == null ? "" : String(v));
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const TONES = new Set(["accent", "fail", "pending", "plain"]);
const ICONS = new Set(["lock", "fork", "archive", "tag", "user", "check"]);

function normSection(s) {
  return {
    title: str(s.title),
    total: s.total == null ? "" : str(s.total),
    half: Boolean(s.half),
    limit: Number(s.limit) || 0,
    empty: str(s.empty) || "Nothing here yet.",
    footnote: str(s.footnote),
    rows: arr(s.rows).map((r) => ({
      key: str(r.key), title: str(r.title), note: str(r.note), meta: str(r.meta), strong: r.strong == null ? "" : str(r.strong),
      date: iso(r.date), time: iso(r.time),
      href: /^https?:\/\//.test(r.href || "") ? r.href : "", sortKey: Number(r.sortKey) || 0, tone: TONES.has(r.tone) ? r.tone : "",
    })),
  };
}

function normItem(it, src) {
  return {
    id: `${src.key}~${str(it.id || it.name)}`,
    source: src.label,
    name: str(it.name || it.id),
    description: str(it.description),
    url: /^https?:\/\//.test(it.url || "") ? it.url : "",
    updatedAt: iso(it.updatedAt),
    short: str(it.short),
    badges: arr(it.badges).map(str).filter(Boolean),
    marks: arr(it.marks).map((m) => ({ tone: TONES.has(m.tone) ? m.tone : "plain", label: str(m.label), icon: ICONS.has(m.icon) ? m.icon : "", title: str(m.title) })),
    facts: arr(it.facts).map((f) => ({ label: str(f.label), value: str(f.value), note: str(f.note), time: iso(f.time), absent: Boolean(f.absent), tone: TONES.has(f.tone) ? f.tone : "", count: Number.isFinite(f.count) ? f.count : null })),
    activity: arr(it.activity).map(iso).filter(Boolean),
    activityNoun: Array.isArray(it.activityNoun) && it.activityNoun.length === 2 ? it.activityNoun.map(str) : ["update", "updates"],
    attention: arr(it.attention).map((a) => ({ label: str(a.label), tone: TONES.has(a.tone) ? a.tone : "", text: str(a.text) })),
    links: arr(it.links).filter((l) => /^https?:\/\//.test(l.href || "")).map((l) => ({ label: str(l.label), href: l.href })),
    sections: arr(it.sections).map(normSection),
    hasDetail: typeof src.adapter.detail === "function",
  };
}

// ---------- loading with per-source cache ----------
const listCache = new Map(); // key -> { at, data }
const detailCache = new Map();

async function loadSource(src, refresh) {
  const hit = listCache.get(src.key);
  if (!refresh && hit && Date.now() - hit.at < src.ttl) return hit.data;
  const res = await src.adapter.list(src.options, ctx);
  const data = {
    items: arr(res?.items).map((it) => normItem(it, src)),
    stats: arr(res?.overview?.stats).filter((s) => Number.isFinite(s.value)).map((s) => ({ label: str(s.label), value: s.value })),
    sections: arr(res?.overview?.sections).map(normSection),
    sentence: str(res?.overview?.sentence),
  };
  listCache.set(src.key, { at: Date.now(), data });
  return data;
}

async function loadDashboard(refresh = false) {
  if (refresh) detailCache.clear();
  const results = await Promise.allSettled(sources.map((s) => loadSource(s, refresh)));
  const items = [], stats = new Map(), sections = new Map(), sentences = [], errors = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push({ source: sources[i].label, message: r.reason?.message || "Failed to load.", hint: r.reason?.hint || "" });
      return;
    }
    items.push(...r.value.items);
    for (const s of r.value.stats) stats.set(s.label, (stats.get(s.label) || 0) + s.value);
    for (const s of r.value.sections) {
      const prev = sections.get(s.title);
      if (!prev) { sections.set(s.title, { ...s, rows: [...s.rows] }); continue; }
      prev.rows.push(...s.rows);
      // Totals like "48 downloads" add up when their units match
      const a = prev.total.match(/^([\d,]+)\s*(.*)$/), b = s.total.match(/^([\d,]+)\s*(.*)$/);
      if (a && b && a[2].replace(/s$/, "") === b[2].replace(/s$/, "")) {
        const sum = Number(a[1].replace(/,/g, "")) + Number(b[1].replace(/,/g, ""));
        prev.total = `${sum.toLocaleString("en-US")} ${sum === 1 ? a[2].replace(/s$/, "") : a[2].replace(/s?$/, "s")}`.trim();
      }
    }
    if (r.value.sentence) sentences.push(r.value.sentence);
  });
  // Most recently updated first; undated items last
  items.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  for (const s of sections.values()) if (s.rows.some((r) => r.sortKey)) s.rows.sort((a, b) => b.sortKey - a.sortKey);
  return {
    title: config.title,
    noun: config.noun,
    fetchedAt: new Date().toISOString(),
    items,
    overview: { stats: [...stats].map(([label, value]) => ({ label, value })), sections: [...sections.values()], sentence: sentences.join(" ") },
    errors,
  };
}

async function loadDetail(id, refresh) {
  const [key, ...rest] = id.split("~");
  const localId = rest.join("~");
  const src = sources.find((s) => s.key === key);
  if (!src || typeof src.adapter.detail !== "function") throw Object.assign(new Error("No details for this item."), { code: "not-found" });
  const hit = detailCache.get(id);
  if (!refresh && hit && Date.now() - hit.at < src.ttl) return hit.data;
  const res = await src.adapter.detail(localId, src.options, ctx);
  const data = { sections: arr(res?.sections).map(normSection), activity: res?.activity ? arr(res.activity).map(iso).filter(Boolean) : null };
  detailCache.set(id, { at: Date.now(), data });
  return data;
}

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" };
const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const ALLOWED_HOSTS = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

createServer(async (req, res) => {
  // Only answer this machine by its own names: blocks DNS-rebinding reads of your data
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, { error: "bad-host", message: "Unknown host." });
  const url = new URL(req.url, "http://localhost");
  // Other websites can't call the API (no reads, no refresh spam)
  const site = req.headers["sec-fetch-site"];
  if (url.pathname.startsWith("/api/") && site && site !== "same-origin" && site !== "none") {
    return send(res, 403, { error: "cross-site", message: "Cross-site requests aren't allowed." });
  }
  const refresh = url.searchParams.has("refresh");
  try {
    if (url.pathname === "/api/dashboard") return send(res, 200, await loadDashboard(refresh));
    const m = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (m) return send(res, 200, await loadDetail(decodeURIComponent(m[1]), refresh));
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not-found", message: "Unknown endpoint." });

    // Static files from public/ only
    const rel = normalize(decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)).replace(/^[\\/]+/, "");
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + sep) || rel.split(/[\\/]/).some((p) => p.startsWith("."))) return send(res, 404, "Not found", "text/plain");
    return send(res, 200, await readFile(file), TYPES[extname(file).toLowerCase()] || "application/octet-stream");
  } catch (e) {
    if (e instanceof URIError) return send(res, 400, { error: "bad-request", message: "Malformed address." });
    if (e.code === "ENOENT") return send(res, 404, "Not found", "text/plain");
    if (e.code === "not-found") return send(res, 404, { error: "not-found", message: e.message });
    console.error(e.message);
    return send(res, 502, { error: e.code || "error", message: e.message, hint: e.hint || "" });
  }
}).listen(config.port, "127.0.0.1", () => {
  console.log(`${config.title}: http://localhost:${config.port}  (config: ${CONFIG_PATH})`);
  loadDashboard().catch((e) => console.error(e.message)); // warm the cache
});
