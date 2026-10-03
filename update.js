// ChartedX: streaming tops for Portugal -> Stremio catalog addon. Builds docs/ daily (GitHub Action); api/ serves it (Vercel).
// Platforms: FlixPatrol daily Top 10 (= what the app shows). JustWatch card: justwatch.com lists. Estreias: TMDB.
// Usage: node update.js                  update (FlixPatrol: CF_ACCOUNT_ID + CF_API_TOKEN, fallback FIRECRAWL_API_KEY)
//        node update.js <fixtureDir>     same, but FlixPatrol pages from saved fp-{slug}.html files
//        node update.js list-providers   write providers-available.json (pick shortNames from it into providers.json)
const fs = require('fs');
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {} // local runs; GitHub Action uses repo secrets

// JustWatch shortName -> FlixPatrol slug (lists available for Portugal: flixpatrol.com/about/availability/)
const FLIXPATROL = { nfx: 'netflix', prv: 'amazon-prime', mxx: 'hbo-max', atp: 'apple-tv', dnp: 'disney', sst: 'skyshowtime' };
const RPDB_KEY = process.env.RPDB_KEY || 't0-free-rpdb'; // public free tier; ends up visible in docs/ anyway
// Stremio type of the catalogs mixing movies and series (each item keeps its own type)
const MIX = 'Filmes e Séries';
const MIN_ITEMS = 6; // fewer resolved titles -> keep yesterday's file
const NEW_DAYS = 7; // Novidades window; one separator poster per day
const NEW_PER_DAY = 15; // general Novidades (all platforms): titles kept per day
const DOCS = process.env.OUT || path.join(__dirname, 'docs');
const CACHE_FILE = path.join(__dirname, 'cache.json');

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s.replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const isoDay = daysAgo => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
const norm = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- JustWatch ----------

let pause = 1500; // between JustWatch requests in the daily run; 0 when the API builds a list live
async function jw(query, variables) {
  // ~300 requests in a run hit 429 (2026-10-03): back off and retry instead of losing the list
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://apis.justwatch.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 429 && attempt < 5) {
      await sleep((+r.headers.get('retry-after') || 30 * (attempt + 1)) * 1000);
      continue;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) throw new Error(`JustWatch ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
    await sleep(pause); // JustWatch 403-bans bursts (Omnicatalogs, ~1200 requests)
    return j.data;
  }
}

// Providers JustWatch has registered for Portugal (country: PT) that have titles — sports-only ones have none.
// This is the list the justwatch.com/pt provider bar shows.
async function packages() {
  const { packages } = await jw(`query P($country: Country!) {
    packages(country: $country, platform: WEB, includeAddons: true) {
      shortName clearName monetizationTypes icon(profile: S100) hasTitles(country: $country, platform: WEB)
      addonParent(country: $country, platform: WEB) { clearName } } }`, { country: 'PT' });
  return packages
    .filter(p => p.hasTitles)
    .map(p => ({ shortName: p.shortName, name: p.clearName, monetization: p.monetizationTypes, channelOf: p.addonParent?.clearName || null, flixpatrol: FLIXPATROL[p.shortName] || null, icon: `https://images.justwatch.com${p.icon.replace('{format}', 'png')}` }));
}

const toItem = ({ node: { objectType, content: c } }) => ({ slug: `jw:${c.title}:${c.originalReleaseYear}`, title: c.title, year: c.originalReleaseYear, imdbId: c.externalIds?.imdbId, kind: objectType });
const CONTENT = 'objectType content(country: $country, language: $language) { title originalReleaseYear externalIds { imdbId } }';

// popularTitles for movies and series separately. packages / genres: [] = no filter.
// TRENDING with no package = the "Top 10 … esta semana" rows on justwatch.com (checked 2026-10-03).
async function justwatchList({ packages = [], genres = [] }, sort, size) {
  const lists = {};
  for (const [objectType, type] of [['MOVIE', 'movie'], ['SHOW', 'series']]) {
    lists[type] = (await jw(`query L($country: Country!, $language: Language!, $obj: ObjectType!, $pk: [String!], $g: [String!], $sort: PopularTitlesSorting!) {
      popularTitles(country: $country, first: ${size}, sortBy: $sort, filter: {packages: $pk, genres: $g, objectTypes: [$obj]}) {
        edges { node { ${CONTENT} } } } }`, { country: 'PT', language: 'en', obj: objectType, pk: packages, g: genres, sort })).popularTitles.edges.map(toItem);
  }
  return lists;
}

