// Integrationstest über echte HTTP-Aufrufe gegen die Express-App.
// Die Bring-Routen bleiben außen vor (dafür bräuchte es ein Bring-Konto);
// getestet werden Rezepte, Bewertungen, Wochenplan, Reste-Suche, das
// Geschmacksprofil, der Chefkoch-Import (mit gefälschtem fetch) und der
// Token-Zugang für FHEM.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const TOKEN = 'test-token-123';
const dbFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bring-test-')),
  'test.db'
);
process.env.DB_PATH = dbFile;
process.env.PORT = '0';
process.env.APP_PASSWORD = 'geheim';
process.env.API_TOKEN = TOKEN;
process.env.IMPORT_DELAY_MS = '0';
process.env.IMPORT_CONCURRENCY = '2';

const realFetch = globalThis.fetch;
const { app } = await import('../server.js');
const server = app.listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

async function api(pathname, { method = 'GET', body, token = TOKEN } = {}) {
  const res = await realFetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-API-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* z. B. Login-HTML */
  }
  return { status: res.status, json, text };
}

const todayIso = new Date().toISOString().slice(0, 10);

// ── Zugang ────────────────────────────────────────────────────────────────────

test('API-Routen sind ohne Token gesperrt, mit Token offen', async () => {
  const ohne = await api('/api/recipes', { token: null });
  assert.equal(ohne.status, 401);

  const falsch = await api('/api/recipes', { token: 'falsch' });
  assert.equal(falsch.status, 401);

  const mit = await api('/api/recipes');
  assert.equal(mit.status, 200);

  // Query-Parameter funktioniert ebenfalls (das benutzt FHEM/HTTPMOD).
  const perQuery = await realFetch(`${base}/api/status?token=${TOKEN}`);
  assert.equal(perQuery.status, 200);
  const status = await perQuery.json();
  assert.equal(status.authEnabled, true);
  assert.equal(status.apiTokenEnabled, true);
});

// ── Rezepte ───────────────────────────────────────────────────────────────────

const created = {};

test('Rezepte anlegen und mit Zutaten laden', async () => {
  const recipes = [
    {
      name: 'Zucchini-Auflauf',
      tags: ['Vegetarisch', 'Auflauf'],
      prep_time: 'ca. 45 Min.',
      ingredients: [
        { name: 'Zucchini', amount: '2' },
        { name: 'Feta', amount: '200 g' },
        { name: 'Salz', amount: '1 TL' },
      ],
    },
    {
      name: 'Chili con Carne',
      tags: ['Mexikanisch'],
      ingredients: [
        { name: 'Hackfleisch', amount: '500 g' },
        { name: 'Kidneybohnen', amount: '1 Dose' },
        { name: 'Zwiebeln', amount: '2' },
      ],
    },
    {
      name: 'Rosenkohl-Pfanne',
      ingredients: [
        { name: 'Rosenkohl', amount: '600 g' },
        { name: 'Speck', amount: '100 g' },
      ],
    },
  ];
  const responses = [];
  for (const recipe of recipes) {
    const res = await api('/api/recipes', { method: 'POST', body: recipe });
    created[recipe.name] = res.json?.id;
    responses.push([recipe, res]);
  }
  for (const [recipe, res] of responses) {
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.json.tags, recipe.tags || []);
  }

  const list = await api('/api/recipes');
  assert.equal(list.json.length, 3);
  const auflauf = list.json.find((r) => r.name === 'Zucchini-Auflauf');
  assert.equal(auflauf.ingredients.length, 3, 'Zutaten kommen mit der Liste');
  assert.equal(auflauf.rating_count, 0);
  assert.equal(auflauf.blocked, false);
});

// ── Wochenplan & Würfeln ──────────────────────────────────────────────────────

