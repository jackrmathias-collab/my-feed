// Collects the latest posts from every source in feeds.json and writes data/feed.json.
// Runs on GitHub every 30 minutes. You shouldn't need to touch this file.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("feeds.json", ROOT), "utf8"));
const MAX_AGE_DAYS = 7;

// "youtube" in feeds.json: new uploads from these channels go in the YouTube tab.
for (const yt of config.youtube || []) {
  config.sources.push({ tab: yt.tab || "youtube", name: yt.name, youtube: yt.channel || yt.handle, max: yt.max || 6 });
}

// "artists" in feeds.json: new DJ mixes featuring them (from Mixcloud, where NTS, Rinse and lots of radio shows post).
const artists = config.artists || [];
for (const a of artists) config.sources.push({ tab: "mixes", name: a, mixcloud: a, max: 4, quiet: true, quietName: "Mixcloud searches" });
// Podcasts by Apple Podcasts id (we look up their feed address automatically)
for (const p of config.mixPodcasts || []) config.sources.push({ tab: "mixes", name: p.name, apple: p.apple, max: p.max || 6 });

// "people" in feeds.json: follow these names quietly in Celebs (and their photos in Pictures).
const people = config.people || [];
if (people.length) {
  for (const name of people) {
    const slug = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    config.sources.push({ tab: "celebs", name: "Showbiz", url: `https://www.dailymail.co.uk/tvshowbiz/${slug}/index.rss`, pictures: true, max: 6, quiet: true });
  }
  const gossip = [
    "https://www.dailymail.co.uk/tvshowbiz/index.rss",
    "https://www.dailymail.co.uk/femail/index.rss",
    "https://www.justjared.com/feed/",
    "https://www.thesun.co.uk/tvandshowbiz/feed/",
    "https://hollywoodlife.com/feed/",
  ];
  for (const url of gossip) config.sources.push({ tab: "celebs", name: "Showbiz", url, pictures: true, only: people, max: 30, quiet: true });
  for (let i = 0; i < people.length; i += 8) {
    const q = people.slice(i, i + 8).map((n) => `%22${encodeURIComponent(n).replace(/%20/g, "+")}%22`).join("+OR+");
    config.sources.push({ tab: "celebs", name: "Showbiz news", url: `https://news.google.com/rss/search?q=(${q})+when:3d&hl=en-GB&gl=GB&ceid=GB:en`, max: 10, quiet: true });
  }
}
const DEFAULT_MAX = 25;
const FIXTURES = process.env.FIXTURES; // local testing only

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: false,
  processEntities: false, // we decode entities ourselves (some big feeds trip the parser's limit)
  htmlEntities: false,
  removeNSPrefix: false,
});

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => {
  if (x == null) return "";
  if (typeof x === "string" || typeof x === "number") return String(x);
  if (Array.isArray(x)) return text(x[0]);
  return text(x["#text"] ?? "");
};
const decode = (s) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
   .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
   .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
   .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const stripHtml = (s) => decode(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

function pickImage(it) {
  const candidates = [];
  const add = (url, w = 0) => { if (url && /^https?:/.test(url)) candidates.push({ url, w: +w || 0 }); };
  for (const m of arr(it["media:content"])) {
    if (!m["@medium"] || m["@medium"] === "image" || /\.(jpe?g|png|webp)/i.test(m["@url"] || "")) add(m["@url"], m["@width"]);
  }
  for (const g of arr(it["media:group"])) {
    for (const t of arr(g["media:thumbnail"])) add(t["@url"], t["@width"]);
    for (const m of arr(g["media:content"])) if (/^image/.test(m["@type"] || "") || m["@medium"] === "image") add(m["@url"], m["@width"]);
  }
  for (const t of arr(it["media:thumbnail"])) add(t["@url"], t["@width"]);
  for (const e of arr(it.enclosure)) if (/^image/.test(e["@type"] || "") || /\.(jpe?g|png|webp)/i.test(e["@url"] || "")) add(e["@url"]);
  if (it["itunes:image"]) add(it["itunes:image"]["@href"]);
  if (!candidates.length) {
    const html = text(it["content:encoded"]) + text(it.description) + text(it.content) + text(it.summary);
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) add(decode(m[1]));
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.w - a.w);
  let url = decode(candidates[0].url);
  // BBC sends tiny thumbnails; ask for a bigger size.
  url = url.replace(/(ichef\.bbci\.co\.uk\/(?:ace\/standard|news)\/)\d+\//, "$1800/");
  return url;
}

function linkOf(it) {
  if (typeof it.link === "string") return it.link.trim();
  for (const l of arr(it.link)) {
    if (typeof l === "string") return l.trim();
    if (l["@href"] && (!l["@rel"] || l["@rel"] === "alternate")) return l["@href"];
  }
  const g = text(it.guid);
  if (/^https?:/.test(g)) return g;
  for (const e of arr(it.enclosure)) if (e["@url"]) return e["@url"]; // podcasts: the episode audio
  return "";
}

function normalise(it, src) {
  let title = stripHtml(text(it.title));
  let sourceName = src.name;
  const link = decode(linkOf(it));
  // Google News: "Headline - Publisher"
  if (/news\.google\.com/.test(src.url)) {
    const pub = decode(text(it.source));
    if (pub) {
      sourceName = pub;
      title = title.replace(new RegExp("\\s+-\\s+" + pub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), "");
    }
  }
  const dateStr = text(it.pubDate) || text(it.published) || text(it.updated) || text(it["dc:date"]);
  const date = dateStr ? new Date(dateStr) : null;
  const rawSummary = text(it.description) || text(it.summary) || text(it["media:description"]) || text(it["media:group"]?.["media:description"]) || text(it.content);
  let summary = /news\.google\.com/.test(src.url) ? "" : clip(stripHtml(rawSummary), 220);
  if (summary && title && summary.startsWith(title)) summary = summary.slice(title.length).trim();
  return {
    title,
    link,
    source: sourceName,
    tab: src.tab,
    date: date && !isNaN(date) ? date.toISOString() : null,
    image: pickImage(it),
    summary,
    pictures: !!src.pictures,
    ...(src.tab === "mixes" || src.tab === "podcasts" ? (() => { const d = text(it["itunes:duration"]); if (!d) return {}; const p = d.split(":").map(Number); const secs = p.reduce((a, b) => a * 60 + b, 0); return secs > 600 ? { mins: Math.round(secs / 60), mix: src.tab === "mixes" } : {}; })() : {}),
  };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

// Turns a YouTube @handle into the channel's feed address.
async function youtubeFeed(id) {
  if (/^UC[\w-]{22}$/.test(id)) return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
  const handle = id.startsWith("@") ? id : "@" + id;
  const res = await fetch(`https://www.youtube.com/${handle}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-GB", Cookie: "CONSENT=YES+1; SOCS=CAI" },
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  const m = html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || html.match(/"channelId":"(UC[\w-]{22})"/);
  if (!m) throw new Error(`Couldn't find YouTube channel ${handle}`);
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`;
}

async function getXml(src, i) {
  if (FIXTURES) return readFile(`${FIXTURES}/${i}.xml`, "utf8");
  if (src.youtube) src.url = await youtubeFeed(src.youtube);
  const res = await fetch(src.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MyFeed/1.0; personal RSS reader)",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function mixcloud(src) {
  const j = await (await fetch(`https://api.mixcloud.com/search/?q=${encodeURIComponent(src.mixcloud)}&type=cloudcast&limit=40`, { signal: AbortSignal.timeout(15000) })).json();
  const name = src.mixcloud.toLowerCase(), cutoff = Date.now() - 120 * 864e5;
  return (j.data || [])
    .filter((c) => (c.name || "").toLowerCase().includes(name) && Date.parse(c.created_time) > cutoff)
    .sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))
    .slice(0, src.max || 4)
    .map((c) => ({ title: c.name, link: c.url, source: c.user?.name || "Mixcloud", tab: src.tab, date: new Date(c.created_time).toISOString(),
      image: c.pictures?.extra_large || c.pictures?.large || null, summary: (c.tags || []).map((t) => t.name).slice(0, 4).join(" · "), pictures: false,
      mins: c.audio_length ? Math.round(c.audio_length / 60) : undefined, mix: true }));
}

async function load(src, i) {
  try {
    if (src.mixcloud && !FIXTURES) { const out = await mixcloud(src); return { name: src.name, tab: src.tab, ok: true, count: out.length, items: out }; }
    if (src.apple && !FIXTURES && !src.url) {
      const lk = await (await fetch(`https://itunes.apple.com/lookup?id=${src.apple}`, { signal: AbortSignal.timeout(15000) })).json();
      src.url = lk.results?.[0]?.feedUrl; if (!src.url) throw new Error("Couldn't find podcast feed");
    }
    const xml = await getXml(src, i);
    const doc = parser.parse(xml);
    const items = doc.rss ? arr(doc.rss.channel?.item) : doc.feed ? arr(doc.feed.entry) : doc["rdf:RDF"] ? arr(doc["rdf:RDF"].item) : null;
    if (!items) throw new Error("Not an RSS/Atom feed");
    const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
    const out = items
      .map((it) => normalise(it, src))
      .filter((x) => x.title && x.link && (!x.date || Date.parse(x.date) > cutoff))
      .filter((x) => {
        const hay = (x.title + " " + x.summary).toLowerCase();
        if (src.only && !src.only.some((w) => hay.includes(w.toLowerCase()))) return false;
        if (src.skip && src.skip.some((w) => hay.includes(w.toLowerCase()))) return false;
        return true;
      })
      .slice(0, src.max || DEFAULT_MAX);
    return { name: src.name, tab: src.tab, ok: true, count: out.length, items: out };
  } catch (e) {
    return { name: src.name, tab: src.tab, ok: false, error: String(e.message || e), items: [] };
  }
}

const results = [];
const queue = config.sources.map((s, i) => [s, i]);
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) { const [s, i] = queue.shift(); results[i] = await load(s, i); }
}));

