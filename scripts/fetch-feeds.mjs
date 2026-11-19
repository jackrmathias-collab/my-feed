// Collects the latest posts from every source in feeds.json and writes data/feed.json.
// Runs on GitHub every 30 minutes. You shouldn't need to touch this file.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("feeds.json", ROOT), "utf8"));
const MAX_AGE_DAYS = 7;

// "people" in feeds.json: follow these names quietly in Celebs (and their photos in Pictures).
const people = config.people || [];
if (people.length) {
  for (const name of people) {
    const slug = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    config.sources.push({ tab: "celebs", name: "Showbiz", url: `https://www.dailymail.co.uk/tvshowbiz/${slug}/index.rss`, pictures: true, max: 8, quiet: true });
  }
  const q = people.map((n) => `%22${encodeURIComponent(n).replace(/%20/g, "+")}%22`).join("+OR+");
  config.sources.push({ tab: "celebs", name: "Showbiz news", url: `https://news.google.com/rss/search?q=(${q})+when:7d&hl=en-GB&gl=GB&ceid=GB:en`, max: 10, quiet: true });
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
  for (const g of arr(it["media:group"])) for (const m of arr(g["media:content"])) add(m["@url"], m["@width"]);
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
  const rawSummary = text(it.description) || text(it.summary) || text(it["media:description"]) || text(it.content);
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

async function getXml(src, i) {
  if (FIXTURES) return readFile(`${FIXTURES}/${i}.xml`, "utf8");
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
  health: results.map(({ name, tab, ok, count, error }) => ({ name, tab, ok, count: count || 0, error })),
  items,
};
await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(new URL("data/feed.json", ROOT), JSON.stringify(out));
const broken = results.filter((r) => !r.ok);
console.log(`${items.length} posts from ${results.length - broken.length}/${results.length} sources.`);
for (const b of broken) console.log(`  ✗ ${b.name}: ${b.error}`);
