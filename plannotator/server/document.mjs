import fs from 'node:fs';
import {extractBundles} from './assets.mjs';

const adapter = fs.readFileSync(new URL('../route-adapter.js', import.meta.url), 'utf8');

export function rewriteReviewDocument(html, prefix) {
  html = extractBundles(html);
  html = html.replace(/((?:src|href)=["'])\/(?!\/|ui\/)/g, `$1${prefix}`);
  html = html.replace(/<link\b(?=[^>]*\brel=["']manifest["'])[^>]*>/gi, '');
  const script = adapter.replace('__REVIEW_PREFIX__', JSON.stringify(prefix));
  html = html.replace(/<head>/i, () => `<head><base href="${prefix}"><link rel="manifest" href="/manifest.webmanifest"><script>${script}</script>`);
  return html;
}