// Merge, remove duplicates (same story from two places), newest first.
const seen = new Set();
const items = [];
for (const r of results) for (const it of r.items) {
  const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
  if (seen.has(key) || seen.has(it.link)) continue;
  seen.add(key); seen.add(it.link);
  it.id = createHash("sha1").update(it.link).digest("hex").slice(0, 12);
  items.push(it);
}
items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
// Star anything that mentions one of your artists
const artistRe = artists.length ? new RegExp("\\b(" + artists.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i") : null;
if (artistRe) for (const it of items) { const m = it.title.match(artistRe); if (m) it.fav = m[1]; }

// ---------- Extras: bigger photos and reading times ----------
// Reuse what we worked out last time, so each refresh only visits brand-new articles.
const prevCache = new Map();
if (!FIXTURES && process.env.GITHUB_REPOSITORY) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  try {
    const prev = await (await fetch(`https://${owner.toLowerCase()}.github.io/${repo}/data/feed.json`, { signal: AbortSignal.timeout(15000) })).json();
    for (const it of prev.items || []) if (it.big || it.mins || it.checked) prevCache.set(it.link, { big: it.big, mins: it.mins });
  } catch {}
}
const wantsExtras = (it) => (it.pictures || it.tab === "longreads" || it.tab === "film" || it.tab === "tv") &&
  /^https?:/.test(it.link) && !/news\.google\.com|youtube\.com|\.mp3|megaphone|acast/.test(it.link);