// What arrived on the platforms in Portugal over the last NEW_DAYS days (justwatch.com/pt/novo).
// One paged query per day; a new season counts as its show. → [item + day], newest day first, JustWatch's order within a day
async function justwatchNew(packages = []) {
  const items = [];
  for (let d = 0; d < NEW_DAYS; d++) {
    const day = isoDay(d);
    let after = null;
    do {
      const { newTitles } = await jw(`query N($country: Country!, $language: Language!, $date: Date!, $after: String, $pk: [String!]) {
        newTitles(country: $country, date: $date, first: 100, after: $after, pageType: NEW, filter: {packages: $pk}) {
          pageInfo { hasNextPage endCursor }
          edges { node { ${CONTENT} ... on Season { show { ${CONTENT} } } } } } }`,
      { country: 'PT', language: 'en', date: day, after, pk: packages });
      for (const e of newTitles.edges) items.push({ ...toItem({ node: e.node.show || e.node }), day });
      after = newTitles.pageInfo.hasNextPage ? newTitles.pageInfo.endCursor : null;
    } while (after);
  }
  return items;
}

async function genres() {
  return (await jw('query { genres { shortName translation(language: "pt") } }', {})).genres;
}

// ---------- JustWatch card: the justwatch.com lists for Portugal, limited to the user's platforms ----------
// Each list: get({ packages }) → { movie, series, mix } items; packages [] = all platforms.
// The daily Action builds them for all platforms (docs/); the API builds them live for a user's platforms.

const byKind = items => ({ movie: items.filter(i => i.kind === 'MOVIE'), series: items.filter(i => i.kind !== 'MOVIE') });
// Novidades: 60–600 titles a day for all platforms, so the first NEW_PER_DAY of each day;
// a title landing on several platforms the same week counts once, on its newest day
const firstPerDay = items => {
  const perDay = {}, seen = new Set();
  return items.filter(it => !seen.has(it.slug) && seen.add(it.slug) && (perDay[it.day] = (perDay[it.day] || 0) + 1) <= NEW_PER_DAY);
};

// "Mais vistos": JustWatch streamingCharts (DAILY / WEEKLY / MONTHLY), with the trend
async function jwChart(period, { packages = [] }, size = 10) {
  const out = {};
  for (const [obj, type] of [['MOVIE', 'movie'], ['SHOW', 'series']]) {
    out[type] = (await jw(`query C($country: Country!, $language: Language!, $obj: StreamingChartObjectType!, $pk: [String!]) {
      streamingCharts(country: $country, first: ${size}, filter: {category: ${period}_POPULARITY_SAME_CONTENT_TYPE, objectType: $obj, packages: $pk}) {
        edges { streamingChartInfo { rank trend trendDifference } node { ${CONTENT} } } } }`, { country: 'PT', language: 'en', obj, pk: packages }))
      .streamingCharts.edges.map(e => ({ ...toItem(e), rank: e.streamingChartInfo.rank, rise: e.streamingChartInfo.trend === 'UP' ? e.streamingChartInfo.trendDifference : 0 }));
  }
  return out;
}
async function jwCharts(period, f) {
  const l = await jwChart(period, f);
  return { ...l, mix: [...l.movie, ...l.series].sort((a, b) => a.rank - b.rank).slice(0, 10) };
}
// "A subir hoje": biggest climbers in today's chart (≈ JustWatch "Going viral")
async function jwRising(f) {
  const l = await jwChart('DAILY', f, 100);
  const up = list => list.filter(i => i.rise > 0).sort((a, b) => b.rise - a.rise).slice(0, 10);
  return { movie: up(l.movie), series: up(l.series), mix: up([...l.movie, ...l.series]) };
}
// popularTitles ordering: TRENDING (= the "Top 10 … esta semana" rows), POPULAR_7_DAYS, POPULAR_180_DAYS
async function jwPopular(sort, { packages = [], genres = [] }, size) {
  const l = await justwatchList({ packages, genres }, sort, size);
  const mix = (await jw(`query M($country: Country!, $language: Language!, $pk: [String!], $g: [String!], $sort: PopularTitlesSorting!) {
    popularTitles(country: $country, first: ${size}, sortBy: $sort, filter: {packages: $pk, genres: $g, objectTypes: [MOVIE, SHOW]}) {
      edges { node { ${CONTENT} } } } }`, { country: 'PT', language: 'en', pk: packages, g: genres, sort })).popularTitles.edges.map(toItem);
  return { ...l, mix };
}
// "Em breve": coming to the platforms (justwatch.com/pt/novo, upcoming)
async function jwSoon({ packages = [] }) {
  const seen = new Set();
  const items = (await jw(`query U($country: Country!, $language: Language!, $pk: [String!]) {
    newTitles(country: $country, first: 40, pageType: UPCOMING, filter: {packages: $pk}) {
      edges { node { ${CONTENT} ... on Season { show { ${CONTENT} } } } } } }`, { country: 'PT', language: 'en', pk: packages }))
    .newTitles.edges.map(e => toItem({ node: e.node.show || e.node })).filter(i => !seen.has(i.slug) && seen.add(i.slug));
  return { ...byKind(items), mix: items.slice(0, 30) };
}
// "Novidades": by day (separator posters); all = the daily run's already-fetched list for all platforms
async function jwNew({ packages = [] }, all) {
  const items = all || await justwatchNew(packages);
  const { movie, series } = byKind(items);
  return { movie: firstPerDay(movie), series: firstPerDay(series), mix: firstPerDay(items) };
}

