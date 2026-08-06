// Mealie als Rezeptquelle – getestet gegen einen nachgebauten Mealie-Server.
// (Die echte Demo-Instanz ist aus dieser Umgebung nicht erreichbar; die
// Feldnamen stammen aus Mealies Schema-Definitionen.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const TOKEN = 'mealie-token';

// ── Fake-Mealie ───────────────────────────────────────────────────────────────

const calls = { list: 0, detail: 0, patch: [], createUrl: [] };

// Zwei Rezepte, wie Mealie sie liefert: eines mit strukturierten Zutaten,
// eines mit Freitext-Zutaten (food/unit leer).
const recipes = new Map([
  [
    'auberginen-auflauf',
    {
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'auberginen-auflauf',
      name: 'Gefüllte Auberginen',
      description: 'Türkisch angelehnt',
      image: '1',
      recipeServings: 4,
      recipeYield: '',
      totalTime: '1 Stunde',
      prepTime: '20 Minuten',
      orgURL: 'https://www.chefkoch.de/rezepte/123/Auberginen.html',
      rating: null,
      lastMade: null,
      updatedAt: '2026-08-01T10:00:00',
      tags: [{ name: 'Ofen' }],
      recipeCategory: [{ name: 'Hauptgericht' }],
      recipeInstructions: [
        { text: 'Auberginen halbieren.' },
        { text: 'Füllung einfüllen und backen.' },
      ],
      recipeIngredient: [
        {
          quantity: 2,
          unit: null,
          food: { name: 'Auberginen' },
          note: '',
          display: '2 Auberginen',
        },
        {
          quantity: 200,
          unit: { name: 'Gramm', abbreviation: 'g' },
          food: { name: 'Hackfleisch' },
          note: 'gemischt',
          display: '200 g Hackfleisch',
        },
        {
          quantity: 0.5,
          unit: { name: 'Teelöffel', abbreviation: 'TL' },
          food: { name: 'Salz' },
          note: '',
          display: '0.5 TL Salz',
        },
      ],
    },
  ],
  [
    'pfannkuchen',
    {
      id: '22222222-2222-2222-2222-222222222222',
      slug: 'pfannkuchen',
      name: 'Pfannkuchen',
      description: '',
      image: null,
      recipeServings: 2,
      totalTime: '',
      prepTime: '15 Minuten',
      performTime: '10 Minuten',
      updatedAt: '2026-08-02T10:00:00',
      tags: [],
      recipeCategory: [],
      recipeInstructions: [{ text: 'Teig anrühren und braten.' }],
      recipeIngredient: [
        // Freitext-Zutat: Mealie füllt nur note/display
        { quantity: 0, unit: null, food: null, note: '250 g Mehl', display: '250 g Mehl' },
        { quantity: 3, unit: null, food: { name: 'Eier' }, note: '', display: '3 Eier' },
      ],
    },
  ],
]);

const mealie = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const auth = req.headers.authorization;

  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ detail: 'Not authenticated' }));
  }

  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/api/app/about') return json({ version: 'v2.0.0-test' });

  if (url.pathname === '/api/recipes' && req.method === 'GET') {
    calls.list += 1;
    const page = Number(url.searchParams.get('page') || 1);
    const items = page === 1 ? [...recipes.values()] : [];
    return json({
      items: items.map((r) => ({ id: r.id, slug: r.slug, name: r.name, updatedAt: r.updatedAt })),
      page,
      per_page: 100,
      total: items.length,
      total_pages: 1,
    });
  }

  // Mealies eigener URL-Importer
  if (url.pathname === '/api/recipes/create/url' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => {
      const { url: src } = JSON.parse(body || '{}');
      const id = /\/rezepte\/(\d+)\//.exec(src || '')?.[1] || String(recipes.size + 1);
      const slug = `chefkoch-${id}`;
      calls.createUrl.push(src);
      recipes.set(slug, {
        id: `ck-${id}`,
        slug,
        name: `Chefkoch-Rezept ${id}`,
        orgURL: src,
        updatedAt: '2026-08-06T10:00:00',
        recipeInstructions: [{ text: 'Kochen.' }],
        recipeIngredient: [
          { quantity: 1, unit: null, food: { name: 'Zutat' }, note: '', display: '1 Zutat' },
        ],
      });
      return json({ slug }, 201);
    });
  }

  const slug = /^\/api\/recipes\/([^/]+)$/.exec(url.pathname)?.[1];
  if (slug && req.method === 'GET') {
    calls.detail += 1;
    const recipe = recipes.get(slug);
    return recipe ? json(recipe) : json({ detail: 'not found' }, 404);
  }
  if (slug && req.method === 'PATCH') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      calls.patch.push({ slug, payload });
      Object.assign(recipes.get(slug) || {}, payload);
      return json({ ok: true });
    });
  }
  return json({ detail: 'not found' }, 404);
});

