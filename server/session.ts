import type { MiddlewareHandler } from 'hono';
import { ApiError } from './protocol';
import { getCookie, setCookie } from 'hono/cookie';
import { digest, secret, type Devices } from './devices';

export type SessionEnv = {
  Variables: { principal: string; device: string; validateSession: () => void };
};

/** Random browser identities make the first board usable without a registration flow. */
export const session =
  (devices: Devices): MiddlewareHandler<SessionEnv> =>
  async (c, next) => {
    const url = new URL(c.req.url);
    const origin = c.req.header('Origin');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      ((origin && origin !== (process.env.PUBLIC_ORIGIN || url.origin)) ||
        c.req.header('Sec-Fetch-Site') === 'cross-site')
    ) {
      return c.json({ error: 'cross_origin_write' }, 403);
    }
    let key = getCookie(c, 'folio_session');
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
      key = secret();
      setCookie(c, 'folio_session', key, {
        httpOnly: true,
        secure: (process.env.PUBLIC_ORIGIN || url.origin).startsWith('https:'),
        sameSite: 'Lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    const device = digest(key);
    devices.observe(device, c.req.header('User-Agent') || '');
    c.set('device', device);
    const principal = devices.principal(device);
    c.set('principal', principal);
    c.set('validateSession', () => {
      if (devices.principal(device) !== principal) throw new ApiError(403, 'inactive_workspace');
    });
    c.header('Cache-Control', 'private, no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
    const cacheScope = digest('offline:' + device + ':' + devices.principal(device));
    if (getCookie(c, 'folio_cache') !== cacheScope) {
      setCookie(c, 'folio_cache', cacheScope, {
        httpOnly: false,
        secure: (process.env.PUBLIC_ORIGIN || url.origin).startsWith('https:'),
        sameSite: 'Lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      });
    }
  };