// catalog id → [Stremio row name, get]; genres: g{code}-top (Top 10 em alta do género)
const JW_CARD = {
  'all-daily': ['Mais vistos hoje', f => jwCharts('DAILY', f)],
  'all-weekly': ['Mais vistos da semana', f => jwCharts('WEEKLY', f)],
  'all-monthly': ['Mais vistos do mês', f => jwCharts('MONTHLY', f)],
  'all-top': ['Em alta', f => jwPopular('TRENDING', f, 10)],
  'all-rising': ['A subir hoje', jwRising],
  'all-pop7': ['Populares 7 dias', f => jwPopular('POPULAR_7_DAYS', f, 20)],
  'all-pop180': ['Populares 180 dias', f => jwPopular('POPULAR_180_DAYS', f, 20)],
  'all-new': ['Novidades', jwNew],
  'all-soon': ['Em breve', jwSoon],
};
const jwCardGet = id => JW_CARD[id]?.[1] || (/^g[a-z]{3}-top$/.test(id) ? f => jwPopular('TRENDING', { ...f, genres: [id.slice(1, 4)] }, 10) : null);

// Stremio metas for one bucket; days → a separator poster before each day (the API makes "/sep/…" absolute)
function toMetas(list, bucket, days) {
  const metas = [];
  let prevDay;
  for (const r of list) {
    if (days && r.day !== prevDay) {
      prevDay = r.day;
      const { top, big, bottom } = sepLabel(r.day);
      metas.push({ id: `chartedx:sep:${r.day}`, type: bucket === 'mix' ? 'movie' : bucket, name: `${top} · ${big} ${bottom}`, poster: `/sep/${r.day}.png`, posterShape: 'poster' });
    }
    metas.push({ id: r.id, type: r.type, name: r.name, poster: `https://api.ratingposterdb.com/${RPDB_KEY}/imdb/poster-default/${r.id}.jpg`, posterShape: 'poster' });
  }
  return metas;
}

