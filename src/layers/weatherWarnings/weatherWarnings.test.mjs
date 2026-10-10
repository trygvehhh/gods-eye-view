import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWeatherWarningSnapshot, warningLevel } from './records.js';
import { buildWarningCard, warningAnchorDegrees } from './cards.js';
import { createMetAlertsWarningSource } from './source.js';
import { createWeatherWarningsLayer } from './index.js';
import { weatherWarningsProxy } from '../../../server/providers/weatherWarnings.js';

const ring = [
  [5.0, 60.0],
  [5.4, 60.0],
  [5.4, 60.4],
  [5.0, 60.0],
];

function feature(overrides = {}, properties = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    when: {
      interval: ['2026-10-09T20:00:00+00:00', '2026-10-11T12:00:00+00:00'],
    },
    properties: {
      id: '2.49.0.1.578.0.20261010070257.045',
      type: 'Update',
      awareness_level: '2; yellow; Moderate',
      riskMatrixColor: 'Yellow',
      event: 'gale',
      eventAwarenessName: 'Gale',
      area: 'Frøya - Rørvik',
      geographicDomain: 'marine',
      severity: 'Moderate',
      certainty: 'Likely',
      description: 'South-easterly strong gale 20 m/s.',
      instruction: 'Do not go out in small boats.',
      web: 'https://www.met.no/en/weather-and-climate/warnings',
      ...properties,
    },
    ...overrides,
  };
}

test('MetAlerts features normalize to warning rows', () => {
  const rows = normalizeWeatherWarningSnapshot({ features: [feature()] });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.stableId, '2.49.0.1.578.0.20261010070257.045');
  assert.equal(row.level, 'yellow');
  assert.equal(row.eventName, 'Gale');
  assert.equal(row.domain, 'marine');
  assert.equal(row.onset, Date.parse('2026-10-09T20:00:00Z'));
  assert.equal(row.expires, Date.parse('2026-10-11T12:00:00Z'));
  assert.deepEqual(row.polygons, [[ring]]);
});

test('awareness level falls back to the risk-matrix colour', () => {
  assert.equal(
    warningLevel({ awareness_level: '3; orange; Severe' }),
    'orange',
  );
  assert.equal(warningLevel({ riskMatrixColor: 'Red' }), 'red');
  assert.equal(warningLevel({ awareness_level: '1; green; Minor' }), null);
});

test('invalid, cancelled and duplicate warnings are skipped, not fatal', () => {
  const rows = normalizeWeatherWarningSnapshot({
    features: [
      feature(),
      feature({}, { id: 'cancelled', type: 'Cancel' }),
      feature({ geometry: null }, { id: 'no-geometry' }),
      feature({}, { id: 'no-level', awareness_level: '', riskMatrixColor: '' }),
      feature({}, { id: 'bad-link', web: 'javascript:alert(1)' }),
      feature(),
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.stableId),
    ['2.49.0.1.578.0.20261010070257.045', 'bad-link'],
  );
  assert.equal(rows[1].web, null);
  assert.equal(normalizeWeatherWarningSnapshot({}), null);
});

test('the warning card summarizes level, area, validity and advice', () => {
  const [row] = normalizeWeatherWarningSnapshot({ features: [feature()] });
  const card = buildWarningCard(row, Date.parse('2026-10-10T12:00:00Z'));
  assert.equal(card.title, 'WARNING · Gale');
  assert.equal(card.accent, '#ffd60a');
  assert.equal(card.interactive, true);
  assert.deepEqual(card.details, [
    'yellow level · Frøya - Rørvik · sea',
    'in effect until Oct 11 12:00Z',
    'South-easterly strong gale 20 m/s.',
    'Do not go out in small boats.',
    'MET Norway ↗ · click card to open',
  ]);
  const upcoming = buildWarningCard(row, Date.parse('2026-10-09T12:00:00Z'));
  assert.equal(upcoming.details[1], 'from Oct 9 20:00Z to Oct 11 12:00Z');
});

test('the card anchor sits on the largest polygon', () => {
  const small = [
    [10, 60],
    [10.1, 60],
    [10.1, 60.1],
    [10, 60],
  ];
  const anchor = warningAnchorDegrees([[small], [ring]]);
  assert.ok(Math.abs(anchor.lon - 5.2667) < 1e-3);
  assert.ok(Math.abs(anchor.lat - 60.1333) < 1e-3);
});

function proxyHandler(options) {
  let handler;
  weatherWarningsProxy(options).configureServer({
    middlewares: {
      use: (path, callback) => {
        assert.equal(path, '/api/weather-warnings');
        handler = callback;
      },
    },
  });
  return async (req) => {
    const result = { status: null, headers: null, body: null };
    await handler(req, {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
      },
      end(body) {
        result.body = JSON.parse(body);
      },
    });
    return result;
  };
}

