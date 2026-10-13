// Folders adapter: each subfolder of a directory is an item, ranked by when it last changed.
// Options: { "path": "C:/Users/you/Projects" }   (relative paths resolve from the config file)
// A small, complete example of an adapter; see docs/ADAPTERS.md.

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

async function list(options, ctx) {
  const root = resolve(ctx.configDir, options.path || ".");
  const dirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith("."));
  const items = await Promise.all(dirs.map(async (e) => {
    const s = await stat(join(root, e.name));
    return {
      id: e.name,
      name: e.name,
      description: join(root, e.name),
      updatedAt: s.mtime.toISOString(), // a folder's time changes when files directly inside it are added or removed
      facts: [{ label: "Changed", time: s.mtime.toISOString() }, { label: "Created", time: s.birthtime.toISOString() }],
    };
  }));
  return { items };
}

export default { list, ttlMinutes: 1 };