// API: one JustWatch-card catalog for the user's platforms, built on request (Vercel's CDN caches the answer)
async function liveCatalog(id, bucket, packages) {
  const get = jwCardGet(id);
  if (!get) return null;
  pause = 0;
  const lists = await get({ packages });
  const cache = read(CACHE_FILE, {});
  const out = [];
  for (const item of lists[bucket] || []) {
    const r = await resolve(item, bucket === 'mix' ? [item.kind === 'MOVIE' ? 'movie' : 'series'] : [bucket], cache).catch(() => null);
    if (r && !out.some(x => x.id === r.id)) out.push(item.day ? { ...r, day: item.day } : r);
  }
  return toMetas(out, bucket, id === 'all-new');
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
// A season's year (Monster: The Lizzie Borden Story, 2026) is later than the series' start (Monster, 2022-), so a loose series
// match only needs to have started by then.
function pick(metas, item, type) {
  const year = yearOf(item);
  const ok = metas.filter(m => !year || Math.abs(parseInt(m.releaseInfo) - year) <= 1);
  const exact = ok.find(m => norm(m.name) === norm(item.title));
  if (exact) return exact;
  const started = metas.filter(m => !year || (type === 'series' ? parseInt(m.releaseInfo) <= year + 1 : Math.abs(parseInt(m.releaseInfo) - year) <= 1));
  const loose = started.filter(m => m.releaseInfo && (norm(m.name) === base(item.title) || base(m.name) === norm(item.title)));
  return loose.length === 1 ? loose[0] : undefined;
}

// Fallback when Cinemeta has nothing: TMDB search (also matches translated titles: Land of Ambition = Terra Forte), exact name only.
// TMDB_API_KEY: v3 API key or the long Read Access Token.
async function tmdbGet(p) {
  const key = process.env.TMDB_API_KEY;
  const long = key.length > 40;
  return (await fetch(`https://api.themoviedb.org/3${p}${long ? '' : `${p.includes('?') ? '&' : '?'}api_key=${key}`}`, long ? { headers: { Authorization: `Bearer ${key}` } } : {})).json();
}

// Worldwide premieres of the last 14 days, most popular first: movies released digitally, series first aired.
async function tmdbPremieres() {
  const from = isoDay(14), to = isoDay(0);
  const [m, s] = await Promise.all([
    tmdbGet(`/discover/movie?with_release_type=4&release_date.gte=${from}&release_date.lte=${to}&sort_by=popularity.desc`),
    tmdbGet(`/discover/tv?first_air_date.gte=${from}&first_air_date.lte=${to}&sort_by=popularity.desc&with_original_language=en|pt|es|ko|ja|fr|de|it`),
  ]);
  const withImdb = async (results, kind) => (await Promise.all((results || []).slice(0, 20).map(async r => ({ r, ids: await tmdbGet(`/${kind}/${r.id}/external_ids`) }))))
    .filter(x => x.ids.imdb_id)
    .map(({ r, ids }) => ({ slug: `tmdb:${kind}:${r.id}`, title: r.title || r.name, imdbId: ids.imdb_id, kind: kind === 'movie' ? 'MOVIE' : 'SHOW', pop: r.popularity }));
  const movie = await withImdb(m.results, 'movie');
  const series = await withImdb(s.results, 'tv');
  return { movie, series, mix: [...movie, ...series].sort((a, b) => b.pop - a.pop).slice(0, 20) };
}

// Separator posters ("TODAY / 3 / OCT", "FRI / 2 / OCT") for Novidades, rendered by Cloudflare Browser Rendering.
// Missing image → the API serves the logo instead.
const sepLabel = day => {
  const d = new Date(`${day}T12:00:00Z`);
  const f = o => d.toLocaleDateString('en-US', { timeZone: 'UTC', ...o }).toUpperCase();
  return { top: day === isoDay(0) ? 'TODAY' : f({ weekday: 'short' }), big: f({ day: 'numeric' }), bottom: f({ month: 'short' }) };
};
async function separatorImages() {
  const dir = path.join(DOCS, 'sep');
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set(Array.from({ length: NEW_DAYS }, (_, d) => `${isoDay(d)}.png`));
  for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.unlinkSync(path.join(dir, f));
  if (!process.env.CF_API_TOKEN) return;
  for (let d = 0; d < NEW_DAYS; d++) {
    const day = isoDay(d);
    const { top, big, bottom } = sepLabel(day);
    // today's and yesterday's change label (TODAY → weekday); older ones only need drawing once
    if (d > 1 && fs.existsSync(path.join(dir, `${day}.png`))) continue;
    const html = `<html><body style="margin:0"><div style="width:300px;height:450px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px;background:linear-gradient(160deg,#4338CA,#7C3AED);font-family:Poppins,'Segoe UI',Arial,sans-serif;color:#fff">
      <div style="font-size:24px;font-weight:600;opacity:.85;letter-spacing:3px">${top}</div>
      <div style="font-size:110px;font-weight:800;line-height:1">${big}</div>
      <div style="font-size:26px;font-weight:600;letter-spacing:3px">${bottom}</div>
      <div style="margin-top:26px;font-size:18px;opacity:.75">New releases &rarr;</div></div></body></html>`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/browser-rendering/screenshot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, viewport: { width: 300, height: 450 }, screenshotOptions: { type: 'png' } }),
      });
      if ((r.headers.get('content-type') || '').startsWith('image/')) { fs.writeFileSync(path.join(dir, `${day}.png`), Buffer.from(await r.arrayBuffer())); break; }
      const j = await r.json().catch(() => ({}));
      if (j.errors?.[0]?.code !== 2001) { console.error('separator', day, JSON.stringify(j).slice(0, 200)); break; }
      await sleep(15000); // free plan rate limit
    }
  }
}

