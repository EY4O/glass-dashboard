// JSON adapter: items you write by hand, for anything that isn't a repo
// (personal goals, client projects, a team board, a home lab).
// Options: { "file": "data/items.json" }   path relative to the config file
//
// The file holds { "items": [...], "overview": {...} } in the shape described in docs/ADAPTERS.md.
// Any date can be absolute ("2026-10-12T14:00:00Z") or relative to now: past ("-3h", "-2d", "-1w", "-30m") or future ("+5w"),
// which keeps sample data fresh. The file is re-read on every load, so edits show up on Refresh.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const UNITS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const when = (v) => {
  const m = typeof v === "string" && v.match(/^([+-])(\d+(?:\.\d+)?)([mhdw])$/);
  return m ? new Date(Date.now() + (m[1] === "+" ? 1 : -1) * Number(m[2]) * UNITS[m[3]]).toISOString() : v;
};

const fixRows = (sections) => (sections || []).map((s) => ({ ...s, rows: (s.rows || []).map((r) => ({ ...r, date: when(r.date), time: when(r.time), sortKey: r.sortKey ?? (r.date || r.time ? Date.parse(when(r.date || r.time)) : 0) })) }));

async function list(options, ctx) {
  if (!options.file) throw Object.assign(new Error('The json source needs a "file" option.'), { hint: 'Add "options": { "file": "data/items.json" } to the source in your config.' });
  const path = resolve(ctx.configDir, options.file);
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw Object.assign(new Error(e.code === "ENOENT" ? `Can't find ${options.file}.` : `${options.file} isn't valid JSON: ${e.message}`), { hint: `Checked ${path}` });
  }
  const items = (data.items || []).map((it) => ({
    ...it,
    badges: it.badges || it.tags || [],
    updatedAt: when(it.updatedAt),
    activity: (it.activity || []).map(when),
    facts: (it.facts || []).map((f) => ({ ...f, time: when(f.time) })),
    sections: fixRows(it.sections),
  }));
  const overview = data.overview ? { ...data.overview, sections: fixRows(data.overview.sections) } : undefined;
  return { items, overview };
}

// No detail(): everything a JSON item has is in the file already.
export default { list, ttlMinutes: 0 };
