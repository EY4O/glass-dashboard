# Adapters

An adapter turns some source of truth (GitHub, a JSON file, a folder, an API) into **items**. The page only ever sees items, so any source looks and behaves the same: a rail entry, a full page, and a place on the overview.

## The contract

An adapter is a file in `adapters/` with a default export:

```js
export default {
  async list(options, ctx) { return { items: [...], overview: {...} }; }, // required
  async detail(id, options, ctx) { return { sections: [...], activity: [...] }; }, // optional
  ttlMinutes: 5, // optional: how long list() results are reused (defaults to the config's cacheMinutes)
};
```

- `options` is the source's `"options"` object from the config.
- `ctx.configDir` is the folder the config file is in (resolve relative paths from it); `ctx.root` is the repository folder.
- `list()` runs on load, on **Refresh**, and when the cache expires. `detail()` runs when an item is opened, and its sections appear after the item's own.
- Throw an `Error` to report a problem. Add a `hint` property (`Object.assign(new Error("…"), { hint: "Run gh auth login." })`) and the overview shows it next to the source's name. Other sources still load.
- Name the adapter in the config: `{ "adapter": "folders", "label": "Projects", "options": { "path": "C:/Users/you/Projects" } }`. Adapter names are lowercase letters, digits and dashes.

## A complete example

`adapters/folders.mjs` makes every subfolder of a directory an item:

```js
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
      updatedAt: s.mtime.toISOString(),
      facts: [{ label: "Changed", time: s.mtime.toISOString() }, { label: "Created", time: s.birthtime.toISOString() }],
    };
  }));
  return { items };
}

export default { list, ttlMinutes: 1 };
```

## Items

Every field except `id` and `name` is optional. Anything missing is simply not shown.

| Field | Type | Shown as |
|---|---|---|
| `id` | string | Unique within the source; used in the page's address |
| `name` | string | Rail entry, the glass band, the page title |
| `description` | string | The large line under the band |
| `url` | `https://…` | The name in the top bar links here |
| `updatedAt` | date | Rail grouping (Active ≤ 7 days, Quiet ≤ 28, Stale, Undated), sort order, and the "new since your last visit" mark |
| `short` | string | The right side of the rail entry (a version, a phase, `6/7 up`) |
| `badges` | string[] | Pills in the top bar, and the rail's filter tabs (the four most common badges become tabs). The JSON source also accepts `tags` |
| `marks` | mark[] | Small signals on the rail entry |
| `facts` | fact[] | The definition grid on the item page |
| `activity` | date[] | Timestamps for the activity chart (1D, 1W, 1M, 1Y) and the overview's totals |
| `activityNoun` | `[one, many]` | What the timestamps are: `["commit", "commits"]`, `["run", "runs"]`. Default `["update", "updates"]` |
| `attention` | attention[] | Rows in the overview's **Needs attention** list |
| `links` | `{ label, href }[]` | The link grid at the bottom of the item page |
| `sections` | section[] | Lists on the item page, in order |

Dates are ISO strings (`2026-10-12T14:00:00Z`). The JSON source also accepts relative times: `-30m`, `-3h`, `-2d`, `-1w`.

### Marks

`{ "tone": "accent" | "fail" | "pending" | "plain", "label": "4", "title": "Tasks due" }` draws a small dot (prism, red, amber, or none) with a label. `{ "icon": "lock" | "fork" | "archive" | "tag" | "user" | "check", "title": "Private" }` draws an icon instead. Give every mark a `title`; it's the tooltip and the screen-reader text.

### Facts

`{ "label": "Version", "value": "1.4.0", "note": "from package.json" }`

- `time` (a date) instead of `value` shows "3 hours ago" with the date as the note, kept current in the browser.
- `count` (a number) makes the value count up when the page opens.
- `tone: "accent"` sets the value in the prism; `tone: "fail"` in red.
- `absent: true` sets it as a muted statement ("Never released", "Not booked"). Say what's missing in words rather than leaving a blank.

Four facts fill a row; eight make two.

### Attention

`{ "label": "Service down", "tone": "fail", "text": "Photo backup stopped after the last update" }`. The label is the short reason; `text` follows the item's name.

### Sections

```json
{
  "title": "Releases",
  "total": "48 downloads",
  "half": true,
  "limit": 8,
  "empty": "No releases yet.",
  "footnote": "Downloads count files attached to releases.",
  "rows": [
    { "key": "v1.2.0", "title": "Version 1.2", "note": "pre-release", "strong": "16", "meta": "downloads", "date": "2026-09-29T00:00:00Z", "href": "https://…" }
  ]
}
```

- `total` follows the title in the heading. On the overview, sections with the same title from different sources are merged, and totals with the same unit add up.
- `half: true` sections pair up side by side.
- `limit` shows that many rows with a **Show all** button for the rest.
- Rows: `key` (short left column), `title`, `note` (muted, after the title), `strong` (an ink number) followed by `meta`, then `date` (shown as a date) and `time` (shown as "3h"). `tone: "fail"` or `"accent"` marks the key. Rows with an `href` link out.

## Overview

`list()` can also return:

```json
{
  "overview": {
    "sentence": "1 repo has commits since its last release.",
    "stats": [{ "label": "Release downloads", "value": 109 }],
    "sections": [{ "title": "Latest releases", "rows": [...] }]
  }
}
```

Sentences from all sources follow the overview's opening line. Stats with the same label are added together across sources and shown after the built-in totals (items, updated this week, activity in 52 weeks). Rows with a `sortKey` (a number, usually a timestamp) are sorted newest first after merging.
