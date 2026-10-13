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

const toItem = ({ node: { objectType, content: c } }) => ({ slug: `jw:${c.title}:${c.originalReleaseYear}`, title: c.title, year: c.originalReleaseYear, imdbId: c.externalIds?.imdbId, kind: objectType, g: c.genres?.map(g => g.shortName) });
const CONTENT = 'objectType content(country: $country, language: $language) { title originalReleaseYear externalIds { imdbId } genres { shortName } }';
const OFFERS = 'offers(country: $country, platform: WEB) { package { shortName } }';
const pkOf = offers => [...new Set((offers || []).map(o => o.package?.shortName).filter(Boolean))];

// What arrived on the platforms in Portugal over the last NEW_DAYS days (justwatch.com/pt/novo), with the platform it arrived on.
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
          edges { newOffer(platform: WEB) { package { shortName } } node { ${CONTENT} ... on Season { show { ${CONTENT} } } } } } }`,
      { country: 'PT', language: 'en', date: day, after, pk: packages });
      for (const e of newTitles.edges) items.push({ ...toItem({ node: e.node.show || e.node }), pk: pkOf([e.newOffer]), day });
      after = newTitles.pageInfo.hasNextPage ? newTitles.pageInfo.endCursor : null;
    } while (after);
  }
  return items;
}

// A FlixPatrol title looked up on its own platform in JustWatch: tells movie or series and the IMDb id for
// "Overall" lists (Criminal Minds the series, not the 1998 film). Exact name only; no match → the item stays as is.
async function onPlatform(sn, item) {
  const { popularTitles } = await jw(`query F($country: Country!, $language: Language!, $pk: [String!], $q: String!) {
    popularTitles(country: $country, first: 5, filter: {packages: $pk, searchQuery: $q}) { edges { node { ${CONTENT} } } } }`,
  { country: 'PT', language: 'en', pk: [sn], q: item.title });
  const hit = popularTitles.edges.map(toItem).find(i => norm(i.title) === norm(item.title));
  return hit ? { ...item, kind: hit.kind, imdbId: hit.imdbId, year: hit.year } : item;
}

async function genres() {
  return (await jw('query { genres { shortName translation(language: "pt") } }', {})).genres;
}

// ---------- JustWatch card: the justwatch.com lists for Portugal, limited to the user's platforms ----------
// Pools: the long JustWatch lists for all platforms, each title with the platforms it's on (pk). The daily Action fetches
// them once (docs/pools.json); a user's lists are cut from them by keeping their platforms' titles — the same lists
// JustWatch gives when asked with a platform filter (checked 2026-10-11: trending, charts, upcoming).
// Platforms too small to fill a list from the pools get it from JustWatch directly (live = true: one page, filtered).

// streamingCharts, movies and series by rank (each type ranked on its own), with the trend
async function chartPool(period, { packages = [] }) {
  const out = [];
  for (const obj of ['MOVIE', 'SHOW']) {
    out.push(...(await jw(`query C($country: Country!, $language: Language!, $obj: StreamingChartObjectType!, $pk: [String!]) {
      streamingCharts(country: $country, first: 100, filter: {category: ${period}_POPULARITY_SAME_CONTENT_TYPE, objectType: $obj, packages: $pk}) {
        edges { streamingChartInfo { rank trend trendDifference } node { ${CONTENT} ${OFFERS} } } } }`, { country: 'PT', language: 'en', obj, pk: packages }))
      .streamingCharts.edges.map(e => ({ ...toItem(e), pk: pkOf(e.node.offers), rank: e.streamingChartInfo.rank, rise: e.streamingChartInfo.trend === 'UP' ? e.streamingChartInfo.trendDifference : 0 })));
  }
  return out.sort((a, b) => a.rank - b.rank);
}
// popularTitles, movies and series together: TRENDING (= the "Top 10 … esta semana" rows), POPULAR_7_DAYS, POPULAR_180_DAYS
async function popularPool(sort, { packages = [], genres = [] }, size) {
  const out = [];
  let after = null;
  do {
    const { popularTitles: p } = await jw(`query L($country: Country!, $language: Language!, $pk: [String!], $g: [String!], $sort: PopularTitlesSorting!, $after: String) {
      popularTitles(country: $country, first: ${Math.min(100, size - out.length)}, after: $after, sortBy: $sort, filter: {packages: $pk, genres: $g, objectTypes: [MOVIE, SHOW]}) {
        pageInfo { hasNextPage endCursor } edges { node { ${CONTENT} ${OFFERS} } } } }`, { country: 'PT', language: 'en', pk: packages, g: genres, sort, after });
    out.push(...p.edges.map(e => ({ ...toItem(e), pk: pkOf(e.node.offers) })));
    after = p.pageInfo.hasNextPage && out.length < size ? p.pageInfo.endCursor : null;
  } while (after);
  return out;
}
// "Em breve": coming to the platforms (justwatch.com/pt/novo, upcoming)
async function soonPool({ packages = [] }, size) {
  const UP = 'content(country: $country, language: $language) { upcomingReleases(releaseTypes: [DIGITAL]) { package { shortName } } }';
  const out = [];
  let after = null;
  do {
    const { newTitles: p } = await jw(`query U($country: Country!, $language: Language!, $pk: [String!], $after: String) {
      newTitles(country: $country, first: 100, after: $after, pageType: UPCOMING, filter: {packages: $pk}) {
        pageInfo { hasNextPage endCursor } edges { node { ${CONTENT} ... on MovieOrShow { ${UP} } ... on Season { ${UP} show { ${CONTENT} } } } } } }`,
    { country: 'PT', language: 'en', pk: packages, after });
    out.push(...p.edges.map(e => ({ ...toItem({ node: e.node.show || e.node }), pk: pkOf(e.node.content?.upcomingReleases) })));
    after = p.pageInfo.hasNextPage && out.length < size ? p.pageInfo.endCursor : null;
  } while (after);
  return out;
}
// pool name → fetch(filter, live)
const POOLS = {
  DAILY: f => chartPool('DAILY', f),
  WEEKLY: f => chartPool('WEEKLY', f),
  MONTHLY: f => chartPool('MONTHLY', f),
  TRENDING: (f, live) => popularPool('TRENDING', f, live ? 100 : 500),
  POPULAR_7_DAYS: (f, live) => popularPool('POPULAR_7_DAYS', f, live ? 100 : 300),
  POPULAR_180_DAYS: (f, live) => popularPool('POPULAR_180_DAYS', f, live ? 100 : 300),
  NEW: f => justwatchNew(f.packages),
  UPCOMING: (f, live) => soonPool(f, live ? 100 : 200),
};
// a genre's own pool, "G:{code}": its trending titles (rare genres hardly show in the overall TRENDING pool)
const poolGet = (name, f, live) => (name.startsWith('G:') ? popularPool('TRENDING', { ...f, genres: [name.slice(2)] }, 100) : POOLS[name](f, live));

const isMovie = i => i.kind === 'MOVIE';
const top = (l, n = 10) => ({ movie: l.filter(isMovie).slice(0, n), series: l.filter(i => !isMovie(i)).slice(0, n), mix: l.slice(0, n) });
// Novidades: 60–600 titles a day for all platforms, so the first NEW_PER_DAY of each day;
// a title landing on several platforms the same week counts once, on its newest day
const firstPerDay = items => {
  const perDay = {}, seen = new Set();
  return items.filter(it => !seen.has(it.imdbId) && seen.add(it.imdbId) && (perDay[it.day] = (perDay[it.day] || 0) + 1) <= NEW_PER_DAY);
};
// catalog id → [Stremio row name, pools it's cut from, build(...pools) → { movie, series, mix }]
const JW_CARD = {
  'all-daily': ['Mais vistos hoje', ['DAILY'], l => top(l)],
  'all-weekly': ['Mais vistos da semana', ['WEEKLY'], l => top(l)],
  'all-monthly': ['Mais vistos do mês', ['MONTHLY'], l => top(l)],
  'all-top': ['Em alta', ['TRENDING'], l => top(l)],
  // biggest climbers in today's chart (≈ JustWatch "Going viral")
  'all-rising': ['A subir hoje', ['DAILY'], l => top(l.filter(i => i.rise > 0).sort((a, b) => b.rise - a.rise))],
  'all-pop7': ['Populares 7 dias', ['POPULAR_7_DAYS'], l => top(l, 20)],
  'all-pop180': ['Populares 180 dias', ['POPULAR_180_DAYS'], l => top(l, 20)],
  'all-new': ['Novidades', ['NEW'], l => ({ movie: firstPerDay(l.filter(isMovie)), series: firstPerDay(l.filter(i => !isMovie(i))), mix: firstPerDay(l) })],
  'all-soon': ['Em breve', ['UPCOMING'], l => ({ ...top(l, 40), mix: l.slice(0, 30) })],
  // a platform's "Top 10 filmes e séries" as on justwatch.com/pt/provedor/{x}: the weekly chart per type, or the platform's
  // trending when the chart has fewer than 10 (the site's fallback); together = trending of both
  'provider-top': [null, ['WEEKLY', 'TRENDING'], (chart, trending) => {
    const c = top(chart), t = top(trending);
    return { movie: c.movie.length >= 10 ? c.movie : t.movie, series: c.series.length >= 10 ? c.series : t.series, mix: t.mix };
  }],
};
// genres: g{code}-top (Top 10 em alta do género)
const cardList = id => JW_CARD[id] || (/^g[a-z]{3}-top$/.test(id) ? [null, [`G:${id.slice(1, 4)}`], l => top(l)] : null);
// one card list for some platforms ([] = all), from resolved pools (items with an imdbId, each once per pool)
function cardLists(id, pools, packages) {
  const [, need, build] = cardList(id);
  return build(...need.map(p => (pools[p] || []).filter(i => !packages.length || i.pk?.some(sn => packages.includes(sn)))));
}
// pool items JustWatch gave no IMDb id get one from the cache / Cinemeta; unresolved ones and repeats (a show's
// seasons) are dropped. quick: cache only (live requests)
async function resolvePool(items, cache, quick) {
  const out = [], seen = new Set();
  for (const item of items) {
    const types = [isMovie(item) ? 'movie' : 'series'];
    const id = item.imdbId || (quick ? cache[`${types[0]}|${item.slug}`]?.id : (await resolve(item, types, cache).catch(() => null))?.id);
    const key = `${id}|${item.day || ''}`;
    if (id && !seen.has(key) && seen.add(key)) out.push({ ...item, imdbId: id, slug: undefined, year: undefined, g: undefined });
  }
  return out;
}

// ---------- details Stremio shows in rows and previews, like Cinemeta's own catalogs ----------
// cache "meta|{id}": { cm: Cinemeta's meta (IMDb rating, cast, background, logo, runtime, trailer, links) without episodes,
//   d: summary (pt-PT from TMDB, else Cinemeta's), y: year, g: genres (pt), p: fallback poster, rpdb: RPDB has a poster,
//   r: IMDb rating (IMDb's daily file), n, ty, at, v }
const META_RECHECK_DAYS = 7; // entries missing a summary or an RPDB poster are looked up again after this
const rpdbUrl = id => `https://api.ratingposterdb.com/${RPDB_KEY}/imdb/poster-default/${id}.jpg`;
let tmdbGenres;
async function genreNames() {
  if (!tmdbGenres) {
    const [m, t] = await Promise.all(['movie', 'tv'].map(k => tmdbGet(`/genre/${k}/list?language=pt-PT`).catch(() => ({}))));
    tmdbGenres = Object.fromEntries([...(m.genres || []), ...(t.genres || [])].map(g => [g.id, g.name]));
  }
  return tmdbGenres;
}
// TMDB's entry for an IMDb id and its Portuguese summary: pt-PT, else pt-BR (TMDB often only has the Brazilian one)
async function ptSummary(id, type) {
  if (!process.env.TMDB_API_KEY) return {};
  const f = await tmdbGet(`/find/${id}?external_source=imdb_id&language=pt-PT`).catch(() => ({}));
  const kind = (type === 'movie' ? f.movie_results : f.tv_results)?.length ? (type === 'movie' ? 'movie' : 'tv') : f.movie_results?.length ? 'movie' : 'tv';
  const hit = (kind === 'movie' ? f.movie_results : f.tv_results)?.[0];
  if (!hit) return {};
  if (hit.overview) return { hit, d: hit.overview };
  const br = await tmdbGet(`/${kind}/${hit.id}?language=pt-BR`).catch(() => ({}));
  return { hit, d: br.overview || undefined };
}

