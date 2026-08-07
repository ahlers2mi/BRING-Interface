// Cookidoo als zweite Rezeptquelle – getestet gegen eine nachgebaute Brücke.
// (Cookidoo selbst ist aus dieser Umgebung nicht erreichbar; die Feldnamen
// stammen aus den Typen von `cookidoo-api` 0.17.2, das der Sidecar benutzt.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import {
  collectRecipeIds,
  mapCookidooRecipe,
  minutesText,
} from '../lib/cookidoo.js';

const TOKEN = 'brücken-token';

// ── Fake-Brücke ───────────────────────────────────────────────────────────────

const calls = { collections: 0, details: 0, tokens: [] };

// Zwei Cookidoo-Rezepte und ein eigenes ("custom"), wie die Brücke sie liefert.
const recipes = new Map([
  [
    'r59',
    {
      id: 'r59',
      name: 'Kartoffelsuppe',
      url: 'https://cookidoo.de/recipes/recipe/de-DE/r59',
      image: 'https://assets.tmecosys.com/r59.jpg',
      serving_size: 4,
      active_time: 900,
      total_time: 2700,
      difficulty: 'easy',
      custom: false,
      categories: ['Suppen'],
      collections: ['Lieblinge'],
      notes: ['Mit Majoran abschmecken.'],
      ingredients: [
        { id: 'i1', name: 'Kartoffeln', description: '600 g' },
        { id: 'i2', name: 'Möhren', description: '2 Stück' },
        { id: 'i3', name: 'Sahne', description: '100 g' },
      ],
    },
  ],
  [
    'r77',
    {
      id: 'r77',
      name: 'Grüne Soße',
      url: 'https://cookidoo.de/recipes/recipe/de-DE/r77',
      image: null,
      serving_size: 2,
      active_time: 600,
      total_time: 600,
      difficulty: 'easy',
      custom: false,
      categories: [],
      collections: [],
      notes: [],
      ingredients: [{ id: 'i9', name: 'Kräuter', description: '1 Bund' }],
    },
  ],
  [
    'c1',
    {
      id: 'c1',
      name: 'Omas Grünkohl',
      url: 'https://cookidoo.de/created-recipes/de-DE/c1',
      image: null,
      serving_size: 6,
      active_time: 1800,
      total_time: 7200,
      custom: true,
      notes: ['Grünkohl waschen.', 'Zwei Stunden schmoren.'],
      ingredients: [
        { name: 'Grünkohl', description: '' },
        { name: 'Kohlwurst', description: '' },
      ],
    },
  ],
]);

// Welche Rezepte in welcher Sammlung liegen – der Abgleich fragt das zuerst ab.
let collections = [
  {
    id: 'coll-1',
    name: 'Wochenplan',
    kind: 'custom',
    description: null,
    recipes: [
      { id: 'r59', name: 'Kartoffelsuppe', total_time: 2700, chapter: 'Suppen' },
      { id: 'c1', name: 'Omas Grünkohl', total_time: 7200, chapter: 'Eigene' },
    ],
  },
  {
    id: 'coll-2',
    name: 'Beilagen',
    kind: 'custom',
    description: null,
    recipes: [{ id: 'r77', name: 'Grüne Soße', total_time: 600, chapter: 'Kalt' }],
  },
];

// Cookidoos eigene Einkaufsliste
let shopping = {
  ingredients: [
    { id: 's1', name: 'Kartoffeln', description: '600 g', is_owned: false },
    { id: 's2', name: 'Salz', description: '1 TL', is_owned: true }, // haben wir
  ],
  additional: [{ id: 's3', name: 'Backpapier', is_owned: false, description: '' }],
  recipes: [{ id: 'r59', name: 'Kartoffelsuppe' }],
};

let bridgeDown = false;

const bridge = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  calls.tokens.push(req.headers['x-bridge-token'] || '');

  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.headers['x-bridge-token'] !== TOKEN) {
    return json({ error: 'Token falsch.' }, 401);
  }
  if (bridgeDown) {
    return json({ error: 'CookidooAuthException: Anmeldung fehlgeschlagen' }, 502);
  }

  if (url.pathname === '/check') {
    return json({
      ok: true,
      user: { id: 'u1', username: 'frau@example.de' },
      subscription: { active: true, status: 'ACTIVE', subscription_level: 'PREMIUM' },
      localization: { country_code: 'de', language: 'de-DE' },
    });
  }

  if (url.pathname === '/collections') {
    calls.collections += 1;
    const kind = url.searchParams.get('kind') || 'all';
    return json({
      collections:
        kind === 'all' ? collections : collections.filter((c) => c.kind === kind),
    });
  }

  if (url.pathname === '/recipes/details' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => {
      calls.details += 1;
      const ids = JSON.parse(body || '{}').ids || [];
      const items = ids.map((id) => recipes.get(id)).filter(Boolean);
      const failed = ids
        .filter((id) => !recipes.has(id))
        .map((id) => ({ id, error: 'nicht gefunden' }));
      return json({ items, failed });
    });
  }

  if (url.pathname === '/shopping') return json(shopping);

  return json({ error: 'unbekannt' }, 404);
});

