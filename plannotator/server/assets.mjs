import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {reply} from './access.mjs';
import {acceptsGzip, compress, sendEncoded} from './encoding.mjs';

const known = JSON.parse(fs.readFileSync(new URL('./bundles.json', import.meta.url), 'utf8'));
const assets = new Map();

export function extractBundles(html) {
  // Only byte-identical vendor bundles may become public; session scripts stay inline/private.
  return html.replace(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (original, tag, attributes, body) => {
    const hash = createHash('sha256').update(body).digest('hex');
    if (!known[tag.toLowerCase()].includes(hash)) return original;
    const script = tag.toLowerCase() === 'script';
    const url = `/ui/${hash}.${script ? 'js' : 'css'}`;
    if (!assets.has(url)) assets.set(url, {
      body: Buffer.from(body), hash,
      type: script ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
    });
    return script ? `<script${attributes} src="${url}"></script>` : `<link rel="stylesheet" href="${url}">`;
  });
}

export function handleAsset(req, res, url) {
  const asset = assets.get(url.pathname);
  if (!asset) return reply(res, 404, 'UI asset not found');
  if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed');
  const headers = {
    'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable',
    etag: `W/"${asset.hash}"`, vary: 'Accept-Encoding',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  };
  if ((req.headers['if-none-match'] || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === `"${asset.hash}"`)) {
    res.writeHead(304, headers);
    return res.end();
  }
  // Cache compression once per pinned bundle; the finite allowlist bounds cache memory.
  if (acceptsGzip(req.headers['accept-encoding'])) asset.gzip ||= compress(asset.body);
  sendEncoded(req, res, 200, headers, asset.body, asset.gzip).catch(() => res.destroy());
}