test('the proxy identifies itself, normalizes and caches MetAlerts', async () => {
  const requests = [];
  let clock = 0;
  const handle = proxyHandler({
    now: () => clock,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        userAgent: init.headers['User-Agent'],
      });
      return Response.json({
        type: 'FeatureCollection',
        features: [feature()],
      });
    },
  });
  const first = await handle({ url: '/', method: 'GET' });
  assert.equal(first.status, 200);
  assert.equal(first.body.rows.length, 1);
  assert.match(
    requests[0].url,
    /^https:\/\/api\.met\.no\/weatherapi\/metalerts\/2\.0\/current\.json/,
  );
  assert.match(requests[0].userAgent, /gods-eye-view/);
  clock = 60_000;
  await handle({ url: '/', method: 'GET' });
  assert.equal(requests.length, 1, 'served from the 5-minute cache');
});

test('the proxy serves the last good snapshot as stale when MET fails', async () => {
  let clock = 0;
  let fail = false;
  const handle = proxyHandler({
    now: () => clock,
    fetchImpl: async () =>
      fail
        ? new Response('down', { status: 503 })
        : Response.json({ features: [feature()] }),
  });
  await handle({ url: '/', method: 'GET' });
  fail = true;
  clock = 600_000;
  const stale = await handle({ url: '/', method: 'GET' });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
});

test('the proxy rejects other methods, paths and upstream garbage', async () => {
  const handle = proxyHandler({
    fetchImpl: async () => Response.json({ nope: true }),
  });
  assert.equal((await handle({ url: '/', method: 'POST' })).status, 405);
  assert.equal((await handle({ url: '/other', method: 'GET' })).status, 404);
  const garbage = await handle({ url: '/', method: 'GET' });
  assert.equal(garbage.status, 502);
  assert.equal(garbage.body.error, 'weather_warnings_unavailable');
});

test('the browser source reads rows from the same-origin route', async () => {
  let requested;
  const source = createMetAlertsWarningSource({
    fetchImpl: async (url) => {
      requested = String(url);
      return Response.json({ rows: [{ stableId: 'a' }] });
    },
  });
  assert.deepEqual(await source.getSnapshot(), [{ stableId: 'a' }]);
  assert.equal(requested, '/api/weather-warnings');
  const broken = createMetAlertsWarningSource({
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(broken.getSnapshot(), /Malformed/);
});

function harness(rows, { pick = () => null, cardHit = () => null } = {}) {
  const sources = [];
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null };
  const opened = [];
  const viewer = {
    scene: { pick },
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
  };
  const layer = createWeatherWarningsLayer({
    source: { getSnapshot: async () => rows },
    overlayHost: {
      setEntries: (id, entries) => overlay.entries.set(id, entries),
      setVisible: (id, visible) => {
        overlay.visible = visible;
      },
      clearSource: (id) => overlay.entries.delete(id),
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => {
        clicks.handler = callback;
      },
      destroy: () => {
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, id) => String(id).startsWith('other:'),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  layer.enable();
  return { layer, sources, overlay, clicks, opened };
}

test('the layer draws warnings, selects one on click and opens MET', async () => {
  const rows = normalizeWeatherWarningSnapshot({
    features: [
      feature(),
      feature({}, { id: 'red-one', awareness_level: '4; red; Extreme' }),
    ],
  });
  const id = '2.49.0.1.578.0.20261010070257.045';
  let picked = { id: `weather-warning:${id}:0` };
  let hit = null;
  const h = harness(rows, { pick: () => picked, cardHit: () => hit });
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.sources[0].entities.values.length, 2);
  const legend = h.layer.getRowControls().legend;
  assert.deepEqual(
    legend.map((band) => band.count),
    [1, 0, 1],
  );

  h.clicks.handler({ position: { x: 1, y: 1 } });
  const [card] = h.overlay.entries.get('weather-warnings');
  assert.equal(card.id, `weather-warning-card:${id}`);

  hit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.deepEqual(h.opened, [
    'https://www.met.no/en/weather-and-climate/warnings',
  ]);

  hit = null;
  picked = { id: 'other:aircraft' };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.overlay.entries.get('weather-warnings').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.overlay.entries.get('weather-warnings').length, 0);

  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 2);
  assert.equal(records[1].level, 'red');
  assert.ok(Number.isFinite(records[0].lat));

  h.layer.disable();
  assert.equal(h.clicks.handler, null);
  h.layer.destroy();
  assert.equal(h.sources.length, 0);
});

test('a failed refresh reports an error without clearing the layer', async () => {
  const rows = normalizeWeatherWarningSnapshot({ features: [feature()] });
  let fail = false;
  const layer = createWeatherWarningsLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('MetAlerts HTTP 502');
        return rows;
      },
    },
  });
  layer.init({ dataSources: { add: () => {}, remove: () => {} } });
  layer.enable();
  assert.equal(await layer.update(), true);
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, 'MetAlerts HTTP 502');
  layer.destroy();
});
