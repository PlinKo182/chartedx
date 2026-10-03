// ChartedX: Portugal Top 10 per streaming provider -> static Stremio catalog addon in docs/ (served by GitHub Pages).
// Source per provider: FlixPatrol daily Top 10 (= what the app shows) when it exists, else JustWatch weekly streamingCharts.
// Usage: node update.js                  update (FlixPatrol: CF_ACCOUNT_ID + CF_API_TOKEN, fallback FIRECRAWL_API_KEY)
//        node update.js <fixtureDir>     same, but FlixPatrol pages from saved fp-{slug}.html files
//        node update.js list-providers   write providers-available.json (pick shortNames from it into providers.json)
const fs = require('fs');
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {} // local runs; GitHub Action uses repo secrets

// JustWatch shortName -> FlixPatrol slug (lists available for Portugal: flixpatrol.com/about/availability/)
const FLIXPATROL = { nfx: 'netflix', prv: 'amazon-prime', mxx: 'hbo-max', atp: 'apple-tv', dnp: 'disney', sst: 'skyshowtime' };
const RPDB_KEY = process.env.RPDB_KEY || 't0-free-rpdb'; // public free tier; ends up visible in docs/ anyway
const MIN_ITEMS = 6; // fewer resolved titles -> keep yesterday's file
const LIST_SIZE = 30; // Popular / Trending length
// Per provider: Top 10 (FlixPatrol, else JustWatch weekly chart), then JustWatch provider-page orderings.
const LISTS = { top: null, popular: 'Populares', trending: 'Tendências' };
const DOCS = process.env.OUT || path.join(__dirname, 'docs');
const CACHE_FILE = path.join(__dirname, 'cache.json');

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s.replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const norm = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- JustWatch ----------

async function jw(query, variables) {
  const r = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`JustWatch ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
  await sleep(1500); // JustWatch 403-bans bursts (Omnicatalogs, ~1200 requests)
  return j.data;
}

// Providers JustWatch has registered for Portugal (country: PT) that have titles — sports-only ones have none.
// This is the list the justwatch.com/pt provider bar shows.
async function packages() {
  const { packages } = await jw(`query P($country: Country!) {
    packages(country: $country, platform: WEB, includeAddons: true) {
      shortName clearName monetizationTypes hasTitles(country: $country, platform: WEB)
      addonParent(country: $country, platform: WEB) { clearName } } }`, { country: 'PT' });
  return packages
    .filter(p => p.hasTitles)
    .map(p => ({ shortName: p.shortName, name: p.clearName, monetization: p.monetizationTypes, channelOf: p.addonParent?.clearName || null, flixpatrol: FLIXPATROL[p.shortName] || null }));
}

const toItem = ({ node: { content: c } }) => ({ slug: `jw:${c.title}:${c.originalReleaseYear}`, title: c.title, year: c.originalReleaseYear, imdbId: c.externalIds?.imdbId });
const CONTENT = 'content(country: $country, language: $language) { title originalReleaseYear externalIds { imdbId } }';

// sort 'CHART': weekly JustWatch Top 10 (rank is JustWatch-global, 7, 11, 12…; only the order matters; often empty for small providers).
// sort 'POPULAR' / 'TRENDING': the provider page on justwatch.com/pt/provedor/{x} with that ordering.
async function justwatchList(shortName, sort) {
  const lists = {};
  for (const [objectType, type] of [['MOVIE', 'movie'], ['SHOW', 'series']]) {
    const vars = { country: 'PT', language: 'en', obj: objectType, pk: [shortName] };
    lists[type] = sort === 'CHART'
      ? (await jw(`query C($country: Country!, $language: Language!, $obj: StreamingChartObjectType!, $pk: [String!]) {
          streamingCharts(country: $country, first: 10, filter: {category: WEEKLY_POPULARITY_SAME_CONTENT_TYPE, objectType: $obj, packages: $pk, previousTitles: 0, nextTitles: 0}) {
            edges { node { ${CONTENT} } } } }`, vars)).streamingCharts.edges.map(toItem)
      : (await jw(`query L($country: Country!, $language: Language!, $obj: ObjectType!, $pk: [String!], $sort: PopularTitlesSorting!) {
          popularTitles(country: $country, first: ${LIST_SIZE}, sortBy: $sort, filter: {packages: $pk, objectTypes: [$obj]}) {
            edges { node { ${CONTENT} } } } }`, { ...vars, sort })).popularTitles.edges.map(toItem);
  }
  return lists;
}

// ---------- FlixPatrol ----------

// { Movies: [{slug, title}], 'TV Shows': [...], Overall: [...] } — first table of each kind ("Kids" tables don't match)
function parse(html) {
  const lists = {};
  for (const m of html.matchAll(/TOP 10 (Movies|TV Shows|Overall)<\/h3>/g)) {
    if (lists[m[1]]) continue;
    const table = html.slice(m.index, html.indexOf('</table>', m.index));
    lists[m[1]] = [...table.matchAll(/href="\/title\/([^"/]+)\/"[^>]*>([^<]+)<\/a>/g)].slice(0, 10).map(x => ({ slug: x[1], title: decode(x[2]) }));
  }
  return lists;
}

// "TOP 10 on Netflix in Portugal on October 2, 2026 • FlixPatrol" -> 2026-10-02
function pageDate(html) {
  const m = html.match(/<title>[^<]* on (\w+ \d+, \d{4})/);
  return m ? new Date(m[1] + ' UTC').toISOString().slice(0, 10) : null;
}

// FlixPatrol's Cloudflare blocks plain fetch, r.jina.ai, headless Chrome and GitHub runners even headed (tested 2026-10-02/03).
// Scraping services that get through, tried in order; those without an API key in env are skipped.
// ScrapingAnt tested 2026-10-03: detected by FlixPatrol even with residential proxy. Scrapfly: works only with asp, 80 credits/page.
const SCRAPERS = {
  async CF_API_TOKEN(url, token) { // Cloudflare Browser Rendering, free plan (~10 browser-min/day), works (tested 2026-10-03)
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/browser-rendering/content`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, gotoOptions: { waitUntil: 'networkidle0' } }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.success) return j.result;
      if (j.errors?.[0]?.code !== 2001) return JSON.stringify(j).slice(0, 300);
      await sleep(15000); // free plan rate limit
    }
    return 'rate limited';
  },
  async FIRECRAWL_API_KEY(url, key) { // 1 credit/page, works (tested 2026-10-03)
    const r = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['rawHtml'], maxAge: 0 }),
    });
    return (await r.json()).data?.rawHtml || `HTTP ${r.status}`;
  },
};