bridge.listen(0);
await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;

// ── App starten ───────────────────────────────────────────────────────────────

const dbFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bring-cookidoo-')),
  'test.db'
);
process.env.DB_PATH = dbFile;
process.env.PORT = '0';
delete process.env.APP_PASSWORD;
delete process.env.API_TOKEN;
delete process.env.MEALIE_URL; // Cookidoo läuft auch ohne Mealie
delete process.env.MEALIE_TOKEN;
process.env.COOKIDOO_URL = bridgeUrl;
process.env.COOKIDOO_TOKEN = TOKEN;
process.env.COOKIDOO_COLLECTIONS = 'custom';

const { app } = await import('../server.js');
const server = app.listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  bridge.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* egal */
  }
  return { status: res.status, json, text };
}

// ── Umrechnen (ohne Netz) ─────────────────────────────────────────────────────

test('Cookidoo rechnet in Sekunden, wir schreiben Minuten und Stunden', () => {
  assert.equal(minutesText(0), '');
  assert.equal(minutesText(null), '');
  assert.equal(minutesText(900), '15 Min.');
  assert.equal(minutesText(3600), '1 Std.');
  assert.equal(minutesText(2700), '45 Min.');
  assert.equal(minutesText(5400), '1 Std. 30 Min.');
});

test('Menge steht bei Cookidoo in der Beschreibung, nicht im Namen', () => {
  const mapped = mapCookidooRecipe(recipes.get('r59'));
  assert.deepEqual(mapped.ingredients[0], { name: 'Kartoffeln', amount: '600 g' });
  assert.equal(mapped.external_id, 'cookidoo:r59');
  assert.equal(mapped.source, 'cookidoo');
  assert.equal(mapped.servings, '4 Portionen');
  assert.equal(mapped.prep_time, '15 Min. aktiv · 45 Min.');
  assert.ok(mapped.tags.includes('Thermomix'));
  assert.ok(mapped.tags.includes('Suppen'));
  assert.equal(mapped.source_url, 'https://cookidoo.de/recipes/recipe/de-DE/r59');
  // Die Schritte gibt Cookidoo nicht heraus – Verweis statt leerem Feld.
  assert.match(mapped.instructions, /geführtes Kochen/);
  assert.match(mapped.instructions, /Majoran/);
});

test('eigene Rezepte bringen ihre Zubereitung mit', () => {
  const mapped = mapCookidooRecipe(recipes.get('c1'));
  assert.equal(mapped.instructions, 'Grünkohl waschen.\nZwei Stunden schmoren.');
  assert.ok(!/geführtes Kochen/.test(mapped.instructions));
  assert.deepEqual(
    mapped.ingredients.map((i) => i.name),
    ['Grünkohl', 'Kohlwurst']
  );
});

test('mapCookidooRecipe verwirft Unbrauchbares', () => {
  assert.equal(mapCookidooRecipe(null), null);
  assert.equal(mapCookidooRecipe({ id: 'x' }), null);
  assert.equal(mapCookidooRecipe({ name: 'ohne id' }), null);
});

test('collectRecipeIds zählt doppelte Rezepte einmal und achtet auf den Filter', () => {
  const doubled = [
    { name: 'A', recipes: [{ id: '1' }, { id: '2' }] },
    { name: 'B', recipes: [{ id: '2' }, { id: '3' }] },
  ];
  assert.deepEqual([...collectRecipeIds(doubled).keys()], ['1', '2', '3']);
  // Filter auf Sammlungsnamen, Groß-/Kleinschreibung egal
  assert.deepEqual([...collectRecipeIds(doubled, ['b']).keys()], ['2', '3']);
  assert.equal(collectRecipeIds(doubled, ['gibtsnicht']).size, 0);
});

// ── Abgleich über die Brücke ──────────────────────────────────────────────────

test('Status meldet Konto und Abo', async () => {
  const res = await api('/api/cookidoo/status');
  assert.equal(res.json.enabled, true);
  assert.equal(res.json.reachable, true);
  assert.equal(res.json.user, 'frau@example.de');
  assert.equal(res.json.subscriptionActive, true);
});

test('der Token wandert als Kopfzeile an die Brücke', () => {
  assert.ok(calls.tokens.length > 0);
  assert.ok(
    calls.tokens.every((t) => t === TOKEN),
    'jede Anfrage trägt den Token'
  );
});