mealie.listen(0);
await once(mealie, 'listening');
const mealieUrl = `http://127.0.0.1:${mealie.address().port}`;

// ── App mit Mealie als Quelle starten ─────────────────────────────────────────

const dbFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bring-mealie-')),
  'test.db'
);
process.env.DB_PATH = dbFile;
process.env.PORT = '0';
delete process.env.APP_PASSWORD;
delete process.env.API_TOKEN;
process.env.MEALIE_URL = mealieUrl;
process.env.MEALIE_TOKEN = TOKEN;
process.env.MEALIE_RECIPE_URL = '{base}/g/home/r/{slug}';
// So sieht es in einer gemeinsamen Stack aus: intern der Dienstname, im Browser
// die Adresse der NAS. Hier steht statt des Dienstnamens der Testserver.
process.env.MEALIE_BASE_URL = 'http://192.168.69.10:9925';

const { app } = await import('../server.js');
const server = app.listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  mealie.close();
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

const todayIso = new Date().toISOString().slice(0, 10);

// ── Tests ─────────────────────────────────────────────────────────────────────

test('Status meldet Mealie als Quelle', async () => {
  const res = await api('/api/status');
  assert.equal(res.json.mealie.enabled, true);
  assert.equal(res.json.mealie.url, mealieUrl);
});

test('Links zeigen auf die Browser-Adresse, nicht auf die interne', async () => {
  const status = await api('/api/status');
  // Intern wird die API-Adresse benutzt …
  assert.equal(status.json.mealie.url, mealieUrl);
  // … für Links im Browser aber MEALIE_BASE_URL/MEALIE_PUBLIC_URL.
  assert.equal(status.json.mealie.publicUrl, 'http://192.168.69.10:9925');

  const link = await api('/api/mealie/recipe-url/auberginen-auflauf');
  assert.equal(
    link.json.url,
    'http://192.168.69.10:9925/g/home/r/auberginen-auflauf',
    'Rezept-Link muss vom Browser aus erreichbar sein'
  );

  // MEALIE_PUBLIC_URL hat Vorrang.
  process.env.MEALIE_PUBLIC_URL = 'https://mealie.example.org';
  try {
    const withPublic = await api('/api/mealie/recipe-url/auberginen-auflauf');
    assert.equal(
      withPublic.json.url,
      'https://mealie.example.org/g/home/r/auberginen-auflauf'
    );
  } finally {
    delete process.env.MEALIE_PUBLIC_URL;
  }
});

test('Abgleich spiegelt Rezepte samt Zutaten, Zeiten und Tags', async () => {
  const sync = await api('/api/mealie/sync', { method: 'POST' });
  assert.equal(sync.status, 200, sync.text);
  assert.equal(sync.json.status, 'done');
  assert.equal(sync.json.added, 2);
  assert.equal(sync.json.version, 'v2.0.0-test');

  const list = await api('/api/recipes');
  assert.equal(list.json.length, 2);

  const auflauf = list.json.find((r) => r.name === 'Gefüllte Auberginen');
  assert.equal(auflauf.source, 'mealie');
  assert.equal(auflauf.external_id, 'mealie:11111111-1111-1111-1111-111111111111');
  assert.equal(auflauf.source_slug, 'auberginen-auflauf');
  assert.equal(auflauf.prep_time, '1 Stunde');
  assert.equal(auflauf.servings, '4 Portionen');
  assert.equal(auflauf.source_url, 'https://www.chefkoch.de/rezepte/123/Auberginen.html');
  assert.deepEqual(auflauf.tags, ['Ofen', 'Hauptgericht']);
  assert.match(auflauf.image_url, /\/api\/media\/recipes\/11111111.*min-original\.webp$/);
  assert.equal(
    auflauf.instructions,
    '1. Auberginen halbieren.\n2. Füllung einfüllen und backen.'
  );
  // Fehlende Mengen liegen wie bei lokalen Rezepten als NULL in der Datenbank.
  const asText = (list) => list.map((i) => `${i.amount || ''}|${i.name}`);
  assert.deepEqual(
    asText(auflauf.ingredients),
    ['2|Auberginen', '200 g|Hackfleisch, gemischt', '1/2 TL|Salz']
  );

  // Freitext-Zutaten (ohne food/unit) landen als Text im Namen.
  const pfann = list.json.find((r) => r.name === 'Pfannkuchen');
  assert.deepEqual(asText(pfann.ingredients), ['|250 g Mehl', '3|Eier']);
  assert.equal(pfann.prep_time, '15 Minuten + 10 Minuten');
});

