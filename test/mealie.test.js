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

const calls = { list: 0, detail: 0, patch: [], createUrl: [], deleted: [] };

// Mealies Menüplan-Kalender
const mealplans = [];
let mealplanId = 0;

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

  // ── Menüplan (ab Mealie v2 unter /api/households) ──────────────────────────
  const readBody = (fn) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => fn(JSON.parse(body || '{}')));
  };

  if (url.pathname === '/api/households/mealplans') {
    if (req.method === 'GET') {
      const from = url.searchParams.get('start_date');
      const to = url.searchParams.get('end_date');
      const items = mealplans.filter(
        (e) => (!from || e.date >= from) && (!to || e.date <= to)
      );
      return json({ items, page: 1, total: items.length });
    }
    if (req.method === 'POST') {
      return readBody((payload) => {
        const entry = { id: ++mealplanId, householdId: 'h1', userId: 'u1', ...payload };
        mealplans.push(entry);
        return json(entry, 201);
      });
    }
  }

  const planId = /^\/api\/households\/mealplans\/(\d+)$/.exec(url.pathname)?.[1];
  if (planId) {
    const index = mealplans.findIndex((e) => String(e.id) === planId);
    if (index < 0) return json({ detail: 'not found' }, 404);
    if (req.method === 'DELETE') {
      const [gone] = mealplans.splice(index, 1);
      return json(gone);
    }
    if (req.method === 'PUT') {
      return readBody((payload) => {
        mealplans[index] = { ...mealplans[index], ...payload, id: mealplans[index].id };
        return json(mealplans[index]);
      });
    }
  }

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
  if (slug && req.method === 'DELETE') {
    const existed = recipes.delete(slug);
    calls.deleted.push(slug);
    return existed ? json({ slug }) : json({ detail: 'not found' }, 404);
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
  // Bilder laufen über unseren Server (MEALIE_URL ist im Browser nicht erreichbar).
  assert.equal(auflauf.image_url, '/api/mealie/image/11111111-1111-1111-1111-111111111111');
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

  // Für den folgenden Löschtest wieder aus Mealie entfernen.
  recipes.delete('pfannkuchen');
  await api('/api/mealie/sync', { method: 'POST' });
});

