// Single Vercel function (also a plain Node http handler, for local runs):
//   /configure, /{config}/configure   pick catalogs
//   /manifest.json                    every catalog, asks Stremio to configure first
//   /{config}/manifest.json           only the picked catalogs; config = comma list of catalog ids, optionally
//                                     limited to some types: nfx-top (movies + series), sic-popular.m (movies), all-top.x (mixed),
//                                     gcmy-top.msx (all three)
//   /{config}/catalog/{type}/{id}.json   from docs/, written daily by the GitHub Action
//   /providers.json, /general.json, /logo.png, /logo.svg   for the configure page and Stremio
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIX = 'Filmes e Séries'; // catalogs mixing movies and series, files in docs/catalog/mix/
const TYPE = { m: 'movie', s: 'series', x: MIX };
const send = (res, code, type, body, cache = 'public, max-age=3600') => {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache });
  res.end(body);
};

module.exports = (req, res) => {
  const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const config = parts.length > 1 && parts[0] !== 'catalog' && /^[a-z0-9,.-]+$/.test(parts[0]) ? parts.shift() : '';

  if (!parts.length || parts[0] === 'configure') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'configure.html')), 'no-cache');
  }

  if (parts.length === 1 && ['logo.png', 'logo.svg'].includes(parts[0])) {
    return send(res, 200, parts[0].endsWith('png') ? 'image/png' : 'image/svg+xml', fs.readFileSync(path.join(ROOT, parts[0])), 'public, max-age=86400');
  }

  if (['providers.json', 'general.json'].includes(parts[0])) {
    return send(res, 200, 'application/json', fs.readFileSync(path.join(ROOT, 'docs', parts[0])), 'no-cache');
  }

  if (parts[0] === 'manifest.json') {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'manifest.json'), 'utf8'));
    const host = req.headers.host;
    manifest.logo = `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}/logo.png`;
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
    const file = path.join(ROOT, 'docs', 'catalog', parts[1] === MIX ? 'mix' : parts[1], parts[2] || '');
    if (/^[a-z0-9-]+\.json$/.test(parts[2] || '') && fs.existsSync(file)) return send(res, 200, 'application/json', fs.readFileSync(file));
  }

  send(res, 404, 'application/json', '{"error":"not found"}');
};