test('Abgleich spiegelt die Rezepte der eigenen Sammlungen', async () => {
  const res = await api('/api/cookidoo/sync', { method: 'POST' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.status, 'done');
  assert.equal(res.json.total, 3);
  assert.equal(res.json.added, 3);
  assert.equal(res.json.failed, 0);

  const list = await api('/api/recipes');
  const suppe = list.json.find((r) => r.name === 'Kartoffelsuppe');
  assert.ok(suppe, 'Kartoffelsuppe erwartet');
  assert.equal(suppe.source, 'cookidoo');
  assert.equal(suppe.image_url, 'https://assets.tmecosys.com/r59.jpg');
  assert.equal(list.json.filter((r) => r.source === 'cookidoo').length, 3);
});

test('zweiter Abgleich legt nichts doppelt an', async () => {
  const res = await api('/api/cookidoo/sync', { method: 'POST' });
  assert.equal(res.json.added, 0);
  assert.equal(res.json.updated, 3);
  const list = await api('/api/recipes');
  assert.equal(list.json.filter((r) => r.name === 'Kartoffelsuppe').length, 1);
});

test('Thermomix-Rezepte landen im Würfeltopf und in der Wochen-Einkaufsliste', async () => {
  const rolled = await api('/api/plan/roll', { method: 'POST', body: { week: 'current' } });
  assert.equal(rolled.status, 200, rolled.text);
  assert.ok(rolled.json.plan.planned >= 1);

  const shoppingList = await api('/api/plan/shopping?all=1');
  assert.ok(shoppingList.json.items.length >= 1);
  // Mengen kommen mit. Bei drei Rezepten auf sieben Tage steht dasselbe Gericht
  // mehrmals im Plan – die Wochenliste addiert die Mengen dann.
  const kartoffeln = shoppingList.json.items.find((i) => /Kartoffeln/i.test(i.name));
  if (kartoffeln) assert.match(kartoffeln.amount, /600 g/);
});

test('aus einer Sammlung entfernte Rezepte werden als verschwunden markiert', async () => {
  const before = collections;
  collections = collections.filter((c) => c.name !== 'Beilagen');
  try {
    const res = await api('/api/cookidoo/sync', { method: 'POST' });
    assert.equal(res.json.missing, 1);
    const list = await api('/api/recipes');
    const gone = list.json.find((r) => r.name === 'Grüne Soße');
    assert.ok(gone.source_missing, 'bleibt als Historie stehen, wird nicht gelöscht');
  } finally {
    collections = before;
  }
});

test('Rezepte, die die Brücke nicht liefert, brechen den Abgleich nicht ab', async () => {
  const before = collections;
  collections = [
    ...collections,
    { id: 'coll-3', name: 'Kaputt', kind: 'custom', recipes: [{ id: 'gibtsnicht' }] },
  ];
  try {
    const res = await api('/api/cookidoo/sync', { method: 'POST' });
    assert.equal(res.json.status, 'done');
    assert.equal(res.json.failed, 1);
    assert.ok(res.json.added + res.json.updated >= 3);
  } finally {
    collections = before;
  }
});

// ── Einkaufsliste ─────────────────────────────────────────────────────────────

test('Cookidoos Einkaufsliste kommt ohne die abgehakten Sachen', async () => {
  const res = await api('/api/cookidoo/shopping');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(
    res.json.items.map((i) => i.name),
    ['Kartoffeln', 'Backpapier']
  );
  assert.equal(res.json.items[0].amount, '600 g');
  assert.deepEqual(res.json.recipes, ['Kartoffelsuppe']);
});

test('mit ?all=1 auch die schon vorhandenen', async () => {
  const res = await api('/api/cookidoo/shopping?all=1');
  assert.deepEqual(
    res.json.items.map((i) => i.name),
    ['Kartoffeln', 'Salz', 'Backpapier']
  );
});

test('ohne Bring-Liste keine Übertragung', async () => {
  const res = await api('/api/cookidoo/shopping', { method: 'POST', body: {} });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /listUuid/);
});

test('streikt die Brücke, sagt die App warum', async () => {
  bridgeDown = true;
  try {
    const status = await api('/api/cookidoo/status');
    assert.equal(status.json.reachable, false);
    assert.match(status.json.error, /Anmeldung fehlgeschlagen/);

    const shoppingRes = await api('/api/cookidoo/shopping');
    assert.equal(shoppingRes.status, 502);
    assert.match(shoppingRes.json.error, /Anmeldung fehlgeschlagen/);

    const sync = await api('/api/cookidoo/sync', { method: 'POST' });
    assert.equal(sync.status, 502);
    assert.match(sync.json.error, /Anmeldung fehlgeschlagen/);
  } finally {
    bridgeDown = false;
  }
});