test('zweiter Abgleich holt keine Details erneut', async () => {
  const before = calls.detail;
  const sync = await api('/api/mealie/sync', { method: 'POST' });
  assert.equal(sync.json.unchanged, 2);
  assert.equal(sync.json.added, 0);
  assert.equal(calls.detail, before, 'unveränderte Rezepte werden nicht neu geladen');
});

test('Änderung in Mealie wird übernommen, ohne die id zu verlieren', async () => {
  const listBefore = await api('/api/recipes');
  const idBefore = listBefore.json.find((r) => r.name === 'Pfannkuchen').id;

  const recipe = recipes.get('pfannkuchen');
  recipe.name = 'Pfannkuchen mit Apfelmus';
  recipe.updatedAt = '2026-08-03T10:00:00';
  recipe.recipeIngredient.push({
    quantity: 1,
    unit: { name: 'Glas', abbreviation: null },
    food: { name: 'Apfelmus' },
    note: '',
    display: '1 Glas Apfelmus',
  });

  const sync = await api('/api/mealie/sync', { method: 'POST' });
  assert.equal(sync.json.updated, 1);

  const after = await api(`/api/recipes/${idBefore}`);
  assert.equal(after.json.name, 'Pfannkuchen mit Apfelmus');
  assert.equal(after.json.ingredients.length, 3);
  assert.ok(after.json.ingredients.some((i) => i.name === 'Apfelmus'));
});

test('Rezepte pflegt man in Mealie – lokale Änderungen sind gesperrt', async () => {
  const created = await api('/api/recipes', {
    method: 'POST',
    body: { name: 'Von Hand' },
  });
  assert.equal(created.status, 409);
  assert.match(created.json.error, /in Mealie gepflegt/);

  const list = await api('/api/recipes');
  const id = list.json[0].id;
  assert.equal((await api(`/api/recipes/${id}`, { method: 'PUT', body: { name: 'x' } })).status, 409);
  assert.equal((await api(`/api/recipes/${id}`, { method: 'DELETE' })).status, 409);
  assert.equal(
    (await api('/api/recipes/import/chefkoch', { method: 'POST', body: { count: 1 } })).status,
    409
  );
});

test('Würfeln und Bewerten laufen auf dem Spiegel', async () => {
  const rolled = await api('/api/plan/roll', { method: 'POST', body: { week: 'current' } });
  assert.equal(rolled.status, 200, rolled.text);
  assert.equal(rolled.json.plan.planned, 7);

  const rated = await api(`/api/plan/${todayIso}/rate`, {
    method: 'POST',
    body: { rating: 'lecker' },
  });
  assert.equal(rated.status, 200, rated.text);
  const today = rated.json.plan.days.find((d) => d.date === todayIso);
  assert.equal(today.rating.stars, 5);
  assert.equal(today.status, 'cooked');
});