async function scrape(slugs) {
  const pages = {};
  for (const slug of slugs) {
    const url = `https://flixpatrol.com/top10/${slug}/portugal/`;
    for (const [env, get] of Object.entries(SCRAPERS)) {
      if (!process.env[env]) continue;
      const html = await get(url, process.env[env]).catch(e => e.message);
      if (/TOP 10 [^<]*<\/h3>/.test(html)) { pages[slug] = html; console.log('flixpatrol', slug, 'via', env); break; }
      console.error('flixpatrol', slug, env, 'failed:', html.slice(0, 200));
    }
  }
  return pages;
}

// ---------- title -> IMDb (Cinemeta) ----------

// Year: given by JustWatch, or appended by FlixPatrol to slugs of ambiguous titles (the-gentlemen-2024),
// but not when it's part of the title (blade-runner-2049).
function yearOf({ slug, title, year }) {
  if (year) return year;
  const y = slug.match(/-((?:19|20)\d\d)$/)?.[1];
  return y && !norm(title).endsWith(y) ? +y : null;
}

async function search(type, title) {
  const r = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
  return r.ok ? (await r.json()).metas || [] : [];
}

// Only among Cinemeta's results for the full title, + year ±1 when known. No "first result" fallback: never guess.
// 1. exact normalized name
// 2. else a single released result whose name matches ours up to a ":" subtitle on either side:
//    "Monster: The Lizzie Borden Story" -> "Monster" (season of the anthology), "13 Hours: The Secret…" -> "13 Hours"
const base = s => norm(s.split(':')[0]);
function pick(metas, item) {
  const year = yearOf(item);
  const ok = metas.filter(m => !year || Math.abs(parseInt(m.releaseInfo) - year) <= 1);
  const exact = ok.find(m => norm(m.name) === norm(item.title));
  if (exact) return exact;
  const loose = ok.filter(m => m.releaseInfo && (norm(m.name) === base(item.title) || base(m.name) === norm(item.title)));
  return loose.length === 1 ? loose[0] : undefined;
}