test('in Mealie gelöschte Rezepte darf man hier entfernen, andere nicht', async () => {
  const list = await api('/api/recipes');
  const lebendig = list.json.find((r) => !r.source_missing);
  const verschwunden = list.json.find((r) => r.source_missing);

  // Ein Rezept, das es in Mealie noch gibt: hier gesperrt.
  const gesperrt = await api(`/api/recipes/${lebendig.id}`, { method: 'DELETE' });
  assert.equal(gesperrt.status, 409);
  assert.match(gesperrt.json.error, /In Mealie löschen/);
  assert.match(gesperrt.json.error, /Manage Data/);

  // Eines, das in Mealie weg ist: darf raus (nur noch Historie).
  assert.ok(verschwunden, 'Testaufbau: ein in Mealie gelöschtes Rezept');
  const weg = await api(`/api/recipes/${verschwunden.id}`, { method: 'DELETE' });
  assert.equal(weg.status, 200, weg.text);
  assert.equal((await api(`/api/recipes/${verschwunden.id}`)).status, 404);
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

test('Knopf "In Mealie löschen": Rezept ohne Historie verschwindet ganz', async () => {
  // Ein frisch importiertes Chefkoch-Rezept hat weder Bewertung noch Plan-Eintrag.
  const list = await api('/api/recipes');
  const frisch = list.json.find((r) => r.name.startsWith('Chefkoch-Rezept'));
  assert.ok(frisch, 'Testaufbau: importiertes Rezept vorhanden');

  const res = await api(`/api/mealie/recipe/${frisch.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.deleted, true);
  assert.equal(res.json.kept, false);

  // In Mealie weg …
  assert.ok(calls.deleted.includes(frisch.source_slug));
  // … und hier auch.
  assert.equal((await api(`/api/recipes/${frisch.id}`)).status, 404);
});

test('Knopf "In Mealie löschen": Rezept mit Historie bleibt als Historie stehen', async () => {
  // Historie selbst herstellen, statt sich auf einen früheren Würfelwurf zu
  // verlassen: ein vorhandenes Mealie-Rezept einplanen und bewerten.
  const kandidaten = (await api('/api/recipes')).json.filter(
    (r) => r.source_slug && !r.source_missing
  );
  assert.ok(kandidaten.length, 'Testaufbau: Mealie-Rezept vorhanden');
  const ziel = kandidaten[0];
  await api(`/api/plan/${todayIso}`, { method: 'PUT', body: { recipe_id: ziel.id } });
  await api(`/api/plan/${todayIso}/rate`, { method: 'POST', body: { rating: 'gut' } });

  const mitHistorie = (await api(`/api/recipes/${ziel.id}`)).json;
  assert.ok(mitHistorie.rating_count > 0, 'Bewertung sitzt');

  const res = await api(`/api/mealie/recipe/${mitHistorie.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.kept, true);
  assert.match(res.json.message, /Bewertungen/);

  const after = await api(`/api/recipes/${mitHistorie.id}`);
  assert.equal(after.status, 200, 'Rezept bleibt wegen der Historie');
  assert.equal(after.json.source_missing, true);
  assert.equal(after.json.rating_count, mitHistorie.rating_count, 'Bewertungen erhalten');
});

// ── Verwaiste aufräumen ───────────────────────────────────────────────────────

test('verwaiste Rezepte lassen sich auflisten und aufräumen', async () => {
  // Zwei Rezepte in Mealie anlegen, spiegeln, eines bewerten, dann beide in
  // Mealie löschen -> beide verwaist, eines mit Historie.
  for (const n of [1, 2]) {
    recipes.set(`weg-${n}`, {
      id: `weg-${n}`,
      slug: `weg-${n}`,
      name: `Wegwerf ${n}`,
      updatedAt: '2026-08-07T10:00:00',
      recipeInstructions: [],
      recipeIngredient: [{ quantity: 1, unit: null, food: { name: 'Zutat' } }],
    });
  }
  await api('/api/mealie/sync', { method: 'POST' });
  const mirrored = (await api('/api/recipes')).json.filter((r) =>
    r.name.startsWith('Wegwerf')
  );
  assert.equal(mirrored.length, 2);

  const mitHistorie = mirrored[0];
  await api(`/api/recipes/${mitHistorie.id}/rate`, {
    method: 'POST',
    body: { rating: 'gut' },
  });

  recipes.delete('weg-1');
  recipes.delete('weg-2');
  await api('/api/mealie/sync', { method: 'POST' });

  // Vorschau: beide verwaist, eines davon mit Historie.
  const list = await api('/api/mealie/orphans');
  const namen = list.json.items.map((i) => i.name);
  assert.ok(namen.includes('Wegwerf 1') && namen.includes('Wegwerf 2'), namen.join(','));
  assert.ok(list.json.with_history >= 1);
  assert.ok(list.json.without_history >= 1);

  // Aufräumen ohne Historie: das bewertete bleibt stehen.
  const clean = await api('/api/mealie/orphans', { method: 'DELETE' });
  assert.equal(clean.status, 200, clean.text);
  assert.ok(clean.json.deleted >= 1);
  assert.equal((await api(`/api/recipes/${mitHistorie.id}`)).status, 200, 'Historie behalten');

  const rest = await api('/api/mealie/orphans');
  assert.ok(rest.json.items.every((i) => i.has_history), 'nur noch Rezepte mit Historie');

  // Mit Historie: jetzt ist alles weg.
  const all = await api('/api/mealie/orphans?withHistory=1', { method: 'DELETE' });
  assert.ok(all.json.deleted >= 1);
  assert.equal((await api(`/api/recipes/${mitHistorie.id}`)).status, 404);
  assert.equal((await api('/api/mealie/orphans')).json.count, 0);
});

// ── Teaser-Rezepte (PLUS) aus der Chefkoch-API ergänzen ───────────────────────

test('dünn importierte Chefkoch-Rezepte werden aus der API ergänzt', async () => {
  const realFetch = globalThis.fetch;
  // Mealies Scraper liefert nur einen Teaser, die Chefkoch-API das ganze Rezept.
  recipes.set('teaser', {
    id: 'teaser-1',
    slug: 'teaser',
    name: 'One-Pot-Pasta',
    orgURL: 'https://www.chefkoch.de/rezepte/4160151664389021/One-Pot-Pasta.html',
    updatedAt: '2026-08-07T12:00:00',
    recipeInstructions: [{ text: 'Instructions not provided.' }],
    recipeIngredient: [
      { quantity: 1, unit: null, food: { name: 'Zwiebel' } },
      { quantity: 1, unit: null, food: { name: 'Knoblauchzehe' } },
      { quantity: 100, unit: { abbreviation: 'g' }, food: { name: 'Pfifferlinge' } },
    ],
  });
  await api('/api/mealie/sync', { method: 'POST' });

  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (href.includes('127.0.0.1')) return realFetch(input, init);
    if (href.includes('api.chefkoch.de/v2/recipes/4160151664389021')) {
      return new Response(
        JSON.stringify({
          id: '4160151664389021',
          title: 'One-Pot-Pasta mit Spinat und Pfifferlingen',
          instructions: 'Zwiebel würfeln.\nAlles in den Topf.\nKöcheln lassen.',
          servings: 2,
          preparationTime: 15,
          siteUrl: 'https://www.chefkoch.de/rezepte/4160151664389021/One-Pot-Pasta.html',
          ingredientGroups: [
            {
              ingredients: [
                { name: 'Zwiebel', unit: '', amount: 1 },
                { name: 'Knoblauchzehe', unit: '', amount: 1 },
                { name: 'Pfifferlinge', unit: 'g', amount: 100 },
                { name: 'Spaghetti', unit: 'g', amount: 250 },
                { name: 'Sahne', unit: 'ml', amount: 200 },
                { name: 'Blattspinat', unit: 'g', amount: 150 },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const res = await api('/api/mealie/repair', { method: 'POST' });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.json.checked >= 1, JSON.stringify(res.json));
    assert.equal(res.json.repaired, 1);

    // In Mealie steht jetzt das ganze Rezept …
    const inMealie = recipes.get('teaser');
    assert.equal(inMealie.recipeIngredient.length, 6);
    assert.equal(inMealie.recipeInstructions.length, 3);
    assert.match(inMealie.recipeInstructions[0].text, /Zwiebel würfeln/);

    // … und der Spiegel hat es übernommen, obwohl das Test-Mealie sein
    // `updatedAt` beim PATCH absichtlich NICHT hochzählt.
    assert.equal(inMealie.updatedAt, '2026-08-07T12:00:00');
    const mirrored = (await api('/api/recipes')).json.find((r) => r.source_slug === 'teaser');
    assert.equal(mirrored.ingredients.length, 6);
    assert.match(mirrored.instructions, /Alles in den Topf/);
    assert.ok(mirrored.ingredients.some((i) => i.name.includes('Spaghetti')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('liefert die Chefkoch-API auch nichts, bleibt es beim Teaser', async () => {
  const realFetch = globalThis.fetch;
  recipes.set('plus-only', {
    id: 'plus-1',
    slug: 'plus-only',
    name: 'PLUS-Rezept',
    orgURL: 'https://www.chefkoch.de/rezepte/999999999999/Plus.html',
    updatedAt: '2026-08-07T13:00:00',
    recipeInstructions: [],
    recipeIngredient: [{ quantity: 1, unit: null, food: { name: 'Geheimnis' } }],
  });
  await api('/api/mealie/sync', { method: 'POST' });

  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (href.includes('127.0.0.1')) return realFetch(input, init);
    return new Response('paywall', { status: 403 }); // API und HTML gesperrt
  };
  try {
    const res = await api('/api/mealie/repair', { method: 'POST' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.repaired, 0);
    assert.ok(res.json.unchanged + res.json.failed >= 1);
    // Nichts kaputt gemacht:
    assert.equal(recipes.get('plus-only').recipeIngredient.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Menüplan nach Mealie ──────────────────────────────────────────────────────

// Der Push läuft in den Routen absichtlich ohne await – deshalb warten.
async function waitFor(check, what) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail(`Zeitüberschreitung beim Warten auf: ${what}`);
}

// Ein Rezept, das wirklich aus Mealie stammt – nur dann gibt es eine UUID zum
// Verknüpfen. Vorherige Tests löschen Rezepte, deshalb frisch nachsehen.
async function aMealieRecipe(skipId = null) {
  const list = await api('/api/recipes');
  const hit = list.json.find(
    (r) => /^mealie:/.test(r.external_id || '') && !r.source_missing && r.id !== skipId
  );
  assert.ok(hit, 'Rezept aus Mealie erwartet');
  return hit;
}

test('ein geplanter Tag landet in Mealies Menüplan', async () => {
  mealplans.length = 0;
  const recipe = await aMealieRecipe();
  const res = await api(`/api/plan/${todayIso}`, {
    method: 'PUT',
    body: { recipe_id: recipe.id },
  });
  assert.equal(res.status, 200, res.text);

  await waitFor(() => mealplans.length === 1, 'Eintrag in Mealie');
  const entry = mealplans[0];
  assert.equal(entry.date, todayIso);
  assert.equal(entry.entryType, 'dinner');
  // Rezept per UUID verknüpft, nicht als Freitext.
  assert.equal(entry.recipeId, recipe.external_id.replace('mealie:', ''));
  assert.equal(entry.title, '');
});

test('ein anderes Gericht überschreibt den Eintrag, statt einen zweiten anzulegen', async () => {
  const before = mealplans[0].id;
  const other = await aMealieRecipe(mealplans[0].recipeId);
  const res = await api(`/api/plan/${todayIso}`, {
    method: 'PUT',
    body: { recipe_id: other.id },
  });
  assert.equal(res.status, 200, res.text);

  const wanted = other.external_id.replace('mealie:', '');
  await waitFor(() => mealplans[0]?.recipeId === wanted, 'aktualisierter Eintrag');
  assert.equal(mealplans.length, 1);
  assert.equal(mealplans[0].id, before, 'derselbe Mealie-Eintrag wird weiterverwendet');
});

test('fremde Mahlzeiten in Mealie bleiben unangetastet', async () => {
  mealplans.length = 0;
  mealplans.push({ id: ++mealplanId, date: todayIso, entryType: 'breakfast', title: 'Müsli' });

  const res = await api('/api/plan/mealie', { method: 'POST', body: { week: 'current' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.failed, 0);
  assert.equal(res.json.pushed, 7, 'alle sieben Tage abgearbeitet');

  const breakfast = mealplans.filter((e) => e.entryType === 'breakfast');
  assert.equal(breakfast.length, 1, 'Frühstück darf nicht verschwinden');
  assert.equal(breakfast[0].title, 'Müsli');

  // Leere Tage bekommen keinen Eintrag – abgeglichen wird gegen den Plan.
  const plan = await api('/api/plan?week=current');
  const dinners = mealplans.filter((e) => e.entryType === 'dinner');
  assert.equal(dinners.length, plan.json.planned, 'je geplanten Tag genau ein Abendessen');
  assert.equal(new Set(dinners.map((e) => e.date)).size, dinners.length, 'keine Doppelten');
});

test('Tag leeren entfernt den Eintrag auch in Mealie', async () => {
  const res = await api(`/api/plan/${todayIso}`, { method: 'DELETE' });
  assert.equal(res.status, 200, res.text);

  await waitFor(
    () => !mealplans.some((e) => e.date === todayIso && e.entryType === 'dinner'),
    'gelöschter Eintrag'
  );
  // Das Frühstück steht weiterhin.
  assert.ok(mealplans.some((e) => e.date === todayIso && e.entryType === 'breakfast'));
});

test('ältere Mealie-Versionen: Rückfall auf /api/groups/mealplans', async () => {
  const { pushPlanEntryToMealie, resetMealiePlanPath } = await import('../lib/mealie.js');
  resetMealiePlanPath();
  const seen = [];
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    seen.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.pathname.startsWith('/api/households/')) {
      return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
    }
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ id: 7 }), { status: 201 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  const ok = await pushPlanEntryToMealie(
    { date: '2026-08-10', mealieId: 'uuid-1' },
    { fetchImpl: fakeFetch }
  );
  resetMealiePlanPath();

  assert.equal(ok, true);
  assert.ok(seen.includes('GET /api/households/mealplans'), 'neuer Pfad wird zuerst probiert');
  assert.ok(seen.includes('POST /api/groups/mealplans'), 'danach der alte Pfad');
});

test('Rezept ohne Mealie-Herkunft landet als Titel im Kalender', async () => {
  const { pushPlanEntryToMealie, resetMealiePlanPath, mealieIdOf } = await import(
    '../lib/mealie.js'
  );
  assert.equal(mealieIdOf({ external_id: 'mealie:abc' }), 'abc');
  assert.equal(mealieIdOf({ external_id: 'chefkoch:123' }), '');
  assert.equal(mealieIdOf(null), '');

  resetMealiePlanPath();
  let posted = null;
  const fakeFetch = async (input, init = {}) => {
    if ((init.method || 'GET') === 'POST') {
      posted = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 9 }), { status: 201 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  await pushPlanEntryToMealie(
    { date: '2026-08-11', title: 'Omas Grünkohl', note: 'von Hand gewählt' },
    { fetchImpl: fakeFetch }
  );
  resetMealiePlanPath();

  assert.equal(posted.title, 'Omas Grünkohl');
  assert.equal(posted.recipeId, null);
  assert.equal(posted.text, 'von Hand gewählt');
});

// ── Einzelnes Rezept anreichern ───────────────────────────────────────────────

test('ein PLUS-Anriss sieht vollständig aus, ist es aber nicht', async () => {
  recipes.set('spanisch', {
    id: 'sp-1',
    slug: 'spanisch',
    name: 'Spanischer Kartoffelauflauf',
    orgURL: 'https://www.chefkoch.de/rezepte/4711/Spanisch.html',
    updatedAt: '2026-08-08T09:00:00',
    recipeInstructions: [{ text: 'Alles schichten und backen.' }],
    recipeIngredient: [
      { quantity: 450, unit: { abbreviation: 'g' }, food: { name: 'Kartoffeln' } },
      { quantity: 450, unit: { abbreviation: 'g' }, food: { name: 'Süßkartoffeln' } },
      { quantity: 2, unit: null, food: { name: 'Spitzpaprika' } },
      { quantity: 0, unit: null, food: null, note: '-- additional ingredients not fully disclosed --' },
    ],
  });
  await api('/api/mealie/sync', { method: 'POST' });

  const mirrored = (await api('/api/recipes')).json.find((r) => r.source_slug === 'spanisch');
  // Vier Zutaten und eine Zubereitung – trotzdem unvollständig.
  assert.equal(mirrored.ingredients.length, 4);
  assert.equal(mirrored.incomplete, true);
});

test('unvollständige Rezepte werden nicht gewürfelt', async () => {
  const mirrored = (await api('/api/recipes')).json.find((r) => r.source_slug === 'spanisch');
  const plan = await api('/api/plan/roll', { method: 'POST', body: { week: 'current' } });
  const planned = plan.json.plan.days.map((d) => d.recipe?.id).filter(Boolean);
  assert.ok(!planned.includes(mirrored.id), 'Anriss darf nicht im Plan landen');
});

test('der Platzhalter landet nicht auf dem Einkaufszettel', async () => {
  const mirrored = (await api('/api/recipes')).json.find((r) => r.source_slug === 'spanisch');
  const day = todayIso;
  await api(`/api/plan/${day}`, { method: 'PUT', body: { recipe_id: mirrored.id } });
  const shoppingList = await api('/api/plan/shopping?all=1');
  assert.ok(
    !shoppingList.json.items.some((i) => /disclosed/i.test(i.name)),
    'Platzhalter darf nicht in die Bring-Liste'
  );
  assert.ok(shoppingList.json.items.some((i) => /Kartoffeln/.test(i.name)));
});

test('Absprung im Wochenplan zeigt nach Mealie, nicht auf die gesperrte Quelle', async () => {
  const plan = await api('/api/plan?week=current');
  const day = plan.json.days.find((d) => d.recipe?.id);
  assert.ok(day, 'ein geplanter Tag erwartet');
  assert.match(day.recipe.link, /\/g\/home\/r\//);
  assert.ok(!day.recipe.link.includes('chefkoch.de'));
});

test('Anreichern einzeln: Chefkoch gibt nichts her, die Antwort sagt warum', async () => {
  const mirrored = (await api('/api/recipes')).json.find((r) => r.source_slug === 'spanisch');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (href.includes('127.0.0.1')) return realFetch(input, init);
    return new Response('paywall', { status: 403 });
  };
  try {
    const res = await api(`/api/mealie/repair/${mirrored.id}`, { method: 'POST' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.outcome, 'no-data');
    assert.match(res.json.message, /PLUS/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Anreichern einzeln: was die Chefkoch-API hergibt, wird nachgetragen', async () => {
  const mirrored = (await api('/api/recipes')).json.find((r) => r.source_slug === 'spanisch');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (href.includes('127.0.0.1')) return realFetch(input, init);
    if (href.includes('api.chefkoch.de') && href.includes('4711')) {
      return new Response(
        JSON.stringify({
          id: '4711',
          title: 'Spanischer Kartoffelauflauf',
          instructions: 'Kartoffeln hobeln.\nChorizo anbraten.\nBacken.',
          servings: 6,
          preparationTime: 30,
          ingredientGroups: [
            {
              ingredients: [
                { name: 'Kartoffeln', unit: 'g', amount: 450 },
                { name: 'Süßkartoffeln', unit: 'g', amount: 450 },
                { name: 'Spitzpaprika', unit: '', amount: 2 },
                { name: 'Chorizo', unit: 'g', amount: 200 },
                { name: 'Manchego', unit: 'g', amount: 100 },
                { name: 'Mandeln', unit: 'g', amount: 50 },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await api(`/api/mealie/repair/${mirrored.id}`, { method: 'POST' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.outcome, 'repaired', res.text);
    assert.equal(res.json.recipe.incomplete, false);
    assert.ok(res.json.recipe.ingredients.length >= 6);
    assert.match(res.json.recipe.instructions, /Chorizo anbraten/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Anreichern einzeln: ohne Chefkoch-Quelle gibt es eine klare Absage', async () => {
  const other = (await api('/api/recipes')).json.find(
    (r) => r.source_slug && !/chefkoch\.de/.test(r.source_url || '')
  );
  if (!other) return; // kein passendes Rezept übrig – dann ist nichts zu prüfen
  const res = await api(`/api/mealie/repair/${other.id}`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Chefkoch/);
});

// ── Ein Rezept per Link (auch vom Handy) ──────────────────────────────────────

test('Link hinzufügen: Mealie importiert, der Spiegel zieht sofort nach', async () => {
  const before = (await api('/api/recipes')).json.length;
  const res = await api('/api/recipes/add', {
    method: 'POST',
    body: { url: 'https://www.chefkoch.de/rezepte/555555/Neu.html' },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.target, 'mealie');
  assert.equal(res.json.name, 'Chefkoch-Rezept 555555');
  assert.match(res.json.link, /\/g\/home\/r\/chefkoch-555555/);

  // Ohne zusätzlichen Abgleich schon in der Liste – sonst wartet man 15 Minuten.
  const list = (await api('/api/recipes')).json;
  assert.equal(list.length, before + 1);
  assert.ok(list.some((r) => r.source_slug === 'chefkoch-555555'));
});

test('Link hinzufügen: dasselbe Rezept ein zweites Mal wird erkannt', async () => {
  const res = await api('/api/recipes/add', {
    method: 'POST',
    body: { url: 'https://www.chefkoch.de/rezepte/555555/Anderer-Titel.html' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.duplicate, true);
  assert.match(res.json.message, /Kennen wir schon/);
});

test('Link hinzufügen geht auch per GET – dafür der iOS-Kurzbefehl', async () => {
  const url = encodeURIComponent('https://www.chefkoch.de/rezepte/666666/Kurzbefehl.html');
  const res = await api(`/api/recipes/add?url=${url}`);
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.ok, true);
  assert.match(res.json.message, /In Mealie angelegt/);
});

test('Link hinzufügen: ohne brauchbare Adresse eine klare Absage', async () => {
  const res = await api('/api/recipes/add', { method: 'POST', body: { url: 'kein-link' } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /http/);
});

// ── Menüplan aus Mealie holen ─────────────────────────────────────────────────

// Wochentage der laufenden Woche (Montag zuerst), wie sie der Server rechnet.
function weekDatesOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });
}

const week = weekDatesOf(todayIso);

test('was in Mealie geplant wurde, gilt auch bei uns', async () => {
  // Frau plant Montag in Mealie – bei uns steht dort etwas anderes.
  const [montag] = week;
  const auberginen = (await api('/api/recipes')).json.find(
    (r) => r.source_slug === 'auberginen-auflauf'
  );
  const anderes = (await api('/api/recipes')).json.find(
    (r) => r.id !== auberginen.id && /^mealie:/.test(r.external_id || '') && !r.source_missing
  );
  await api(`/api/plan/${montag}`, { method: 'PUT', body: { recipe_id: anderes.id } });

  mealplans.length = 0;
  mealplans.push({
    id: ++mealplanId,
    date: montag,
    entryType: 'dinner',
    title: '',
    recipeId: auberginen.external_id.replace('mealie:', ''),
  });

  const res = await api('/api/plan/mealie', { method: 'POST', body: { week: 'current' } });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.pulled >= 1, JSON.stringify(res.json));

  const day = res.json.plan.days.find((d) => d.date === montag);
  assert.equal(day.recipe.id, auberginen.id, 'Mealie gewinnt');
  assert.equal(day.note, 'aus Mealie');
});

test('in Mealie gelöschte Tage verschwinden auch hier – selbst gewürfelte bleiben', async () => {
  const [montag, dienstag] = week;
  // Dienstag würfeln wir selbst; Mealie kennt ihn nicht.
  await api('/api/plan/roll', { method: 'POST', body: { date: dienstag } });
  const eigenes = (await api('/api/plan?week=current')).json.days.find(
    (d) => d.date === dienstag
  ).recipe;
  assert.ok(eigenes, 'für Dienstag sollte etwas gewürfelt sein');

  // Frau streicht den Montag in Mealie.
  mealplans.length = 0;

  const res = await api('/api/plan/mealie', { method: 'POST', body: { week: 'current' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.cleared, 1);

  const days = res.json.plan.days;
  assert.equal(days.find((d) => d.date === montag).recipe, null, 'aus Mealie gelöscht');
  assert.equal(
    days.find((d) => d.date === dienstag).recipe?.id,
    eigenes.id,
    'selbst gewürfelt bleibt stehen'
  );
  // … und wandert im selben Lauf nach Mealie.
  assert.ok(mealplans.some((e) => e.date === dienstag && e.entryType === 'dinner'));
});

test('gekochte Tage rührt der Abgleich nicht an', async () => {
  const [, dienstag] = week;
  await api(`/api/plan/${dienstag}/rate`, { method: 'POST', body: { rating: 'lecker' } });
  const gekocht = (await api('/api/plan?week=current')).json.days.find(
    (d) => d.date === dienstag
  );
  assert.equal(gekocht.status, 'cooked');

  // Mealie hätte an dem Tag gern etwas anderes – zu spät, ist schon gegessen.
  mealplans.length = 0;
  mealplans.push({
    id: ++mealplanId,
    date: dienstag,
    entryType: 'dinner',
    recipeId: '11111111-1111-1111-1111-111111111111',
  });

  const res = await api('/api/plan/mealie', { method: 'POST', body: { week: 'current' } });
  const day = res.json.plan.days.find((d) => d.date === dienstag);
  assert.equal(day.recipe.id, gekocht.recipe.id, 'gekochter Tag bleibt');
  assert.equal(day.status, 'cooked');
});

test('ein in Mealie geplantes, hier noch unbekanntes Rezept wird nachgeladen', async () => {
  const [, , mittwoch] = week;
  recipes.set('ganz-neu', {
    id: 'neu-1',
    slug: 'ganz-neu',
    name: 'Frisch in Mealie angelegt',
    updatedAt: '2026-08-08T12:00:00',
    recipeInstructions: [{ text: 'Kochen.' }],
    recipeIngredient: [
      { quantity: 1, unit: null, food: { name: 'Neugier' }, note: '', display: '1 Neugier' },
    ],
  });
  mealplans.length = 0;
  mealplans.push({
    id: ++mealplanId,
    date: mittwoch,
    entryType: 'dinner',
    recipeId: 'neu-1',
    recipe: { slug: 'ganz-neu', name: 'Frisch in Mealie angelegt' },
  });

  const res = await api('/api/plan/mealie', { method: 'POST', body: { week: 'current' } });
  const day = res.json.plan.days.find((d) => d.date === mittwoch);
  assert.equal(day.recipe.name, 'Frisch in Mealie angelegt');
  // Ohne den Nachzug stünde das Rezept erst nach dem nächsten vollen Abgleich da.
  const list = (await api('/api/recipes')).json;
  assert.ok(list.some((r) => r.source_slug === 'ganz-neu'));
});

// ── Teilen-Menü (Android) ─────────────────────────────────────────────────────

test('den Link findet die Teilen-Route auch mitten im Text', async () => {
  const { urlFromShare } = await import('../server.js');
  assert.equal(
    urlFromShare({ url: 'https://www.chefkoch.de/rezepte/1/A.html' }),
    'https://www.chefkoch.de/rezepte/1/A.html'
  );
  // Android-Apps packen die Adresse oft in einen Satz.
  assert.equal(
    urlFromShare({ text: 'Schau mal: https://www.chefkoch.de/rezepte/2/B.html' }),
    'https://www.chefkoch.de/rezepte/2/B.html'
  );
  // Satzzeichen am Ende gehören nicht zur Adresse.
  assert.equal(
    urlFromShare({ text: 'Lecker (https://example.org/rezept).' }),
    'https://example.org/rezept'
  );
  assert.equal(urlFromShare({ title: 'nur ein Titel' }), '');
  assert.equal(urlFromShare({}), '');
});

test('geteilter Link landet im Bestand und die Seite sagt es', async () => {
  const res = await fetch(
    `${base}/share?text=${encodeURIComponent('Kochen: https://www.chefkoch.de/rezepte/777777/Geteilt.html')}`
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /html/);
  const html = await res.text();
  assert.match(html, /Gespeichert/);
  assert.match(html, /Chefkoch-Rezept 777777/);
  assert.match(html, /In Mealie ansehen/);

  const list = (await api('/api/recipes')).json;
  assert.ok(list.some((r) => r.source_slug === 'chefkoch-777777'));
});

test('zweimal geteilt heißt nicht zweimal gespeichert', async () => {
  const res = await fetch(
    `${base}/share?url=${encodeURIComponent('https://www.chefkoch.de/rezepte/777777/Nochmal.html')}`
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Kennen wir schon/);
});

test('ohne Adresse im Geteilten kommt ein Hinweis, kein Absturz', async () => {
  const res = await fetch(`${base}/share?title=${encodeURIComponent('Nur Text')}`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Kein Link dabei/);
});

test('FHEM kann den Menüplan-Abgleich anstoßen und bekommt die Readings zurück', async () => {
  const [montag] = week;
  const auberginen = (await api('/api/recipes')).json.find(
    (r) => r.source_slug === 'auberginen-auflauf'
  );
  mealplans.length = 0;
  mealplans.push({
    id: ++mealplanId,
    date: montag,
    entryType: 'dinner',
    recipeId: auberginen.external_id.replace('mealie:', ''),
  });

  // GET, damit HTTPMOD es als set-URL benutzen kann.
  const res = await api('/api/fhem/sync');
  assert.equal(res.status, 200, res.text);
  // Antwort ist derselbe flache Satz Readings wie bei /api/fhem/plan.
  assert.equal(res.json.week, (await api('/api/fhem/plan')).json.week);
  assert.ok('today' in res.json && 'mon' in res.json);

  const plan = await api('/api/plan?week=current');
  assert.equal(
    plan.json.days.find((d) => d.date === montag).recipe.id,
    auberginen.id,
    'der Abgleich hat Mealies Eintrag übernommen'
  );
});