async function tmdb(type, item) {
  if (!process.env.TMDB_API_KEY) return;
  const get = tmdbGet;
  const kind = type === 'movie' ? 'movie' : 'tv';
  const { results = [] } = await get(`/search/${kind}?query=${encodeURIComponent(item.title)}`);
  const year = yearOf(item);
  const n = norm(item.title);
  const yearOk = r => !year || Math.abs(parseInt(r.release_date || r.first_air_date) - year) <= 1;
  // exact name, or the search's only result (TMDB matched it on a translated title it doesn't return)
  const m = results.find(r => [r.title, r.name, r.original_title, r.original_name].some(t => t && norm(t) === n) && yearOk(r))
    || (results.length === 1 && yearOk(results[0]) ? results[0] : undefined);
  if (!m) return;
  const { imdb_id } = await get(`/${kind}/${m.id}/external_ids`);
  return imdb_id ? { id: imdb_id, name: m.title || m.name } : undefined;
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
    const m = pick(await search(type, item.title), item, type) || await tmdb(type, item).catch(() => undefined);
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

  // Every Portuguese provider; users pick theirs on /configure. providers.json (optional) narrows it for quick local runs.
  const all = await packages();
  const providers = read(path.join(__dirname, 'providers.json'), null) || all.map(p => p.shortName);
  const names = Object.fromEntries(all.map(p => [p.shortName, p.name]));
  const cache = read(CACHE_FILE, {});
  const status = read(path.join(DOCS, 'status.json'), {});
  const fixtureDir = process.argv[2];
  const fpSlugs = providers.map(sn => FLIXPATROL[sn]).filter(Boolean);
  const pages = fixtureDir
    ? Object.fromEntries(fpSlugs.map(s => [s, fs.readFileSync(path.join(fixtureDir, `fp-${s}.html`), 'utf8')]))
    : await scrape(fpSlugs);
  const now = new Date().toISOString();

  // One job per catalog id: { id, name, source, plan() -> [[items, types they may resolve to], …] (+ sets st.date) }
  const jw2plan = lists => [[lists.movie, ['movie']], [lists.series, ['series']]];
  const novidades = await justwatchNew().catch(e => (console.error('novidades', e.message), null));
  const jobs = [];
  // Platforms: only the FlixPatrol daily Top 10 (= the app). Everything JustWatch lives on the JustWatch card,
  // limited to the user's platforms.
  for (const sn of providers.filter(sn => FLIXPATROL[sn])) {
    const fp = FLIXPATROL[sn];
    jobs.push({
      id: `${sn}-top`,
      name: `${names[sn] || sn} · Top 10`,
      source: `https://flixpatrol.com/top10/${fp}/portugal/`,
      plan: async st => {
        const lists = parse(pages[fp] || '');
        st.date = pageDate(pages[fp] || '');
        return lists.Overall && !lists.Movies && !lists['TV Shows'] ? [[lists.Overall, ['movie', 'series']]] : [[lists.Movies || [], ['movie']], [lists['TV Shows'] || [], ['series']]];
      },
    });
  }
  // JustWatch card, all platforms (a user's own selection is built live by the API)
  const genreList = await genres();
  const general = [{ shortName: 'all', name: 'Todas as plataformas' }, ...genreList.map(g => ({ shortName: `g${g.shortName}`, name: g.translation, genre: g.shortName }))];
  const card = [...Object.entries(JW_CARD).map(([id, [label]]) => [id, label]), ...genreList.map(g => [`g${g.shortName}-top`, g.translation])];
  for (const [id, label] of card) {
    jobs.push({
      id,
      name: `JustWatch · ${label}`,
      source: `JustWatch PT, all platforms: ${id}`,
      mixed: true,
      days: id === 'all-new',
      plan: async () => {
        const l = await jwCardGet(id)({}, novidades);
        return [[l.movie, ['movie']], [l.series, ['series']], [l.mix, null, 'mix']];
      },
    });
  }
  if (process.env.TMDB_API_KEY) {
    jobs.push({
      id: 'tmdb-new',
      name: 'Estreias · Mundo',
      source: 'TMDB premieres, last 14 days',
      mixed: true,
      plan: async () => { const l = await tmdbPremieres(); return [...jw2plan(l), [l.mix, null, 'mix']]; },
    });
  }
  await separatorImages().catch(e => console.error('separators', e.message));

  const catalogs = [];
  for (const { id, name, source, mixed, days, plan: getPlan } of jobs) {
    const st = { source, checked: now, missing: [] };
    let plan = [];
    try {
      plan = await getPlan(st);
      st.date ||= now.slice(0, 10);
    } catch (e) {
      st.error = e.message;
    }

    // buckets: movie, series, and mix (movies + series in one catalog, stored in catalog/mix/)
    const out = { movie: [], series: [], mix: [] };
    for (const [items, types, bucket] of plan) {
      for (const item of items) {
        const r = await resolve(item, types || [item.kind === 'MOVIE' ? 'movie' : 'series'], cache);
        const list = out[bucket || r?.type];
        if (r && !list.some(x => x.id === r.id)) list.push(item.day ? { ...r, day: item.day } : r);
        else if (!r) st.missing.push(item.title);
      }
    }
    for (const bucket of ['movie', 'series', 'mix']) {
      if (bucket === 'mix' && !mixed) continue;
      const file = path.join(DOCS, 'catalog', bucket, `${id}.json`);
      if (out[bucket].length >= MIN_ITEMS) {
        write(file, { metas: toMetas(out[bucket], bucket, days) });
        st[bucket] = { updated: st.date, count: out[bucket].length };
      } else {
        st[bucket] = { ...status[id]?.[bucket], error: `only ${out[bucket].length} resolved, kept previous file` };
      }
      if (fs.existsSync(file)) catalogs.push({ type: bucket === 'mix' ? MIX : bucket, id, name });
    }
    status[id] = st;
    console.log(id.padEnd(16), st.date, 'movies', out.movie.length, 'series', out.series.length, st.error || '', st.missing.length ? `missing: ${st.missing.join(', ')}` : '');
  }

  // drop catalogs no job makes any more (lists that were removed)
  const ids = new Set(jobs.map(j => j.id));
  for (const bucket of ['movie', 'series', 'mix']) {
    const dir = path.join(DOCS, 'catalog', bucket);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (!ids.has(f.replace(/\.json$/, ''))) fs.unlinkSync(path.join(dir, f));
  }
  for (const id of Object.keys(status)) if (!ids.has(id)) delete status[id];

  write(path.join(DOCS, 'manifest.json'), {
    id: 'community.chartedx',
    version: '1.0.0',
    name: 'ChartedX',
    description: 'Streaming em Portugal. "Top 10" das plataformas = FlixPatrol diário (igual à app). JustWatch = mais vistos, em alta, populares, novidades e géneros, só das tuas plataformas. Estreias = novos no mundo (TMDB).',
    resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['chartedx:'] }], // meta: separator posters
    types: ['movie', 'series', MIX],
    catalogs,
  });
  write(path.join(DOCS, 'status.json'), status);
  // for the configure page: names, logos, source
  write(path.join(DOCS, 'providers.json'), all.map(({ shortName, name, icon, flixpatrol }) => ({ shortName, name, icon, flixpatrol: !!flixpatrol })));
  write(path.join(DOCS, 'general.json'), general.map(({ shortName, name, genre }) => ({ shortName, name, genre: !!genre })));
  write(CACHE_FILE, cache);
}

module.exports = { parse, resolve, yearOf, scrape, packages, liveCatalog };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