test('Bewertung wird nach Mealie zurückgeschrieben', async () => {
  // Der Push läuft absichtlich ohne await – kurz warten.
  for (let i = 0; i < 50 && calls.patch.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(calls.patch.length >= 1, 'PATCH an Mealie erwartet');
  const last = calls.patch.at(-1);
  assert.equal(last.payload.rating, 5);
  assert.match(last.payload.lastMade, new RegExp(`^${todayIso}T`));
});

test('in Mealie gelöschte Rezepte bleiben mit Historie, werden aber nicht gewürfelt', async () => {
  const list = await api('/api/recipes');
  const pfann = list.json.find((r) => r.name.startsWith('Pfannkuchen'));
  recipes.delete('pfannkuchen');

  const sync = await api('/api/mealie/sync', { method: 'POST' });
  assert.equal(sync.json.missing, 1);

  const after = await api(`/api/recipes/${pfann.id}`);
  assert.equal(after.status, 200, 'Rezept bleibt erhalten');
  assert.equal(after.json.source_missing, true);

  // Der Würfel darf es nicht mehr ziehen. Gekochte Tage sind ausgenommen: die
  // sind Historie und behalten ihr Rezept, auch wenn es in Mealie weg ist.
  for (let i = 0; i < 8; i += 1) {
    const res = await api('/api/plan/roll', { method: 'POST', body: { week: 'current' } });
    for (const day of res.json.plan.days) {
      if (!day.recipe || day.status === 'cooked') continue;
      assert.notEqual(day.recipe.id, pfann.id, 'verschwundenes Rezept gewürfelt');
    }
  }

  // Wieder in Mealie vorhanden -> Markierung fällt weg.
  recipes.set('pfannkuchen', {
    id: '22222222-2222-2222-2222-222222222222',
    slug: 'pfannkuchen',
    name: 'Pfannkuchen mit Apfelmus',
    updatedAt: '2026-08-04T10:00:00',
    recipeInstructions: [],
    recipeIngredient: [{ quantity: 3, unit: null, food: { name: 'Eier' }, display: '3 Eier' }],
  });
  await api('/api/mealie/sync', { method: 'POST' });
  const back = await api(`/api/recipes/${pfann.id}`);
  assert.equal(back.json.source_missing, false);
});

test('falscher Token liefert eine verständliche Meldung', async () => {
  const good = process.env.MEALIE_TOKEN;
  process.env.MEALIE_TOKEN = 'falsch';
  try {
    const res = await api('/api/mealie/sync', { method: 'POST' });
    assert.equal(res.status, 502);
    assert.match(res.json.error, /Token/);
    assert.match(res.json.error, /API Tokens/);
  } finally {
    process.env.MEALIE_TOKEN = good;
  }
});

test('Status meldet Erreichbarkeit und Version', async () => {
  const res = await api('/api/mealie/status');
  assert.equal(res.json.reachable, true);
  assert.equal(res.json.version, 'v2.0.0-test');
  assert.ok(res.json.finishedAt);
});

// ── Chefkoch -> Mealie ────────────────────────────────────────────────────────

test('Chefkoch-Suche übergibt die URLs an Mealies Importer', async () => {
  const realFetch = globalThis.fetch;
  // Chefkoch nachbauen, alles Richtung Testserver durchlassen.
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (href.includes('127.0.0.1')) return realFetch(input, init);
    if (href.includes('/search-gateway/recipes')) {
      const offset = Number(/offset=(\d+)/.exec(href)?.[1] || 0);
      const results =
        offset === 0 ? [901, 902, 903].map((n) => ({ recipe: { id: `20000000${n}` } })) : [];
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const start = await api('/api/mealie/import-chefkoch', {
      method: 'POST',
      body: { query: 'auflauf', count: 3 },
    });
    assert.equal(start.status, 202, start.text);

    // Ein zweiter Lauf parallel wird abgelehnt.
    const parallel = await api('/api/mealie/import-chefkoch', {
      method: 'POST',
      body: { count: 3 },
    });
    assert.equal(parallel.status, 409);

    let job = null;
    for (let i = 0; i < 100; i += 1) {
      job = (await api('/api/mealie/import-status')).json;
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, 'done', JSON.stringify(job.log));
    assert.equal(job.imported, 3);
    assert.equal(job.failed, 0);

    // Die URLs sind bei Mealie angekommen …
    assert.equal(calls.createUrl.length, 3);
    assert.match(calls.createUrl[0], /^https:\/\/www\.chefkoch\.de\/rezepte\/\d+\/$/);

    // … und der Abgleich am Ende hat sie in den Spiegel geholt.
    const list = await api('/api/recipes');
    const imported = list.json.filter((r) => r.name.startsWith('Chefkoch-Rezept'));
    assert.equal(imported.length, 3);
    assert.equal(imported[0].source, 'mealie');
    assert.match(imported[0].source_url, /chefkoch\.de/);

    // Zweiter Lauf: dieselben Rezepte werden übersprungen, nicht doppelt angelegt.
    const before = calls.createUrl.length;
    await api('/api/mealie/import-chefkoch', {
      method: 'POST',
      body: { query: 'auflauf', count: 3 },
    });
    for (let i = 0; i < 100; i += 1) {
      job = (await api('/api/mealie/import-status')).json;
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.skipped, 3);
    assert.equal(job.imported, 0);
    assert.equal(calls.createUrl.length, before, 'keine erneuten Importe');
  } finally {
    globalThis.fetch = realFetch;
  }
});