// Episode names and summaries in Portuguese from TMDB: pt-PT, else pt-BR, else Cinemeta's (TMDB says "Episódio 3" when it has no name)
async function ptEpisodes(id, videos) {
  if (!process.env.TMDB_API_KEY) return videos;
  const tv = (await tmdbGet(`/find/${id}?external_source=imdb_id`)).tv_results?.[0];
  if (!tv) return videos;
  const seasons = [...new Set(videos.map(v => v.season))].filter(n => n >= 0);
  const lang = async l => {
    const eps = {};
    for (let i = 0; i < seasons.length; i += 20) { // TMDB appends at most 20 seasons to one answer
      const j = await tmdbGet(`/tv/${tv.id}?language=${l}&append_to_response=${seasons.slice(i, i + 20).map(n => `season/${n}`).join(',')}`);
      for (const n of seasons.slice(i, i + 20)) for (const ep of j[`season/${n}`]?.episodes || []) eps[`${n}:${ep.episode_number}`] = ep;
    }
    return eps;
  };
  const [pt, br] = await Promise.all([lang('pt-PT'), lang('pt-BR')]);
  const named = ep => (ep?.name && !/^Epis[oó]dio \d+$/i.test(ep.name) ? ep.name : undefined);
  return videos.map(v => {
    const k = `${v.season}:${v.episode}`, d = pt[k]?.overview || br[k]?.overview;
    return { ...v, name: named(pt[k]) || named(br[k]) || v.name, ...(d && { overview: d, description: d }) };
  });
}

