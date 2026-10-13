# Development

The repository root is the app: a dependency-free Node server, a single-page front end, and the adapters it loads.

```
server.mjs            config loading, adapter loading, merging, cache, HTTP and its guards
public/index.html     the whole front end: styles, the rail and sheet, the WebGL band
adapters/             one file per data source (github, json, folders)
examples/             sample.json and example configs
tests/                node:test suites
docs/                 this file, ADAPTERS.md, README images
dashboard.config.json the default config (sample data)
```

## Run it locally

```bash
npm start
```

Open <http://localhost:4400>. Use another config with `node server.mjs --config examples/github.config.json`, and another port with `PORT=4410`. The server reads `public/` on every request, so front-end edits show on reload; restart it after changing `server.mjs` or an adapter.

## How the page is built

- `GET /api/dashboard` returns `{ title, noun, fetchedAt, items, overview, errors }`. Items are normalised by `normItem()` in `server.mjs`, so the page never sees a field it doesn't expect.
- `GET /api/items/:id` calls the source's `detail()` and returns extra sections. Ids are `<source index>~<adapter id>`.
- The page routes with the hash: `#/overview` and `#/item/<id>`.
- The glass band is a three.js scene: an opaque plane carrying the name as a canvas texture, and a `MeshPhysicalMaterial` torus knot with transmission and dispersion in front of it. The plane must stay opaque: transmission only refracts opaque objects.
- Colours are tokens on `:root`, redefined for dark mode under `prefers-color-scheme` and `[data-theme]`. The band redraws when the theme changes.

## Tests

Node 20 or newer, no packages.

```bash
npm test
```

| Test | Covers |
|---|---|
| json adapter resolves relative dates and tags | `-2h`-style dates, `tags` as badges |
| json adapter explains a missing file | the error message a user sees |
| folders adapter lists subfolders | the example adapter |
| dashboard merges sources and reports a failed one | merging, sorting, id prefixes, overview stats and totals, per-source errors |
| items without a detail() report not found | the detail endpoint |
| only public/ is served | static allow-list, path traversal, malformed escapes |
| other hosts and other sites are refused | the Host and Sec-Fetch-Site guards |

## Releasing

1. Bump `version` in `package.json`.
2. Commit and push to `main`.
3. Tag it (`git tag v1.1.0 && git push --tags`) and draft a GitHub release with the changes.
