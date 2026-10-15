// Git adapter: the local clones on this computer: uncommitted changes, unpushed commits, branch.
// Options:
//   { "roots": ["C:/Users/you/Projects"] }   every git repo directly inside these folders
//   { "repos": ["C:/Users/you/Code/app"] }   and/or these exact repos
//   "git": "git"                              path to the git binary
// A clone whose origin is on GitHub gets key "owner/name", so it merges into the matching item
// from the github adapter; other clones appear as their own items.
// Reads only: it never runs git fetch, so "behind" reflects the last time you fetched.

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";

const run = (bin, cwd, args) => new Promise((resolve) => {
  let out = "", child;
  try { child = spawn(bin, ["-C", cwd, ...args], { windowsHide: true }); } catch { return resolve(null); }
  child.stdout.on("data", (d) => (out += d));
  child.on("error", () => resolve(null));
  child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
});

const isRepo = async (dir) => { try { await stat(join(dir, ".git")); return true; } catch { return false; } };
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

async function findRepos(options, ctx) {
  const found = new Set();
  for (const r of options.repos || []) { const p = resolve(ctx.configDir, r); if (await isRepo(p)) found.add(p); }
  for (const root of options.roots || []) {
    const base = resolve(ctx.configDir, root);
    let entries = [];
    try { entries = await readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(base, e.name);
      if (e.isDirectory() && !e.name.startsWith(".") && (await isRepo(p))) found.add(p);
    }
  }
  return [...found];
}

async function list(options, ctx) {
  const bin = options.git || "git";
  if ((await run(bin, ".", ["--version"])) === null) {
    throw Object.assign(new Error("Git isn't installed or isn't on PATH."), { hint: "Install it from https://git-scm.com." });
  }
  const repos = await findRepos(options, ctx);
  const since = new Date(Date.now() - 364 * 86400000).toISOString();

  const items = await Promise.all(repos.map(async (dir) => {
    const [branch, status, counts, last, remote, log] = await Promise.all([
      run(bin, dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      run(bin, dir, ["status", "--porcelain"]),
      run(bin, dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
      run(bin, dir, ["log", "-1", "--format=%cI%x09%s"]),
      run(bin, dir, ["remote", "get-url", "origin"]),
      run(bin, dir, ["log", `--since=${since}`, "--format=%cI"]),
    ]);
    const changed = status ? status.split("\n").filter(Boolean).length : 0;
    const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null];
    const [lastDate, lastMsg] = last ? last.split("\t") : [null, ""];
    const gh = remote?.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    const name = gh ? gh[2] : basename(dir);

    const marks = [], attention = [];
    if (changed) {
      marks.push({ tone: "pending", label: "edits", title: `${plural(changed, "uncommitted change", "uncommitted changes")} on this computer` });
      attention.push({ label: `${plural(changed, "file", "files")} changed`, tone: "pending", text: "Uncommitted on this computer" });
    }
    if (ahead) {
      marks.push({ tone: "pending", label: `${ahead} unpushed`, title: `${plural(ahead, "commit", "commits")} not pushed` });
      attention.push({ label: `${plural(ahead, "unpushed commit", "unpushed commits")}`, tone: "pending", text: lastMsg });
    }

    return {
      id: dir,
      key: gh ? `${gh[1]}/${gh[2]}` : "",
      name,
      description: gh ? "" : dir,
      updatedAt: lastDate,
      badges: ["Local"],
      marks,
      facts: [
        { label: "Local changes", value: changed ? plural(changed, "file", "files") : "Clean", note: changed ? "uncommitted" : "nothing uncommitted", tone: changed ? "accent" : "" },
        ahead === null ? { label: "Unpushed", value: "No upstream", absent: true } : { label: "Unpushed", value: String(ahead), note: ahead ? `${ahead === 1 ? "commit" : "commits"} to push` : "all pushed", tone: ahead ? "accent" : "" },
        behind === null ? { label: "Behind", value: "—", note: "no upstream branch", absent: true } : { label: "Behind", value: String(behind), note: "as of the last fetch" },
        { label: "Branch", value: branch || "—", note: dir },
      ],
      activity: log ? log.split("\n").filter(Boolean) : [],
      activityNoun: ["commit", "commits"],
      attention,
    };
  }));
  return { items, overview: { stats: [{ label: "Unpushed commits", value: items.reduce((a, it) => a + (Number(it.facts[1].value) || 0), 0) }] } };
}

export default { list, ttlMinutes: 1 };
