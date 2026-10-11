// Single Vercel function (also a plain Node http handler, for local runs):
//   /configure, /{config}/configure   pick catalogs
//   /manifest.json                    every catalog, asks Stremio to configure first
//   /{config}/manifest.json           only the picked catalogs; config = comma list of catalog ids, optionally
//                                     limited to some types: nfx-top (movies + series), sic-popular.m (movies), all-top.x (mixed),
//                                     gcmy-top.msx (all three)
//   /{config}/catalog/{type}/{id}.json   from docs/, written daily by the GitHub Action; JustWatch-card lists are cut
//                                     from the daily pools for the user's platforms: my.nfx.mxx.sic
//   /{config}/meta/{type}/chartedx:sep:{day}.json   the day separators in Novidades
//   /{config}/meta/{type}/tt….json   titles Cinemeta lacks, from the cached details (Stremio asks Cinemeta first)
//   /sep/{day}.png                    separator poster (logo if missing)
//   {sn}-top                          a platform's Top 10: FlixPatrol from docs/, else JustWatch's, from the pools
//   /dados                            page showing what was extracted (FlixPatrol, JustWatch, TMDB, status)
//   /u-{id}/…                         fixed link: the config saved in Upstash Redis (POST /save {id?, config} → {id}),
//                                     so changing it needs no reinstall; /u-{id}/config.json gives it back to /configure
//   /providers.json, /general.json, /status.json, /logo.png, /logo.svg   for the pages and Stremio
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIX = 'Filmes e Séries'; // catalogs mixing movies and series, files in docs/catalog/mix/
const TYPE = { m: 'movie', s: 'series', x: MIX };
const origin = req => `${/^(localhost|127\.)/.test(req.headers.host) ? 'http' : 'https'}://${req.headers.host}`;
const send = (res, code, type, body, cache = 'public, max-age=3600') => {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache });
  res.end(body);
};
const CONFIG = /^[a-z0-9,.-]+$/;
const users = new Map(); // saved config id → [config, read at]: kept a minute per server instance
async function savedConfig(id) {
  const hit = users.get(id);
  if (hit && Date.now() - hit[1] < 60e3) return hit[0];
  const config = (await require('../update.js').kv?.('GET', `u:${id}`).catch(() => null)) || '';
  users.set(id, [config, Date.now()]);
  return config;
}
const body = async req => {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; // Vercel parses it
  let s = '';
  for await (const c of req) s += c;
  return JSON.parse(s);
};

