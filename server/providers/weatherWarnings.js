import { normalizeWeatherWarningSnapshot } from '../../src/layers/weatherWarnings/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// MET Norway MetAlerts 2.0: warnings in effect now, land and sea (public,
// keyless, CC BY 4.0). MET's terms require an identifying User-Agent and ask
// clients not to poll faster than the data changes.
const API_URL =
  'https://api.met.no/weatherapi/metalerts/2.0/current.json?lang=en';
const USER_AGENT =
  'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)';
const TTL_MS = 300_000;
const MIB = 1024 * 1024;

/** Fixed-origin, bounded MetAlerts route for dev and preview. */
export function weatherWarningsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchWarnings() {
    const signal = AbortSignal.timeout(20_000);
    const response = await fetchImpl(API_URL, {
      signal,
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(response, 16 * MIB, signal);
    const rows = normalizeWeatherWarningSnapshot(payload);
    if (rows === null) throw new Error('invalid_snapshot');
    return { fetchedAt: now(), rows };
  }

  async function acquire() {
    if (cached && now() - cached.savedAt < TTL_MS)
      return { value: cached.value, stale: false };
    try {
      const { promise } = coalesceProxyRequest(
        inFlight,
        'warnings',
        async () => {
          const value = await fetchWarnings();
          cached = { value, savedAt: now() };
          return value;
        },
      );
      return { value: await promise, stale: false };
    } catch (error) {
      if (cached) return { value: cached.value, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'weather_warnings_unavailable' });
    }
  }

  return {
    name: 'weather-warnings',
    configureServer({ middlewares }) {
      middlewares.use('/api/weather-warnings', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/weather-warnings', handler);
    },
  };
}