// IMDb's own ratings (datasets.imdbws.com, daily, personal non-commercial use): Cinemeta lacks them for new titles
async function imdbRatings() {
  const r = await fetch('https://datasets.imdbws.com/title.ratings.tsv.gz');
  if (!r.ok) throw new Error(`IMDb ratings ${r.status}`);
  const out = new Map();
  for (const line of require('zlib').gunzipSync(Buffer.from(await r.arrayBuffer())).toString().split('\n')) {
    const [id, rating] = line.split('\t', 2);
    if (id.startsWith('tt')) out.set(id, rating);
  }
  return out;
}
let ratings = new Map(); // filled by the daily run

const CINEMETA_DROP = ['videos', 'popularities', 'popularity', 'slug', 'imdb_id', 'moviedb_id', 'tvdb_id', 'poster', 'type'];
async function details(r) {
  const e = { n: r.name, ty: r.type, at: isoDay(0), v: 4 };
  // RPDB poster?, Cinemeta's meta, TMDB's Portuguese summary: asked together
  const [rpdb, cm, { hit, d }] = await Promise.all([
    fetch(rpdbUrl(r.id), { method: 'HEAD' }).then(x => x.ok, () => false),
    fetch(`https://v3-cinemeta.strem.io/meta/${r.type}/${r.id}.json`).then(x => x.json(), () => ({})),
    ptSummary(r.id, r.type).catch(() => ({})),
  ]);
  e.rpdb = rpdb;
  const m = cm.meta;
  if (m) {
    e.cm = Object.fromEntries(Object.entries(m).filter(([k]) => !CINEMETA_DROP.includes(k)));
    for (const [k, n] of [['cast', 8], ['director', 3], ['writer', 3]]) if (Array.isArray(e.cm[k])) e.cm[k] = e.cm[k].slice(0, n);
  }
  // new titles Cinemeta has no cast for yet: TMDB's
  if (hit && !e.cm?.cast?.length) {
    const c = await tmdbGet(`/${hit.media_type === 'movie' ? 'movie' : 'tv'}/${hit.id}/credits`).catch(() => ({}));
    if (c.cast?.length) e.cm = { ...e.cm, cast: c.cast.slice(0, 8).map(x => x.name) };
  }
  if (hit) { // TMDB: Portuguese summary, year, genres, poster
    const names = await genreNames();
    Object.assign(e, { d, y: (hit.release_date || hit.first_air_date || '').slice(0, 4) || undefined, g: (hit.genre_ids || []).map(g => names[g]).filter(Boolean).slice(0, 3) });
    if (hit.poster_path) e.p = `https://image.tmdb.org/t/p/w500${hit.poster_path}`;
  }
  // Cinemeta (English) fills what TMDB didn't
  if (m) Object.assign(e, { d: e.d || m.description, y: e.y || m.releaseInfo, g: e.g?.length ? e.g : (m.genres || []).slice(0, 3) });
  return e;
}
// look up what the cache lacks (older format, or no summary / RPDB poster for a week), 16 at a time
async function enrich(list, cache) {
  // v3: pt-BR fallback — entries still carrying Cinemeta's English summary get one more look; v4: TMDB cast
  const stale = e => !e || e.v < 2 || (e.v < 3 && e.d === e.cm?.description) || (e.v < 4 && !e.cm?.cast?.length) || ((!e.d || !e.rpdb) && (Date.parse(isoDay(0)) - Date.parse(e.at)) / 864e5 >= META_RECHECK_DAYS);
  const todo = [...new Map(list.filter(r => stale(cache[`meta|${r.id}`])).map(r => [r.id, r])).values()];
  for (let i = 0; i < todo.length; i += 16) {
    // a failed lookup keeps what the cache had (nothing for a new title: it's tried again next run)
    await Promise.all(todo.slice(i, i + 16).map(async r => { const e = await details(r).catch(() => null); if (e) cache[`meta|${r.id}`] = e; }));
  }
}