async function extras(it) {
  const res = await fetch(it.link, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(10000), redirect: "follow" });
  if (!res.ok) return {};
  const html = (await res.text()).slice(0, 1_500_000);
  const out = {};
  const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  // The Guardian stamps its logo on share images, so keep its normal photo instead.
  if (og && !/guim\.co\.uk/.test(og[1])) out.big = decode(og[1]);
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  const words = (body.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).map(stripHtml).join(" ").split(/\s+/).filter(Boolean).length;
  if (words > 350) out.mins = Math.max(1, Math.round(words / 230));
  return out;
}
if (!FIXTURES) {
  const todo = [];
  for (const it of items) {
    if (!wantsExtras(it)) continue;
    const c = prevCache.get(it.link);
    if (c) { if (c.big) it.big = c.big; if (c.mins) it.mins = c.mins; it.checked = 1; }
    else todo.push(it);
  }
  const batch = todo.slice(0, 160);
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (batch.length) { const it = batch.shift(); try { Object.assign(it, await extras(it)); } catch {} it.checked = 1; }
  }));
  console.log(`Extras: ${prevCache.size} remembered, ${Math.min(todo.length, 160)} new articles checked.`);
}

// ---------- Arsenal: next match and last result ----------
async function arsenalFixtures() {
  const leagues = ["eng.1", "uefa.champions", "eng.fa", "eng.league_cup"];
  const events = new Map();
  for (const lg of leagues) for (const q of ["", "?fixture=true"]) {
    try {
      const j = await (await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams/359/schedule${q}`, { signal: AbortSignal.timeout(12000) })).json();
      for (const e of j.events || []) events.set(e.id, { e, league: j.events && (e.league?.name || e.season?.displayName || lg) , lg });
    } catch {}
  }
  const names = { "eng.1": "Premier League", "uefa.champions": "Champions League", "eng.fa": "FA Cup", "eng.league_cup": "Carabao Cup" };
  const simple = ({ e, lg }) => {
    const c = e.competitions?.[0] || {};
    const teams = (c.competitors || []).map((t) => ({
      name: t.team?.shortDisplayName || t.team?.displayName, home: t.homeAway === "home",
      logo: t.team?.logos?.[0]?.href || t.team?.logo, score: t.score?.displayValue ?? t.score?.value ?? null, arsenal: String(t.team?.id || t.id) === "359",
    }));
    return { date: e.date, comp: names[lg] || lg, venue: c.venue?.fullName || "", state: c.status?.type?.state || e.status?.type?.state, done: !!(c.status?.type?.completed || e.status?.type?.completed), teams };
  };
  const all = [...events.values()].map(simple).filter((m) => m.teams.length === 2).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const now = Date.now();
  const next = all.find((m) => !m.done && Date.parse(m.date) > now - 3 * 3600e3);
  const last = [...all].reverse().find((m) => m.done);
  return next || last ? { next, last } : null;
}
let arsenal = null;
if (!FIXTURES) {
  arsenal = await arsenalFixtures().catch(() => null);
  console.log(arsenal?.next ? `Arsenal next: ${arsenal.next.teams.map((t) => t.name).join(" v ")} ${arsenal.next.date}` : "Arsenal fixtures: none found");
} else {
  const d = new Date(Date.now() + 2.3 * 864e5); d.setUTCHours(17, 30, 0, 0);
  arsenal = { next: { date: d.toISOString(), comp: "Premier League", venue: "Emirates Stadium", state: "pre", done: false, teams: [{ name: "Arsenal", home: true, arsenal: true, logo: null }, { name: "Chelsea", home: false, logo: null }] },
    last: { date: new Date(Date.now() - 4 * 864e5).toISOString(), comp: "Champions League", done: true, teams: [{ name: "Arsenal", home: true, arsenal: true, score: "3" }, { name: "Inter", home: false, score: "1" }] } };
}

const out = {
  updated: new Date().toISOString(),
  tabs: config.tabs,
  arsenal,
  health: (() => {
    const h = [], groups = {};
    results.forEach((r, i) => {
      const src = config.sources[i];
      if (src.quiet) {
        const g = (groups[src.quietName || "Showbiz extras"] ||= { name: src.quietName || "Showbiz extras", tab: src.tab, count: 0, working: 0, total: 0 });
        g.total++; if (r.ok) { g.working++; g.count += r.count; } return;
      }
      h.push({ name: r.name, tab: r.tab, ok: r.ok, count: r.count || 0, error: r.error });
    });
    for (const g of Object.values(groups)) h.push({ ...g, ok: g.working > 0, name: `${g.name} (${g.working}/${g.total} working)` });
    return h;
  })(),
  items,
};
await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(new URL("data/feed.json", ROOT), JSON.stringify(out));
const broken = results.filter((r) => !r.ok);
console.log(`${items.length} posts from ${results.length - broken.length}/${results.length} sources.`);
for (const b of broken) console.log(`  ✗ ${b.name}: ${b.error}`);
