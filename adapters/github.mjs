// GitHub adapter: every repo of a user, an org, or a fixed list, read through the GitHub CLI (gh).
// Options (pick one of user / org / repos):
//   { "user": "@me" }                  your own repos, public and private (default)
//   { "user": "octocat" }              someone's public repos
//   { "org": "my-org" }                an organisation's repos you can see
//   { "repos": ["owner/name", ...] }   exactly these repos
//   "includeForks": true, "includeArchived": true, "gh": "gh"   (path to the gh binary)
// Reads only. The token stays inside gh and never reaches the browser.

import { spawn } from "node:child_process";

const DAY = 86400000;
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const day = (iso) => (iso ? dayFmt.format(new Date(iso)) : "");
const weeksAgo = (n) => new Date(Date.now() - n * 7 * DAY).toISOString();
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// ---------- gh ----------
const fail = (code, message, hint = "") => Object.assign(new Error(message), { code, hint });

function gh(bin, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); } catch { return reject(fail("gh-missing", "The GitHub CLI isn't installed.", "Install it from https://cli.github.com, then run gh auth login.")); }
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(e.code === "ENOENT" ? fail("gh-missing", "The GitHub CLI isn't installed.", "Install it from https://cli.github.com, then run gh auth login.") : e));
    child.on("close", (code) => {
      if (code === 0) return resolve(out);
      if (/auth login|not logged in|authentication/i.test(err)) return reject(fail("gh-auth", "The GitHub CLI isn't signed in.", "Run gh auth login, then refresh."));
      reject(fail("gh-failed", err.trim() || `gh exited with ${code}`));
    });
    child.stdin.end(input || "");
  });
}

async function graphql(bin, query, variables = {}) {
  const json = JSON.parse(await gh(bin, ["api", "graphql", "--input", "-"], JSON.stringify({ query, variables })));
  if (json.errors && !json.data) throw fail("gh-failed", json.errors.map((e) => e.message).join("; "));
  return json.data;
}

