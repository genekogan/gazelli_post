import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './types';

// This gate runs before CORS, routing and static assets. Only GET /api is open.
export const boardAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.BOARD_PASSWORD || (c.req.method === 'GET' && c.req.path === '/api')) return next();
  const header = c.req.header('Authorization') ?? '';
  let password = '';
  let valid = false;
  try {
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    if (match && header.length <= 8192) {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(match[1]), x => x.charCodeAt(0)));
      const colon = decoded.indexOf(':');
      if (colon >= 0) { password = decoded.slice(colon + 1); valid = true; }
    }
  } catch { /* Malformed credentials receive the same challenge. */ }
  // Hash both inputs to fixed-length buffers, then use Workers' constant-time primitive.
  const [actual, expected] = await Promise.all([password, c.env.BOARD_PASSWORD].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
  const equal = crypto.subtle.timingSafeEqual(actual, expected);
  if (!valid || !equal) return new Response('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="gazelli_board", charset="UTF-8"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
  await next();
  // Authenticated assets/docs must not enter a shared cache either.
  if (!c.req.path.startsWith('/media/')) c.header('Cache-Control', 'private, no-store');
};
