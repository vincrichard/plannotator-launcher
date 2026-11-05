import crypto from 'node:crypto';

export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function reply(res, code, message) {
  res.writeHead(code, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
  res.end(message);
}

export function reviewCookie(id, token) {
  return `pr_access=${token}; Path=/reviews/${id}/; HttpOnly; SameSite=Lax`;
}
