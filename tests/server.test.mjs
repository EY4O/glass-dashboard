// Run with: npm test   (node --test, no packages)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import json from "../adapters/json.mjs";
import folders from "../adapters/folders.mjs";
import git from "../adapters/git.mjs";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4900 + Math.floor(Math.random() * 90);

// GET with full control over headers (fetch won't let us forge Host)
const get = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port: PORT, path, headers: { host: `localhost:${PORT}`, ...headers } }, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("error", reject);
  req.end();
});

let dir, server;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "glass-test-"));
  mkdirSync(join(dir, "boxes", "alpha"), { recursive: true });
  mkdirSync(join(dir, "boxes", "beta"), { recursive: true });
  writeFileSync(join(dir, "items.json"), JSON.stringify({
    overview: { stats: [{ label: "Things", value: 2 }], sections: [{ title: "Notes", total: "3 notes", rows: [{ title: "a" }] }] },
    items: [
      { id: "one", key: "me/one", name: "One", updatedAt: "-2h", tags: ["Home"], activity: ["-1h", "-3d"], facts: [{ label: "Seen", time: "-2h" }] },
      { id: "two", name: "Two" },
    ],
  }));
  writeFileSync(join(dir, "extra.json"), JSON.stringify({
    items: [{ id: "x", key: "ME/one", name: "One (local)", tags: ["Local"], facts: [{ label: "Extra", value: "yes" }], links: [{ label: "Site", href: "https://example.com" }] }],
  }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    title: "Test", noun: ["thing", "things"], port: PORT,
    sources: [
      { adapter: "json", label: "Notes", options: { file: "items.json" } },
      { adapter: "folders", label: "Folders", options: { path: "boxes" } },
      { adapter: "json", label: "Extras", options: { file: "extra.json" } },
      { adapter: "json", label: "Broken", options: { file: "missing.json" } },
    ],
  }));
  server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--config", join(dir, "config.json")], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await get("/")).status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server didn't start");
});
after(() => server?.kill());

test("json adapter resolves relative dates and tags", async () => {
  const { items } = await json.list({ file: "items.json" }, { configDir: dir });
  const one = items.find((i) => i.id === "one");
  const age = Date.now() - Date.parse(one.updatedAt);
  assert.ok(age > 1.9 * 3600000 && age < 2.1 * 3600000, "-2h is about two hours ago");
  assert.deepEqual(one.badges, ["Home"]);
  assert.equal(one.activity.length, 2);
  assert.ok(Date.parse(one.facts[0].time));
});

test("json adapter explains a missing file", async () => {
  await assert.rejects(json.list({ file: "nope.json" }, { configDir: dir }), /Can't find nope\.json/);
});

test("folders adapter lists subfolders", async () => {
  const { items } = await folders.list({ path: "boxes" }, { configDir: dir });
  assert.deepEqual(items.map((i) => i.name).sort(), ["alpha", "beta"]);
  assert.ok(items.every((i) => Date.parse(i.updatedAt)));
});

test("dashboard merges sources and reports a failed one", async () => {
  const res = await get("/api/dashboard");
  assert.equal(res.status, 200);
  const d = JSON.parse(res.body);
  assert.equal(d.title, "Test");
  assert.equal(d.items.length, 4, "two JSON items (one merged with its extra) + two folders");
  const times = d.items.map((i) => Date.parse(i.updatedAt) || 0);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first, undated last");
  assert.ok(d.items.every((i) => /^\d+~/.test(i.id)), "ids are prefixed by source");
  assert.deepEqual(d.overview.stats, [{ label: "Things", value: 2 }]);
  assert.equal(d.overview.sections[0].total, "3 notes");
  assert.equal(d.errors.length, 1);
  assert.equal(d.errors[0].source, "Broken");
});

test("items without a detail() report not found", async () => {
  assert.equal((await get(`/api/items/${encodeURIComponent("0~one")}`)).status, 404);
});

test("only public/ is served", async () => {
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/server.mjs")).status, 404);
  assert.equal((await get("/dashboard.config.json")).status, 404);
  assert.equal((await get("/..%2Fserver.mjs")).status, 404);
  assert.equal((await get("/%E0%A4%A")).status, 400);
});

test("other hosts and other sites are refused", async () => {
  assert.equal((await get("/api/dashboard", { host: `evil.example:${PORT}` })).status, 421);
  assert.equal((await get("/api/dashboard", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await get("/api/dashboard", { "sec-fetch-site": "same-origin" })).status, 200);
});

test("items sharing a key merge into one, and stay merged across cached loads", async () => {
  for (let round = 0; round < 2; round++) {
    const d = JSON.parse((await get("/api/dashboard")).body);
    const one = d.items.filter((i) => i.key === "me/one");
    assert.equal(one.length, 1, "one item for the shared key");
    assert.equal(one[0].name, "One", "the first source leads");
    assert.equal(one[0].source, "Notes + Extras");
    assert.deepEqual(one[0].badges, ["Home", "Local"]);
    assert.deepEqual(one[0].facts.map((f) => f.label), ["Seen", "Extra"], `facts aren't duplicated (load ${round + 1})`);
    assert.equal(one[0].links.length, 1);
  }
});

test("git adapter reports uncommitted changes and a missing upstream", async (t) => {
  try { execFileSync("git", ["--version"]); } catch { return t.skip("git isn't installed"); }
  const repo = join(dir, "clones", "sample");
  mkdirSync(repo, { recursive: true });
  const g = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  writeFileSync(join(repo, "a.txt"), "one");
  g("add", ".");
  g("commit", "-q", "-m", "First");
  writeFileSync(join(repo, "a.txt"), "two");
  const { items } = await git.list({ roots: ["clones"] }, { configDir: dir });
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.name, "sample");
  assert.equal(it.key, "", "no GitHub remote, so it stands alone");
  assert.equal(it.facts[0].value, "1 file");
  assert.equal(it.facts[1].value, "No upstream");
  assert.equal(it.activity.length, 1);
  assert.ok(it.attention.some((a) => /1 file changed/.test(a.label)));
});