async function popularity(type, id) {
  const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`);
  return r.ok ? (await r.json()).meta?.popularities?.moviedb || 0 : 0;
}

// types: ['movie'] / ['series'], or both for Overall lists (Disney+).
// Hit in both types (Modern Family series vs an obscure 2012 film): keep the one ≥10x more popular on TMDB, else unresolved.
async function resolve(item, types, cache) {
  if (item.imdbId) return { type: types[0], id: item.imdbId, name: item.title };
  const key = `${types.join('+')}|${item.slug}`;
  if (cache[key]) return cache[key];
  const hits = [];
  for (const type of types) {
    const m = pick(await search(type, item.title), item);
    if (m) hits.push({ type, id: m.id, name: m.name, pop: await (types.length > 1 ? popularity(type, m.id) : 0) });
  }
  hits.sort((a, b) => b.pop - a.pop);
  const hit = hits.length === 1 || (hits.length === 2 && hits[0].pop >= 10 * hits[1].pop && hits[0].pop > 0) ? hits[0] : null;
  if (!hit) return null;
  delete hit.pop;
  return (cache[key] = hit);
}

// ---------- main ----------

async function main() {
  if (process.argv[2] === 'list-providers') {
    // Same 48 providers, same order, as the provider bar on justwatch.com/pt (checked 2026-10-03).
    const all = await packages();
    write(path.join(__dirname, 'providers-available.json'), all);
    console.table(all.map(p => ({ shortName: p.shortName, name: p.name, source: p.flixpatrol ? 'FlixPatrol' : 'JustWatch', type: p.channelOf ? 'channel' : p.monetization.join('+') })));
    return;
  }

  const providers = read(path.join(__dirname, 'providers.json'), []);
  const names = Object.fromEntries((await packages()).map(p => [p.shortName, p.name]));
  const cache = read(CACHE_FILE, {});
  const status = read(path.join(DOCS, 'status.json'), {});
  const fixtureDir = process.argv[2];
  const fpSlugs = providers.map(sn => FLIXPATROL[sn]).filter(Boolean);
  const pages = fixtureDir
    ? Object.fromEntries(fpSlugs.map(s => [s, fs.readFileSync(path.join(fixtureDir, `fp-${s}.html`), 'utf8')]))
    : await scrape(fpSlugs);
  const now = new Date().toISOString();

  const catalogs = [];
  for (const sn of providers) {
    const fp = FLIXPATROL[sn];
    for (const list of Object.keys(LISTS)) {
      const id = `${sn}-${list}`;
      const fromFp = list === 'top' && fp;
      const st = { source: fromFp ? `https://flixpatrol.com/top10/${fp}/portugal/` : `JustWatch ${list === 'top' ? 'weekly chart' : list}`, checked: now, missing: [] };
      let plan = []; // [items, types they may resolve to]
      try {
        if (fromFp) {
          const lists = parse(pages[fp] || '');
          st.date = pageDate(pages[fp] || '');
          plan = lists.Overall && !lists.Movies && !lists['TV Shows'] ? [[lists.Overall, ['movie', 'series']]] : [[lists.Movies || [], ['movie']], [lists['TV Shows'] || [], ['series']]];
        } else {
          const lists = await justwatchList(sn, list === 'top' ? 'CHART' : list.toUpperCase());
          st.date = now.slice(0, 10);
          plan = [[lists.movie, ['movie']], [lists.series, ['series']]];
        }
      } catch (e) {
        st.error = e.message;
      }

      const out = { movie: [], series: [] };
      for (const [items, types] of plan) {
        for (const item of items) {
          const r = await resolve(item, types, cache);
          if (r && !out[r.type].some(x => x.id === r.id)) out[r.type].push(r);
          else if (!r) st.missing.push(item.title);
        }
      }
      for (const type of ['movie', 'series']) {
        const file = path.join(DOCS, 'catalog', type, `${id}.json`);
        if (out[type].length >= MIN_ITEMS) {
          write(file, { metas: out[type].map(r => ({ id: r.id, type, name: r.name, poster: `https://api.ratingposterdb.com/${RPDB_KEY}/imdb/poster-default/${r.id}.jpg`, posterShape: 'poster' })) });
          st[type] = { updated: st.date, count: out[type].length };
        } else {
          st[type] = { ...status[id]?.[type], error: `only ${out[type].length} resolved, kept previous file` };
        }
        if (fs.existsSync(file)) {
          catalogs.push({ type, id, name: `${names[sn] || sn} · ${list === 'top' ? (fp ? 'Top 10' : 'Top JustWatch') : LISTS[list]}` });
        }
      }
      status[id] = st;
      console.log(id.padEnd(16), st.date, 'movies', out.movie.length, 'series', out.series.length, st.error || '', st.missing.length ? `missing: ${st.missing.join(', ')}` : '');
    }
  }

  write(path.join(DOCS, 'manifest.json'), {
    id: 'community.chartedx',
    version: '1.0.0',
    name: 'ChartedX',
    description: 'Plataformas de streaming em Portugal. "Top 10" = FlixPatrol diário (igual à app); "Top JustWatch" = top semanal do JustWatch; Populares / Tendências = páginas de cada plataforma no JustWatch.',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs,
  });
  write(path.join(DOCS, 'status.json'), status);
  write(CACHE_FILE, cache);
}

module.exports = { parse, resolve, yearOf, scrape };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