module.exports = async (req, res) => {
  const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let config = parts.length > 1 && !['catalog', 'meta', 'sep'].includes(parts[0]) && CONFIG.test(parts[0]) ? parts.shift() : '';
  const user = config.match(/^u-([a-z0-9]{12})$/)?.[1];
  if (user) config = await savedConfig(user);

  if (parts[0] === 'save' && req.method === 'POST') {
    const { kv } = require('../update.js');
    const { id, config: c } = await body(req).catch(() => ({}));
    if (!kv) return send(res, 503, 'application/json', '{"error":"no storage"}', 'no-store');
    if (typeof c !== 'string' || !CONFIG.test(c) || c.length > 3000) return send(res, 400, 'application/json', '{"error":"bad config"}', 'no-store');
    const key = /^[a-z0-9]{12}$/.test(id || '') ? id : require('crypto').randomBytes(16).toString('hex').slice(0, 12);
    await kv('SET', `u:${key}`, c);
    users.set(key, [c, Date.now()]);
    return send(res, 200, 'application/json', JSON.stringify({ id: key }), 'no-store');
  }
  if (user && parts[0] === 'config.json') return send(res, 200, 'application/json', JSON.stringify({ config }), 'no-store');

  if (!parts.length || parts[0] === 'configure') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'configure.html')), 'no-cache');
  }

  if (parts.length === 1 && ['logo.png', 'logo.svg'].includes(parts[0])) {
    return send(res, 200, parts[0].endsWith('png') ? 'image/png' : 'image/svg+xml', fs.readFileSync(path.join(ROOT, parts[0])), 'public, max-age=86400');
  }

  if (parts[0] === 'sep' && /^\d{4}-\d\d-\d\d\.png$/.test(parts[1] || '')) {
    const file = path.join(ROOT, 'docs', 'sep', parts[1]);
    return send(res, 200, 'image/png', fs.readFileSync(fs.existsSync(file) ? file : path.join(ROOT, 'logo.png')), 'public, max-age=86400');
  }

  // a title's page: Cinemeta's full meta (episodes included) with the Portuguese summary and the RPDB poster;
  // titles Cinemeta doesn't know (very new / upcoming) get what the daily run cached
  const tt = parts[0] === 'meta' && (parts[2] || '').match(/^(tt\d+)\.json$/);
  if (tt) {
    const e = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache.json'), 'utf8'))[`meta|${tt[1]}`] || {};
    const poster = e.rpdb === false ? e.p : `https://api.ratingposterdb.com/${process.env.RPDB_KEY || 't0-free-rpdb'}/imdb/poster-default/${tt[1]}.jpg`;
    const m = (await fetch(`https://v3-cinemeta.strem.io/meta/${parts[1]}/${tt[1]}.json`).then(r => r.json(), () => ({}))).meta;
    // Portuguese summary: cached, else asked to TMDB now (titles outside the lists, e.g. in Continuar a ver)
    const d = e.d || (await require('../update.js').ptSummary(tt[1], parts[1]).catch(() => ({}))).d;
    if (m) return send(res, 200, 'application/json', JSON.stringify({ meta: { ...m, description: d || m.description, poster: poster || m.poster } }), 'public, max-age=3600, s-maxage=21600');
    if (!e.n) return send(res, 404, 'application/json', '{"meta":null}', 'public, max-age=3600');
    return send(res, 200, 'application/json', JSON.stringify({ meta: {
      ...e.cm, id: tt[1], type: parts[1], name: e.n, description: e.d, releaseInfo: e.y, genres: e.g, poster,
    } }), 'public, max-age=3600, s-maxage=21600');
  }

  // opening a separator shows a small page instead of an error
  const sep = parts[0] === 'meta' && (parts[2] || '').match(/^chartedx:sep:(\d{4}-\d\d-\d\d)\.json$/);
  if (sep) {
    const date = new Date(`${sep[1]}T12:00:00Z`).toLocaleDateString('pt-PT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
    return send(res, 200, 'application/json', JSON.stringify({ meta: {
      id: parts[2].slice(0, -5), type: parts[1], name: `Novidades de ${date}`, poster: `${origin(req)}/sep/${sep[1]}.png`,
      description: "Os títulos a seguir chegaram a esta plataforma em Portugal nesse dia. Fonte: JustWatch.",
    } }));
  }

  if (parts[0] === 'dados') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'dados.html')), 'no-cache');
  }

  if (['providers.json', 'general.json', 'status.json'].includes(parts[0])) {
    return send(res, 200, 'application/json', fs.readFileSync(path.join(ROOT, 'docs', parts[0])), 'no-cache');
  }

  if (parts[0] === 'manifest.json') {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'manifest.json'), 'utf8'));
    manifest.logo = `${origin(req)}/logo.png`;
    if (config) {
      const names = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'providers.json'), 'utf8')).map(p => [p.shortName, p.name]));
      manifest.catalogs = config.split(',').flatMap(entry => { // user's order
        const [id, t = 'ms'] = entry.split('.');
        const types = [...t].map(c => TYPE[c]);
        const fixed = manifest.catalogs.filter(c => c.id === id && types.includes(c.type));
        // a platform without FlixPatrol: its Top 10 is JustWatch's, built live
        const top = id.match(/^([a-z0-9]+)-top$/);
        if (!fixed.length && top && names[top[1]]) return types.map(type => ({ type, id, name: `${names[top[1]]} · Top 10` }));
        return fixed;
      });
    }
    manifest.behaviorHints = { configurable: true, configurationRequired: !config };
    return send(res, 200, 'application/json', JSON.stringify(manifest), user ? 'no-cache' : undefined); // a saved config changes
  }

  // /catalog/{type}/{id}.json, or /catalog/{type}/{id}/skip=30.json (Stremio paging): lists end before that
  if (parts[0] === 'catalog' && ['movie', 'series', MIX].includes(parts[1])) {
    if (parts.length > 3) return send(res, 200, 'application/json', '{"metas":[]}');
    const bucket = parts[1] === MIX ? 'mix' : parts[1];
    // JustWatch card lists for the user's platforms ("my.nfx.mxx" in the config): cut from the pools, cached 6 h by Vercel's CDN
    const id = (parts[2] || '').replace(/\.json$/, '');
    const file = path.join(ROOT, 'docs', 'catalog', bucket, parts[2] || '');
    const top = !fs.existsSync(file) && id.match(/^([a-z0-9]+)-top$/); // Top 10 of a platform without FlixPatrol
    const mine = top ? [top[1]] : config.split(',').find(e => e.startsWith('my.'))?.split('.').slice(1) || [];
    if (mine.length) {
      const metas = await require('../update.js').userCatalog(top ? 'provider-top' : id, bucket, mine).catch(() => null);
      if (metas) return send(res, 200, 'application/json', JSON.stringify({ metas }).replaceAll('"poster":"/sep/', `"poster":"${origin(req)}/sep/`), `public, max-age=${user ? 600 : 3600}, s-maxage=${user ? 600 : 21600}`); // a saved config changes
    }
    // separator posters are stored relative ("/sep/…"): make them absolute for this host
    if (/^[a-z0-9-]+\.json$/.test(parts[2] || '') && fs.existsSync(file)) {
      return send(res, 200, 'application/json', fs.readFileSync(file, 'utf8').replaceAll('"poster": "/sep/', `"poster": "${origin(req)}/sep/`), 'public, max-age=3600, s-maxage=21600');
    }
  }

  send(res, 404, 'application/json', '{"error":"not found"}');
};