// Stremio metas for one bucket; days → a separator poster before each day (the API makes "/sep/…" absolute)
function toMetas(list, bucket, days, cache = {}) {
  const metas = [];
  let prevDay;
  for (const r of list) {
    if (days && r.day !== prevDay) {
      prevDay = r.day;
      const { top, big, bottom } = sepLabel(r.day);
      metas.push({ id: `chartedx:sep:${r.day}`, type: bucket === 'mix' ? 'movie' : bucket, name: `${top} · ${big} ${bottom}`, poster: `/sep/${r.day}.png`, posterShape: 'poster' });
    }
    const e = cache[`meta|${r.id}`] || {};
    metas.push({
      ...e.cm,
      id: r.id, type: r.type, name: e.cm?.name || r.name, posterShape: 'poster',
      poster: e.rpdb === false ? e.p || `https://images.metahub.space/poster/medium/${r.id}/img` : rpdbUrl(r.id),
      description: e.d, releaseInfo: e.y, genres: e.g?.length ? e.g : undefined, imdbRating: ratings.get(r.id) || e.r || e.cm?.imdbRating,
    });
  }
  return metas;
}

// Upstash Redis (Vercel Storage) over REST: the configs saved behind fixed links ("u:{id}" → config). Off without the env.
const KV = [process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN];
const kv = KV[0] && KV[1] ? (...cmd) => fetch(KV[0], { method: 'POST', headers: { Authorization: `Bearer ${KV[1]}` }, body: JSON.stringify(cmd) })
  .then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); return j.result; }) : null;

