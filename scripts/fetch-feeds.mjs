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
  config.sources.push({ tab: "youtube", name: yt.name, youtube: yt.channel || yt.handle, max: yt.max || 6 });
}

// "people" in feeds.json: follow these names quietly in Celebs (and their photos in Pictures).
const people = config.people || [];
if (people.length) {
  for (const name of people) {
    const slug = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    config.sources.push({ tab: "celebs", name: "Showbiz", url: `https://www.dailymail.co.uk/tvshowbiz/${slug}/index.rss`, pictures: true, max: 6, quiet: true });
  }
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
  processEntities: true,
  htmlEntities: true,
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
  let url = candidates[0].url;
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
  return text(it.guid) || "";
}

function normalise(it, src) {
  let title = stripHtml(text(it.title));
  let sourceName = src.name;
  const link = linkOf(it);
  // Google News: "Headline - Publisher"
  if (/news\.google\.com/.test(src.url)) {
    const pub = text(it.source);
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

async function load(src, i) {
  try {
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

const out = {
  updated: new Date().toISOString(),
  tabs: config.tabs,
  health: (() => {
    const h = [], quiet = { name: "Showbiz extras", tab: "celebs", ok: true, count: 0, working: 0, total: 0 };
    results.forEach((r, i) => {
      if (config.sources[i].quiet) { quiet.total++; if (r.ok) { quiet.working++; quiet.count += r.count; } return; }
      h.push({ name: r.name, tab: r.tab, ok: r.ok, count: r.count || 0, error: r.error });
    });
    if (quiet.total) { quiet.ok = quiet.working > 0; quiet.name += ` (${quiet.working}/${quiet.total} working)`; h.push(quiet); }
    return h;
  })(),
  items,
};
await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(new URL("data/feed.json", ROOT), JSON.stringify(out));
const broken = results.filter((r) => !r.ok);
console.log(`${items.length} posts from ${results.length - broken.length}/${results.length} sources.`);
for (const b of broken) console.log(`  ✗ ${b.name}: ${b.error}`);