test('ganze Woche würfeln füllt alle sieben Tage', async () => {
  const res = await api('/api/plan/roll', {
    method: 'POST',
    body: { week: 'current' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.plan.days.length, 7);
  assert.equal(res.json.plan.planned, 7, 'jeder Tag hat ein Rezept');
  for (const day of res.json.plan.days) {
    assert.ok(day.recipe?.name, `${day.date} ohne Rezept`);
    assert.ok(day.note, 'Begründung des Würfels wird gespeichert');
  }
});

test('einzelnen Tag würfeln und Tag manuell setzen', async () => {
  const before = await api('/api/plan');
  const day = before.json.days[0];

  const rolled = await api('/api/plan/roll', {
    method: 'POST',
    body: { date: day.date },
  });
  assert.equal(rolled.status, 200, rolled.text);

  const manual = await api(`/api/plan/${day.date}`, {
    method: 'PUT',
    body: { recipe_id: created['Chili con Carne'], note: 'Wunsch' },
  });
  assert.equal(manual.status, 200, manual.text);
  assert.equal(manual.json.entry.recipe_id, created['Chili con Carne']);
  assert.equal(manual.json.plan.days[0].recipe.name, 'Chili con Carne');

  const cleared = await api(`/api/plan/${day.date}`, { method: 'DELETE' });
  assert.equal(cleared.json.plan.days[0].recipe, null);
  assert.equal(cleared.json.plan.days[0].status, 'empty');

  // Nur leere Tage füllen lässt belegte Tage in Ruhe.
  const second = await api('/api/plan');
  const filledName = second.json.days[1].recipe.name;
  const refill = await api('/api/plan/roll', {
    method: 'POST',
    body: { week: 'current', onlyEmpty: true },
  });
  assert.equal(refill.json.plan.days[1].recipe.name, filledName);
  assert.ok(refill.json.plan.days[0].recipe, 'leerer Tag wurde gefüllt');
});

test('ungültige Woche und ungültiges Datum werden abgewiesen', async () => {
  assert.equal((await api('/api/plan?week=2026-W99')).status, 400);
  assert.equal((await api('/api/plan/2026-02-31', { method: 'DELETE' })).status, 400);
});

// ── Bewertungen ───────────────────────────────────────────────────────────────

test('Tag bewerten setzt Status gekocht und rechnet Sterne', async () => {
  await api(`/api/plan/${todayIso}`, {
    method: 'PUT',
    body: { recipe_id: created['Zucchini-Auflauf'] },
  });
  const rated = await api(`/api/plan/${todayIso}/rate`, {
    method: 'POST',
    body: { rating: 'lecker', comment: 'wieder machen' },
  });
  assert.equal(rated.status, 200, rated.text);

  const today = rated.json.plan.days.find((d) => d.date === todayIso);
  assert.equal(today.status, 'cooked');
  assert.equal(today.rating.stars, 5);
  assert.equal(today.recipe.avg_stars, 5);

  const recipe = await api(`/api/recipes/${created['Zucchini-Auflauf']}`);
  assert.equal(recipe.json.rating_count, 1);
  assert.equal(recipe.json.times_cooked, 1);
  assert.equal(recipe.json.last_cooked, todayIso);
});

test('rausgeflogen und nie_wieder wirken unterschiedlich', async () => {
  const id = created['Rosenkohl-Pfanne'];
  const rausgeflogen = await api(`/api/recipes/${id}/rate`, {
    method: 'POST',
    body: { rating: 'rausgeflogen' },
  });
  assert.equal(rausgeflogen.status, 200);
  assert.equal(rausgeflogen.json.rejected_count, 1);
  assert.equal(rausgeflogen.json.blocked, false, 'bleibt vorschlagbar');

  const nieWieder = await api(`/api/recipes/${id}/rate`, {
    method: 'POST',
    body: { rating: 'nie_wieder' },
  });
  assert.equal(nieWieder.json.blocked, true, 'wird gesperrt');

  // Gesperrte Rezepte kommen beim Würfeln nicht mehr vor.
  for (let i = 0; i < 12; i += 1) {
    const res = await api('/api/plan/roll', {
      method: 'POST',
      body: { week: 'current' },
    });
    for (const day of res.json.plan.days) {
      if (day.status === 'cooked') continue;
      assert.notEqual(day.recipe.id, id, 'gesperrtes Rezept gewürfelt');
    }
  }

  const entsperrt = await api(`/api/recipes/${id}/block`, {
    method: 'POST',
    body: { blocked: false },
  });
  assert.equal(entsperrt.json.blocked, false);
});

test('unbekannte Bewertungen werden abgelehnt', async () => {
  const res = await api(`/api/recipes/${created['Chili con Carne']}/rate`, {
    method: 'POST',
    body: { rating: 'grandios' },
  });
  assert.equal(res.status, 400);
});

test('gekochte Tage werden beim Würfeln nicht überschrieben', async () => {
  const plan = await api('/api/plan');
  const cooked = plan.json.days.find((d) => d.status === 'cooked');
  assert.ok(cooked, 'Testaufbau: ein gekochter Tag');
  await api('/api/plan/roll', { method: 'POST', body: { week: 'current' } });
  const after = await api('/api/plan');
  const sameDay = after.json.days.find((d) => d.date === cooked.date);
  assert.equal(sameDay.recipe.id, cooked.recipe.id);
  assert.equal(sameDay.status, 'cooked');
});

// ── Reste-Küche ───────────────────────────────────────────────────────────────

test('Reste-Suche findet passende Rezepte und listet Fehlendes', async () => {
  const res = await api('/api/fridge/search', {
    method: 'POST',
    body: { items: ['Zucchini', 'Zwiebel'] },
  });
  assert.equal(res.status, 200, res.text);
  const names = res.json.results.map((r) => r.recipe.name);
  assert.ok(names.includes('Zucchini-Auflauf'), names.join(', '));

  const auflauf = res.json.results.find((r) => r.recipe.name === 'Zucchini-Auflauf');
  assert.deepEqual(
    auflauf.missing.map((m) => m.name),
    ['Feta'],
    'Salz gilt als Vorrat'
  );
  assert.ok(auflauf.coverage > 0.4);

  // Auch als Freitext (eine Zutat pro Zeile) benutzbar.
  const freitext = await api('/api/fridge/search', {
    method: 'POST',
    body: { items: 'Hackfleisch\nZwiebeln' },
  });
  assert.ok(
    freitext.json.results.some((r) => r.recipe.name === 'Chili con Carne'),
    'Chili über Freitext gefunden'
  );

  assert.equal(
    (await api('/api/fridge/search', { method: 'POST', body: { items: [] } })).status,
    400
  );
});

// ── Geschmacksprofil ──────────────────────────────────────────────────────────

test('Geschmacksprofil kennt Favoriten und Kennzahlen', async () => {
  const res = await api('/api/taste');
  assert.equal(res.status, 200);
  assert.equal(res.json.recipe_count, 3);
  assert.equal(res.json.rated_count, 1);
  assert.equal(res.json.favourites[0].name, 'Zucchini-Auflauf');
  assert.equal(res.json.rejected_count, 2);
  assert.ok(res.json.avg_stars >= 4);
});

// ── Wocheneinkauf ─────────────────────────────────────────────────────────────

test('Wocheneinkauf fasst die Zutaten der Woche zusammen', async () => {
  const res = await api('/api/plan/shopping?week=current');
  assert.equal(res.status, 200);
  assert.ok(res.json.items.length > 0);
  const names = res.json.items.map((i) => i.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'keine Dubletten');
});

// ── FHEM-Schnittstelle ────────────────────────────────────────────────────────

test('FHEM-Plan liefert flache Werte für HTTPMOD', async () => {
  const res = await api('/api/fhem/plan');
  assert.equal(res.status, 200);
  const p = res.json;
  for (const key of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    assert.equal(typeof p[key], 'string');
    assert.equal(typeof p[`${key}_status`], 'string');
    assert.equal(typeof p[`${key}_stars`], 'number');
  }
  assert.match(p.week, /^\d{4}-W\d{2}$/);
  assert.equal(typeof p.today, 'string');
  assert.ok(p.state.startsWith('Heute:'));
  // Alle Werte sind flach (HTTPMOD kann keine Objekte lesen).
  for (const value of Object.values(p)) {
    assert.notEqual(typeof value, 'object');
  }
});

test('FHEM kann per GET würfeln und bewerten', async () => {
  const roll = await realFetch(
    `${base}/api/fhem/roll?scope=week&token=${TOKEN}`
  );
  assert.equal(roll.status, 200);

  const today = await realFetch(
    `${base}/api/fhem/roll?scope=day&date=today&token=${TOKEN}`
  );
  assert.equal(today.status, 200);
  const payload = await today.json();
  assert.ok(payload.today, 'heute ist etwas eingeplant');

  const rate = await realFetch(
    `${base}/api/fhem/rate?date=today&rating=gut&token=${TOKEN}`
  );
  assert.equal(rate.status, 200);
  const rated = await rate.json();
  assert.equal(rated.today_stars, 4);
  assert.equal(rated.today_status, 'cooked');

  const bad = await realFetch(`${base}/api/fhem/rate?date=today&rating=xx&token=${TOKEN}`);
  assert.equal(bad.status, 400);
});

// ── Chefkoch-Import (mit gefälschtem Netz) ────────────────────────────────────

function fakeChefkochFetch(calls) {
  return async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts); // eigene Testaufrufe
    calls.push(href);

    if (href.includes('/search-gateway/recipes')) {
      const offset = Number(/offset=(\d+)/.exec(href)?.[1] || 0);
      const results =
        offset === 0
          ? [1, 2, 3, 4].map((n) => ({ recipe: { id: `10000000${n}` } }))
          : [];
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const id = /\/recipes\/(\d+)$/.exec(href)?.[1];
    if (id) {
      if (id === '100000004') return new Response('kaputt', { status: 500 });
      return new Response(
        JSON.stringify({
          id,
          title: `Testrezept ${id}`,
          subtitle: 'aus dem Testnetz',
          servings: 2,
          preparationTime: 15,
          instructions: 'Kochen.',
          siteUrl: `https://www.chefkoch.de/rezepte/${id}/Test.html`,
          categories: [{ title: 'Hauptgericht' }],
          ingredientGroups: [
            { ingredients: [{ name: 'Nudeln', unit: 'g', amount: 250 }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };
}

async function waitForImport() {
  for (let i = 0; i < 100; i += 1) {
    const res = await api('/api/recipes/import/status');
    if (res.json.status !== 'running') return res.json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import wurde nicht fertig');
}

test('Massenimport von Chefkoch legt Rezepte an und überspringt Dubletten', async () => {
  const calls = [];
  globalThis.fetch = fakeChefkochFetch(calls);
  try {
    const start = await api('/api/recipes/import/chefkoch', {
      method: 'POST',
      body: { query: 'nudeln', count: 4 },
    });
    assert.equal(start.status, 202, start.text);
    assert.equal(start.json.status, 'running');

    // Ein zweiter Job parallel wird abgelehnt.
    const parallel = await api('/api/recipes/import/chefkoch', {
      method: 'POST',
      body: { count: 4 },
    });
    assert.equal(parallel.status, 409);

    const done = await waitForImport();
    assert.equal(done.status, 'done', JSON.stringify(done.log));
    assert.equal(done.imported, 3);
    assert.equal(done.failed, 1, 'das kaputte Rezept wird gezählt, nicht geworfen');

    const list = await api('/api/recipes');
    const imported = list.json.find((r) => r.name === 'Testrezept 100000001');
    assert.ok(imported, 'importiertes Rezept ist in der Liste');
    assert.equal(imported.source, 'chefkoch');
    assert.deepEqual(imported.ingredients.map((i) => i.name), ['Nudeln']);
    assert.equal(imported.prep_time, 'ca. 15 Min.');
    assert.equal(imported.external_id, 'chefkoch:100000001');

    // Zweiter Lauf: alles schon da -> nur Übersprungene, keine Detailabrufe.
    const detailCallsBefore = calls.filter((c) => /\/recipes\/\d+$/.test(c)).length;
    await api('/api/recipes/import/chefkoch', {
      method: 'POST',
      body: { query: 'nudeln', count: 4 },
    });
    const second = await waitForImport();
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 3);
    const detailCallsAfter = calls.filter((c) => /\/recipes\/\d+$/.test(c)).length;
    assert.equal(
      detailCallsAfter - detailCallsBefore,
      1,
      'nur das fehlgeschlagene Rezept wird erneut geholt'
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Einzelimport per URL liest schema.org-Daten', async () => {
  const html = `<script type="application/ld+json">
    {"@type":"Recipe","name":"Ofengemüse","recipeIngredient":["3 Karotten","1 Zucchini"],
     "recipeInstructions":"Alles in den Ofen.","totalTime":"PT35M",
     "url":"https://example.org/ofengemuese"}</script>`;
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  try {
    const preview = await api('/api/recipes/import/url', {
      method: 'POST',
      body: { url: 'https://example.org/ofengemuese' },
    });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.json.recipe.name, 'Ofengemüse');
    assert.equal(preview.json.saved, false);
    assert.equal(preview.json.recipe.prep_time, 'ca. 35 Min.');

    const saved = await api('/api/recipes/import/url', {
      method: 'POST',
      body: { url: 'https://example.org/ofengemuese', save: true },
    });
    assert.equal(saved.status, 201, saved.text);
    assert.equal(saved.json.recipe.name, 'Ofengemüse');

    const again = await api('/api/recipes/import/url', {
      method: 'POST',
      body: { url: 'https://example.org/ofengemuese', save: true },
    });
    assert.equal(again.json.duplicate, true, 'zweiter Versuch erkennt die Dublette');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Einzelimport meldet fehlende Rezeptdaten verständlich', async () => {
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    return new Response('<html><body>keine Rezeptdaten</body></html>', { status: 200 });
  };
  try {
    const res = await api('/api/recipes/import/url', {
      method: 'POST',
      body: { url: 'https://example.org/nix' },
    });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /keine strukturierten Rezeptdaten/i);
  } finally {
    globalThis.fetch = realFetch;
  }

  const badUrl = await api('/api/recipes/import/url', {
    method: 'POST',
    body: { url: 'chefkoch.de' },
  });
  assert.equal(badUrl.status, 400);
});