// API: one JustWatch-card catalog for the user's platforms, cut from the pools (Vercel's CDN caches the answer).
// A list the pools can't fill (small platforms, rare genres) is asked to JustWatch with the platform filter.
const toR = i => ({ id: i.imdbId, type: isMovie(i) ? 'movie' : 'series', name: i.title, day: i.day });
let pools, metaCache; // read once per server instance
async function userCatalog(id, bucket, packages) {
  const card = cardList(id); // provider-top: one platform's Top 10
  if (!card) return null;
  pools ||= read(path.join(DOCS, 'pools.json'), {});
  metaCache ||= read(CACHE_FILE, {});
  let list = cardLists(id, pools, packages)[bucket] || [];
  if (list.length < 10 && !['all-new', 'all-soon'].includes(id)) {
    pause = 0;
    const live = Object.fromEntries(await Promise.all(card[1].map(async p => [p, await resolvePool(await poolGet(p, { packages }, true), metaCache, true)])));
    list = cardLists(id, live, packages)[bucket] || [];
  }
  const out = list.map(toR);
  await enrich(out, metaCache);
  return toMetas(out, bucket, id === 'all-new', metaCache);
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
  ratings = await imdbRatings().catch(e => (console.error(e.message), new Map()));
  const status = read(path.join(DOCS, 'status.json'), {});
  const fixtureDir = process.argv[2];
  const fpSlugs = providers.map(sn => FLIXPATROL[sn]).filter(Boolean);
  const pages = fixtureDir
    ? Object.fromEntries(fpSlugs.map(s => [s, fs.readFileSync(path.join(fixtureDir, `fp-${s}.html`), 'utf8')]))
    : await scrape(fpSlugs);
  const now = new Date().toISOString();

  // One job per catalog id: { id, name, source, plan() -> [[items, types they may resolve to], …] (+ sets st.date) }
  const jw2plan = lists => [[lists.movie, ['movie']], [lists.series, ['series']]];
  // JustWatch pools, all platforms (a pool that fails keeps the previous run's)
  const genreList = await genres();
  const pools = read(path.join(DOCS, 'pools.json'), {});
  for (const name of [...Object.keys(POOLS), ...genreList.map(g => `G:${g.shortName}`)]) {
    try { pools[name] = await resolvePool(await poolGet(name, {}), cache); console.log('pool', name, pools[name].length); } catch (e) { console.error('pool', name, e.message); }
  }
  write(path.join(DOCS, 'pools.json'), pools);
  const jobs = [];
  // Platforms with FlixPatrol: its daily Top 10 (= the app). Every other platform's Top 10 is JustWatch's, cut from
  // the pools by the API ({sn}-top).
  for (const sn of providers.filter(sn => FLIXPATROL[sn])) {
    const fp = FLIXPATROL[sn];
    jobs.push({
      id: `${sn}-top`,
      name: `${names[sn] || sn} · Top 10`,
      source: `https://flixpatrol.com/top10/${fp}/portugal/`,
      mixed: true,
      plan: async st => {
        const lists = parse(pages[fp] || '');
        st.date = pageDate(pages[fp] || '');
        // FlixPatrol doesn't fill a row (Disney+ PT only has an Overall list, often 1–2 movies): that row uses the
        // platform's JustWatch Top 10 instead (fetched only when needed)
        const fallback = type => [null, [type], type, async () => cardLists('provider-top', pools, [sn])[type]];
        // Overall list (filmes e séries juntos): look each title up on the platform to know its type
        const overall = lists.Overall && await Promise.all(lists.Overall.map(i => onPlatform(sn, i).catch(() => i)));
        if (overall && !lists.Movies && !lists['TV Shows']) return [[overall, null], [overall, null, 'mix'], fallback('movie'), fallback('series')];
        const movies = (lists.Movies || []).map(i => ({ ...i, kind: 'MOVIE', sn }));
        const shows = (lists['TV Shows'] || []).map(i => ({ ...i, kind: 'SHOW', sn }));
        // together: FlixPatrol's Overall list when it has one, else movies and series alternating
        const together = overall ? [overall, null, 'mix'] : [movies.flatMap((m, i) => [m, shows[i]].filter(Boolean)).concat(shows.slice(movies.length)), null, 'mix'];
        return [[movies, ['movie']], [shows, ['series']], together, fallback('movie'), fallback('series')];
      },
    });
  }
  // JustWatch card, all platforms (a user's own selection is cut from the pools by the API)
  const general = [{ shortName: 'all', name: 'Todas as plataformas' }, ...genreList.map(g => ({ shortName: `g${g.shortName}`, name: g.translation, genre: g.shortName }))];
  const card = [...Object.entries(JW_CARD).filter(([, [label]]) => label).map(([id, [label]]) => [id, label]), ...genreList.map(g => [`g${g.shortName}-top`, g.translation])];
  for (const [id, label] of card) {
    jobs.push({
      id,
      name: `JustWatch · ${label}`,
      source: `JustWatch PT, all platforms: ${id}`,
      mixed: true,
      days: id === 'all-new',
      plan: async () => {
        const l = cardLists(id, pools, []);
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
  // every platform's Top 10 is cut from the pools when asked; their details are looked up now
  await enrich(providers.flatMap(sn => Object.values(cardLists('provider-top', pools, [sn])).flat()).map(toR), cache);
  // and the JustWatch-card lists of the configs saved behind fixed links
  for (const config of kv ? await kv('KEYS', 'u:*').then(keys => keys.length ? kv('MGET', ...keys) : []).catch(() => []) : []) {
    const entries = (config || '').split(',');
    const mine = entries.find(e => e.startsWith('my.'))?.split('.').slice(1) || [];
    if (mine.length) await enrich(entries.map(e => e.split('.')[0]).filter(cardList).flatMap(id => Object.values(cardLists(id, pools, mine)).flat()).map(toR), cache);
  }

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
    for (let [items, types, bucket, fallback] of plan) {
      // a fallback entry replaces its bucket only when the main source left it short
      if (fallback) {
        if (out[bucket].length >= MIN_ITEMS) continue;
        items = await fallback().catch(() => []);
        if (!items.length) continue;
        out[bucket] = [];
        (st.fallback ||= []).push(bucket);
      }
      for (const item of items) {
        // no types: each item's own kind, or either when unknown (FlixPatrol Overall title not found on the platform)
        let r = await resolve(item, types || (item.kind ? [item.kind === 'MOVIE' ? 'movie' : 'series'] : ['movie', 'series']), cache);
        if (!r && item.sn) { // FlixPatrol title not found elsewhere: look for it on its platform
          const f = await onPlatform(item.sn, item).catch(() => item);
          if (f.imdbId) r = { type: f.kind === 'MOVIE' ? 'movie' : 'series', id: f.imdbId, name: f.title };
        }
        const list = out[bucket || r?.type];
        if (r && !list.some(x => x.id === r.id)) list.push(item.day ? { ...r, day: item.day } : r);
        else if (!r) st.missing.push(item.title);
      }
    }
    await enrich([...out.movie, ...out.series, ...out.mix], cache);
    for (const bucket of ['movie', 'series', 'mix']) {
      if (bucket === 'mix' && !mixed) continue;
      const file = path.join(DOCS, 'catalog', bucket, `${id}.json`);
      if (out[bucket].length >= MIN_ITEMS) {
        write(file, { metas: toMetas(out[bucket], bucket, days, cache) });
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
    // meta: separator posters, and titles Cinemeta doesn't know (from the cache's details)
    resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['chartedx:', 'tt'] }],
    types: ['movie', 'series', MIX],
    catalogs,
  });
  write(path.join(DOCS, 'status.json'), status);
  // for the configure page: names, logos, source
  write(path.join(DOCS, 'providers.json'), all.map(({ shortName, name, icon, flixpatrol }) => ({ shortName, name, icon, flixpatrol: !!flixpatrol })));
  write(path.join(DOCS, 'general.json'), general.map(({ shortName, name, genre }) => ({ shortName, name, genre: !!genre })));
  for (const [k, e] of Object.entries(cache)) if (k.startsWith('meta|') && ratings.has(k.slice(5))) e.r = ratings.get(k.slice(5));
  write(CACHE_FILE, cache);
}

module.exports = { parse, resolve, yearOf, scrape, packages, userCatalog, ptSummary, ptEpisodes, kv };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
