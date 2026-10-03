// Single Vercel function (also a plain Node http handler, for local runs):
//   /configure, /{config}/configure   pick catalogs
//   /manifest.json                    every catalog, asks Stremio to configure first
//   /{config}/manifest.json           only the picked catalogs; config = comma list of catalog ids, optionally
//                                     limited to some types: nfx-top (movies + series), sic-popular.m (movies), all-top.x (mixed),
//                                     gcmy-top.msx (all three)
//   /{config}/catalog/{type}/{id}.json   from docs/, written daily by the GitHub Action; JustWatch-card lists are built
//                                     live when the config has the user's platforms: my.nfx.mxx.sic
//   /{config}/meta/{type}/chartedx:sep:{day}.json   the day separators in Novidades
//   /sep/{day}.png                    separator poster (logo if missing)
//   /providers.json, /general.json, /logo.png, /logo.svg   for the configure page and Stremio
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

module.exports = async (req, res) => {
  const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const config = parts.length > 1 && !['catalog', 'meta', 'sep'].includes(parts[0]) && /^[a-z0-9,.-]+$/.test(parts[0]) ? parts.shift() : '';

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

  // opening a separator shows a small page instead of an error
  const sep = parts[0] === 'meta' && (parts[2] || '').match(/^chartedx:sep:(\d{4}-\d\d-\d\d)\.json$/);
  if (sep) {
    const date = new Date(`${sep[1]}T12:00:00Z`).toLocaleDateString('pt-PT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
    return send(res, 200, 'application/json', JSON.stringify({ meta: {
      id: parts[2].slice(0, -5), type: parts[1], name: `Novidades de ${date}`, poster: `${origin(req)}/sep/${sep[1]}.png`,
      description: "Os títulos a seguir chegaram a esta plataforma em Portugal nesse dia. Fonte: JustWatch.",
    } }));
  }

  if (['providers.json', 'general.json'].includes(parts[0])) {
    return send(res, 200, 'application/json', fs.readFileSync(path.join(ROOT, 'docs', parts[0])), 'no-cache');
  }

  if (parts[0] === 'manifest.json') {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'manifest.json'), 'utf8'));
    manifest.logo = `${origin(req)}/logo.png`;
    if (config) {
      manifest.catalogs = config.split(',').flatMap(entry => { // user's order
        const [id, t = 'ms'] = entry.split('.');
        const types = [...t].map(c => TYPE[c]);
        return manifest.catalogs.filter(c => c.id === id && types.includes(c.type));
      });
    }
    manifest.behaviorHints = { configurable: true, configurationRequired: !config };
    return send(res, 200, 'application/json', JSON.stringify(manifest));
  }

  // /catalog/{type}/{id}.json, or /catalog/{type}/{id}/skip=30.json (Stremio paging): lists end before that
  if (parts[0] === 'catalog' && ['movie', 'series', MIX].includes(parts[1])) {
    if (parts.length > 3) return send(res, 200, 'application/json', '{"metas":[]}');
    const bucket = parts[1] === MIX ? 'mix' : parts[1];
    // JustWatch card lists for the user's platforms ("my.nfx.mxx" in the config): built live, cached 6 h by Vercel's CDN
    const mine = config.split(',').find(e => e.startsWith('my.'))?.split('.').slice(1) || [];
    if (mine.length) {
      const metas = await require('../update.js').liveCatalog((parts[2] || '').replace(/\.json$/, ''), bucket, mine).catch(() => null);
      if (metas) return send(res, 200, 'application/json', JSON.stringify({ metas }).replaceAll('"poster":"/sep/', `"poster":"${origin(req)}/sep/`), 'public, max-age=3600, s-maxage=21600');
    }
    const file = path.join(ROOT, 'docs', 'catalog', bucket, parts[2] || '');
    // separator posters are stored relative ("/sep/…"): make them absolute for this host
    if (/^[a-z0-9-]+\.json$/.test(parts[2] || '') && fs.existsSync(file)) {
      return send(res, 200, 'application/json', fs.readFileSync(file, 'utf8').replaceAll('"poster": "/sep/', `"poster": "${origin(req)}/sep/`));
    }
  }

  send(res, 404, 'application/json', '{"error":"not found"}');
};