// ---------- repo facts ----------
const STORE_PATTERNS = [
  [/https?:\/\/chromewebstore\.google\.com\/detail\/[^\s)"'<>\]]+/gi, "Chrome Web Store"],
  [/https?:\/\/chrome\.google\.com\/webstore\/detail\/[^\s)"'<>\]]+/gi, "Chrome Web Store"],
  [/https?:\/\/microsoftedge\.microsoft\.com\/addons\/detail\/[^\s)"'<>\]]+/gi, "Edge Add-ons"],
  [/https?:\/\/addons\.mozilla\.org\/[^\s)"'<>\]]+/gi, "Firefox Add-ons"],
  [/https?:\/\/registry\.comfy\.org\/nodes\/[^\s)"'<>\]]+/gi, "Comfy Registry"],
  [/https?:\/\/(?:www\.)?npmjs\.com\/package\/[^\s)"'<>\]]+/gi, "npm"],
  [/https?:\/\/pypi\.org\/project\/[^\s)"'<>\]]+/gi, "PyPI"],
  [/https?:\/\/marketplace\.visualstudio\.com\/items\?[^\s)"'<>\]]+/gi, "VS Code Marketplace"],
  [/https?:\/\/[a-z0-9-]+\.itch\.io\/[^\s)"'<>\]]+/gi, "itch.io"],
  [/https?:\/\/store\.steampowered\.com\/app\/[^\s)"'<>\]]+/gi, "Steam"],
  [/https?:\/\/play\.google\.com\/store\/apps\/[^\s)"'<>\]]+/gi, "Google Play"],
  [/https?:\/\/apps\.apple\.com\/[^\s)"'<>\]]+/gi, "App Store"],
  [/https?:\/\/[a-z0-9-]+\.github\.io\/[^\s)"'<>\]]*/gi, "GitHub Pages"],
];

function readmeLinks(text) {
  if (!text) return [];
  const found = [];
  for (const [re, label] of STORE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const href = m[0].replace(/[.,;:]+$/, "");
      if (/img\.shields\.io|badge|\.svg$|\.png$/i.test(href)) continue;
      if (!found.some((f) => f.href === href)) found.push({ label, href });
    }
  }
  return found.filter((f, i) => found.findIndex((g) => g.label === f.label) === i);
}

function versionFrom(files) {
  const tryJson = (text) => { try { return JSON.parse(text).version; } catch { return null; } };
  if (files.manifest) { const v = tryJson(files.manifest); if (v) return { value: v, source: "manifest.json" }; }
  if (files.pkg) { const v = tryJson(files.pkg); if (v) return { value: v, source: "package.json" }; }
  if (files.pyproject) { const m = files.pyproject.match(/^\s*version\s*=\s*["']([^"']+)["']/m); if (m) return { value: m[1], source: "pyproject.toml" }; }
  if (files.cargo) { const m = files.cargo.match(/^\s*version\s*=\s*["']([^"']+)["']/m); if (m) return { value: m[1], source: "Cargo.toml" }; }
  if (files.csproj) { const m = files.csproj.text.match(/<(?:Version|AssemblyVersion)>([^<]+)</); if (m) return { value: m[1].trim(), source: files.csproj.name }; }
  if (files.godot) { const m = files.godot.match(/config\/version\s*=\s*"([^"]+)"/); if (m) return { value: m[1], source: "project.godot" }; }
  if (files.app) { try { const v = JSON.parse(files.app).expo?.version; if (v) return { value: v, source: "app.json" }; } catch {} }
  return null;
}

const sumDownloads = (release) => (release?.releaseAssets?.nodes || []).reduce((a, x) => a + x.downloadCount, 0);

// ---------- queries ----------
const REPO_FIELDS = `
  name nameWithOwner description url homepageUrl isPrivate isFork isArchived pushedAt
  stargazerCount forkCount
  primaryLanguage { name }
  issues(states: OPEN) { totalCount }
  pullRequests(states: OPEN) { totalCount }
  latestRelease { tagName name publishedAt url tagCommit { committedDate } releaseAssets(first: 20) { nodes { downloadCount } } }
  allReleases: releases(first: 100) { totalCount nodes { releaseAssets(first: 20) { nodes { downloadCount } } } }
  refs(refPrefix: "refs/tags/", last: 1, orderBy: { field: TAG_COMMIT_DATE, direction: ASC }) {
    nodes { name target { ... on Commit { committedDate } ... on Tag { target { ... on Commit { committedDate } } } } }
  }
  defaultBranchRef {
    name
    target { ... on Commit {
      committedDate messageHeadline
      statusCheckRollup { state }
      all: history { totalCount }
      year: history(first: 100, since: $since) { totalCount pageInfo { hasNextPage endCursor } nodes { committedDate } }
    } }
  }
  root: object(expression: "HEAD:") { ... on Tree { entries { name type } } }`;

const OWNER_QUERY = (kind) => `
query($login: String!, $since: GitTimestamp!, $after: String) {
  owner: ${kind}(login: $login) {
    repositories(first: 50, after: $after${kind === "user" ? ", ownerAffiliations: OWNER" : ""}, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${REPO_FIELDS} }
    }
  }
}`;
const VIEWER_QUERY = `
query($since: GitTimestamp!, $after: String) {
  owner: viewer {
    repositories(first: 50, after: $after, ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${REPO_FIELDS} }
    }
  }
}`;

const PAGE_QUERY = `
query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit {
      history(first: 100, since: $since, after: $after) { pageInfo { hasNextPage endCursor } nodes { committedDate } }
    } } }
  }
}`;

const FILE_FIELDS = `
  readme: object(expression: "HEAD:README.md") { ... on Blob { text } }
  manifest: object(expression: "HEAD:manifest.json") { ... on Blob { text } }
  pkg: object(expression: "HEAD:package.json") { ... on Blob { text } }
  pyproject: object(expression: "HEAD:pyproject.toml") { ... on Blob { text } }
  cargo: object(expression: "HEAD:Cargo.toml") { ... on Blob { text } }
  godot: object(expression: "HEAD:project.godot") { ... on Blob { text } }
  app: object(expression: "HEAD:app.json") { ... on Blob { text } }`;

async function fetchRepos(bin, o, since) {
  if (Array.isArray(o.repos) && o.repos.length) {
    const parts = o.repos.map((full, i) => {
      const [owner, name] = String(full).split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${REPO_FIELDS} }`;
    });
    const d = await graphql(bin, `query($since: GitTimestamp!) { ${parts.join("\n")} }`, { since });
    return o.repos.map((_, i) => d[`r${i}`]).filter(Boolean);
  }
  const nodes = [];
  let after = null;
  const self = !o.org && (!o.user || o.user === "@me");
  for (let page = 0; page < 10; page++) {
    const d = self
      ? await graphql(bin, VIEWER_QUERY, { since, after })
      : await graphql(bin, OWNER_QUERY(o.org ? "organization" : "user"), { login: o.org || o.user, since, after });
    if (!d.owner) throw fail("not-found", `No GitHub ${o.org ? "organisation" : "user"} named ${o.org || o.user}.`);
    nodes.push(...d.owner.repositories.nodes);
    if (!d.owner.repositories.pageInfo.hasNextPage) break;
    after = d.owner.repositories.pageInfo.endCursor;
  }
  return nodes;
}

// ---------- list ----------
async function list(options) {
  const bin = options.gh || "gh";
  const windowStart = weeksAgo(52);
  let repos = await fetchRepos(bin, options, windowStart);
  if (options.includeForks === false) repos = repos.filter((r) => !r.isFork);
  if (options.includeArchived === false) repos = repos.filter((r) => !r.isArchived);

  // More than 100 commits in the window: page through the rest so activity never undercounts
  const more = new Map();
  await Promise.all(repos.map(async (n) => {
    const year = n.defaultBranchRef?.target?.year;
    if (!year?.pageInfo?.hasNextPage) return;
    const [owner, name] = n.nameWithOwner.split("/");
    const dates = [];
    let after = year.pageInfo.endCursor;
    for (let page = 0; page < 20 && after; page++) {
      const h = (await graphql(bin, PAGE_QUERY, { owner, name, since: windowStart, after })).repository?.defaultBranchRef?.target?.history;
      if (!h) break;
      dates.push(...h.nodes.map((c) => c.committedDate));
      after = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
    }
    more.set(n.nameWithOwner, dates);
  }));

  // Version files and READMEs, batched by alias; .csproj at the root or one folder down
  const csprojPath = (n) => {
    const entries = n.root?.entries || [];
    const atRoot = entries.find((e) => e.type === "blob" && e.name.endsWith(".csproj"));
    if (atRoot) return atRoot.name;
    const dir = entries.find((e) => e.type === "tree" && e.name.toLowerCase() === n.name.toLowerCase());
    return dir ? `${dir.name}/${dir.name}.csproj` : null;
  };
  const files = {};
  for (let start = 0; start < repos.length; start += 25) {
    const chunk = repos.slice(start, start + 25);
    const parts = chunk.map((n, i) => {
      const [owner, name] = n.nameWithOwner.split("/");
      const cs = csprojPath(n);
      return `r${start + i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {${FILE_FIELDS}
        ${cs ? `csproj: object(expression: ${JSON.stringify("HEAD:" + cs)}) { ... on Blob { text } }` : ""} }`;
    });
    Object.assign(files, await graphql(bin, `query { ${parts.join("\n")} }`));
  }

  let unreleasedRepos = 0, openTotal = 0, ciRuns = 0, ciFailing = 0, downloadsTotal = 0;
  const releaseRows = [];

  const items = repos.map((n, i) => {
    const f = files[`r${i}`] || {};
    const head = n.defaultBranchRef?.target;
    const cs = csprojPath(n);
    const tag = n.refs?.nodes?.[0];
    const tagDate = tag?.target?.committedDate || tag?.target?.target?.committedDate || null;
    const version = versionFrom({
      manifest: f.manifest?.text, pkg: f.pkg?.text, pyproject: f.pyproject?.text, cargo: f.cargo?.text,
      godot: f.godot?.text, app: f.app?.text,
      csproj: f.csproj?.text ? { text: f.csproj.text, name: cs.split("/").pop() } : null,
    }) || (tag ? { value: tag.name.replace(/^v/i, ""), source: "git tag" } : null);
    const rel = n.latestRelease;
    const since = rel?.tagCommit?.committedDate || tagDate;
    const dates = [...(head?.year?.nodes?.map((c) => c.committedDate) || []), ...(more.get(n.nameWithOwner) || [])];
    let unreleased = null;
    if (since) {
      const count = dates.filter((d) => Date.parse(d) > Date.parse(since)).length;
      unreleased = Date.parse(since) < Date.parse(windowStart) ? `${count}+` : count;
    }
    const hasUnreleased = parseInt(unreleased, 10) > 0;
    const ci = head?.statusCheckRollup?.state || null;
    const failing = ci === "FAILURE" || ci === "ERROR";
    const issues = n.issues.totalCount, prs = n.pullRequests.totalCount;
    const relDownloads = rel ? sumDownloads(rel) : 0;
    const downloads = n.allReleases.nodes.reduce((a, r) => a + sumDownloads(r), 0);
    if (hasUnreleased) unreleasedRepos++;
    openTotal += issues + prs;
    if (ci) ciRuns++;
    if (failing) ciFailing++;
    downloadsTotal += downloads;
    if (rel) releaseRows.push({
      key: rel.tagName, title: n.name,
      note: n.allReleases.totalCount > 1 ? `${plural(downloads, "download", "downloads")} across ${n.allReleases.totalCount} releases` : "",
      strong: rel.releaseAssets.nodes.length ? String(relDownloads) : "", meta: rel.releaseAssets.nodes.length ? (relDownloads === 1 ? "download" : "downloads") : "",
      date: rel.publishedAt, href: rel.url, sortKey: Date.parse(rel.publishedAt),
    });

    const links = [{ label: "Repository", href: n.url }];
    if (n.homepageUrl) links.push({ label: "Homepage", href: /^https?:/.test(n.homepageUrl) ? n.homepageUrl : `https://${n.homepageUrl}` });
    for (const l of readmeLinks(f.readme?.text)) if (!links.some((x) => x.href.replace(/\/$/, "") === l.href.replace(/\/$/, ""))) links.push(l);
    if (rel) links.push({ label: "Releases", href: `${n.url}/releases` });
    if (ci) links.push({ label: "Actions", href: `${n.url}/actions` });

    const ciText = { SUCCESS: "Passing", FAILURE: "Failing", ERROR: "Error", PENDING: "Running", EXPECTED: "Waiting" }[ci];
    return {
      id: n.nameWithOwner,
      name: n.name,
      description: n.description || "",
      url: n.url,
      updatedAt: n.pushedAt,
      short: version?.value || "",
      badges: [n.isPrivate ? "Private" : "Public", ...(n.isFork ? ["Fork"] : []), ...(n.isArchived ? ["Archived"] : [])],
      marks: [
        ...(failing ? [{ tone: "fail", label: "CI", title: "CI failing" }] : ci === "PENDING" || ci === "EXPECTED" ? [{ tone: "pending", label: "CI", title: "CI running" }] : []),
        ...(hasUnreleased ? [{ tone: "accent", label: String(unreleased), title: "Commits since the last release" }] : []),
        ...(n.isPrivate ? [{ icon: "lock", title: "Private" }] : []),
        ...(n.isFork ? [{ icon: "fork", title: "Fork" }] : []),
        ...(n.isArchived ? [{ icon: "archive", title: "Archived" }] : []),
      ],
      facts: [
        version ? { label: "Version", value: version.value, note: `from ${version.source}` } : { label: "Version", value: "No version file found", absent: true },
        rel ? { label: "Latest release", value: rel.tagName, note: `${day(rel.publishedAt)}${rel.releaseAssets.nodes.length ? ` · ${plural(relDownloads, "download", "downloads")}` : ""}` }
          : tag ? { label: "Latest release", value: "None", note: `latest tag ${tag.name}`, absent: true } : { label: "Latest release", value: "Never released", absent: true },
        unreleased === null ? { label: "Unreleased", value: "—", note: "no release to compare", absent: true }
          : { label: "Unreleased", value: String(unreleased), note: hasUnreleased ? `commits since ${rel?.tagName || tag?.name}` : "up to date", tone: hasUnreleased ? "accent" : "", count: typeof unreleased === "number" ? unreleased : null },
        { label: "Last push", time: n.pushedAt },
        { label: "Issues · PRs", value: `${issues} · ${prs}`, note: "open" },
        ciText ? { label: "CI", value: ciText, note: n.defaultBranchRef?.name ? `on ${n.defaultBranchRef.name}` : "", tone: failing ? "fail" : "" } : { label: "CI", value: "No checks", absent: true },
        { label: "Stars · Forks", value: `${n.stargazerCount} · ${n.forkCount}` },
        { label: "Commits", value: (head?.all?.totalCount ?? 0).toLocaleString("en-US"), count: head?.all?.totalCount ?? 0, note: n.primaryLanguage ? `mostly ${n.primaryLanguage.name}` : "" },
      ],
      activity: dates,
      activityNoun: ["commit", "commits"],
      attention: [
        ...(failing ? [{ label: "CI failing", tone: "fail", text: head?.messageHeadline || "" }] : []),
        ...(prs ? [{ label: plural(prs, "open PR", "open PRs"), text: n.description || "" }] : []),
        ...(issues ? [{ label: plural(issues, "open issue", "open issues"), text: n.description || "" }] : []),
        ...(hasUnreleased ? [{ label: `${unreleased} since ${rel?.tagName || tag?.name}`, tone: "accent", text: head?.messageHeadline || "" }] : []),
        ...((Date.now() - Date.parse(n.pushedAt)) / DAY > 28 && !n.isArchived ? [{ label: `Quiet ${Math.round((Date.now() - Date.parse(n.pushedAt)) / DAY)} days`, text: n.description || "" }] : []),
      ],
      links,
    };
  });

  const sentence = `${unreleasedRepos ? `${unreleasedRepos} ${unreleasedRepos === 1 ? "repo has commits since its" : "repos have commits since their"} last release` : "Nothing is waiting on a release"}, ${openTotal ? `${plural(openTotal, "issue or PR is", "issues and PRs are")} open` : "nothing is open"}, and ${ciFailing ? `CI is failing in ${ciFailing}` : ciRuns ? `CI passes in all ${ciRuns} repos that run it` : "no repo runs CI"}.`;
  return {
    items,
    overview: {
      sentence,
      stats: [{ label: "Open issues + PRs", value: openTotal }, ...(downloadsTotal ? [{ label: "Release downloads", value: downloadsTotal }] : [])],
      sections: [{
        title: "Latest releases", total: downloadsTotal ? plural(downloadsTotal, "download", "downloads") : "", rows: releaseRows, empty: "No releases published yet.",
        footnote: downloadsTotal ? "Downloads count files attached to GitHub releases. Store installs and source-code zips aren't included." : "",
      }],
    },
  };
}

// ---------- detail ----------
const DETAIL_QUERY = `
query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    url
    allReleases: releases { totalCount }
    languages(first: 8, orderBy: { field: SIZE, direction: DESC }) { totalSize edges { size node { name } } }
    releases(first: 8, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName name publishedAt url isPrerelease isDraft releaseAssets(first: 20) { nodes { name downloadCount } } } }
    issues(states: OPEN, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title url updatedAt } }
    pullRequests(states: OPEN, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title url updatedAt isDraft } }
    defaultBranchRef { target { ... on Commit {
      recent: history(first: 25) { nodes { abbreviatedOid messageHeadline committedDate url additions deletions } }
      year: history(first: 100, since: $since, after: $after) { pageInfo { hasNextPage endCursor } nodes { committedDate } }
    } } }
  }
}`;

async function detail(id, options) {
  const bin = options.gh || "gh";
  const [owner, name] = id.split("/");
  let after = null, first = null;
  const dates = [];
  for (let page = 0; page < 10; page++) {
    const repo = (await graphql(bin, DETAIL_QUERY, { owner, name, since: weeksAgo(52), after })).repository;
    if (!repo) throw fail("not-found", `No repo named ${id}.`);
    first ??= repo;
    const year = repo.defaultBranchRef?.target?.year;
    if (!year) break;
    dates.push(...year.nodes.map((c) => c.committedDate));
    if (!year.pageInfo.hasNextPage) break;
    after = year.pageInfo.endCursor;
  }
  const head = first.defaultBranchRef?.target;
  const releases = first.releases.nodes.filter((r) => !r.isDraft);
  const repoDownloads = releases.reduce((a, r) => a + sumDownloads(r), 0);
  const totalLang = first.languages?.totalSize || 0;
  const open = [
    ...first.pullRequests.nodes.map((p) => ({ key: `#${p.number}`, title: p.title, note: p.isDraft ? "draft PR" : "PR", time: p.updatedAt, href: p.url, sortKey: Date.parse(p.updatedAt) })),
    ...first.issues.nodes.map((x) => ({ key: `#${x.number}`, title: x.title, note: "issue", time: x.updatedAt, href: x.url, sortKey: Date.parse(x.updatedAt) })),
  ].sort((a, b) => b.sortKey - a.sortKey);
  return {
    activity: dates,
    sections: [
      {
        title: "Recent commits", limit: 8, empty: "No commits on the default branch.",
        rows: (head?.recent?.nodes || []).map((c) => ({ key: c.abbreviatedOid, title: c.messageHeadline, strong: `+${c.additions.toLocaleString("en-US")}`, meta: `−${c.deletions.toLocaleString("en-US")}`, time: c.committedDate, href: c.url })),
      },
      {
        title: "Releases", half: true, total: repoDownloads ? plural(repoDownloads, "download", "downloads") : "",
        empty: "No GitHub releases yet.",
        rows: releases.map((r) => {
          const n = sumDownloads(r), assets = r.releaseAssets.nodes;
          return {
            key: r.tagName, title: r.name || r.tagName,
            note: [r.isPrerelease ? "pre-release" : "", assets.length > 1 ? assets.map((a) => `${a.name} ${a.downloadCount}`).join(", ") : ""].filter(Boolean).join(" · "),
            strong: assets.length ? String(n) : "", meta: assets.length ? (n === 1 ? "download" : "downloads") : "no files", date: r.publishedAt, href: r.url,
          };
        }),
        footnote: [first.allReleases.totalCount > releases.length ? `Showing the latest ${releases.length} of ${first.allReleases.totalCount} releases.` : "", repoDownloads ? "Downloads count files attached to GitHub releases. Store installs and source-code zips aren't included." : ""].filter(Boolean).join(" "),
      },
      { title: "Open PRs · issues", half: true, empty: "Nothing open.", rows: open },
      ...(first.languages?.edges?.length ? [{
        title: "Languages", rows: first.languages.edges.map((e) => ({ key: `${((e.size / totalLang) * 100).toFixed(e.size / totalLang < 0.1 ? 1 : 0)}%`, title: e.node.name })),
      }] : []),
    ],
  };
}

export default { list, detail };
