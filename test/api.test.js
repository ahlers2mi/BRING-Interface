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

// Irgendein Tag der laufenden Woche, der nicht heute ist. Nötig, weil einige
// Antworten (Wocheneinkauf, Plan-Ansicht) genau eine Woche zeigen – „morgen"
// liegt an einem Sonntag schon in der nächsten.
async function freierWochentag() {
  const plan = (await api('/api/plan')).json;
  const tag = plan.days.find((d) => d.date !== todayIso);
  return (tag || plan.days[0]).date;
}

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
      servings: '4 Portionen',
      image_url: 'https://example.invalid/zucchini.jpg',
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

test('Plan-Antwort enthält alles, was die Wandtablet-Ansicht braucht', async () => {
  const plan = await api('/api/plan');
  const day = plan.json.days.find((d) => d.recipe);
  assert.ok(day, 'ein Tag mit Rezept');
  // Ohne diese Felder bleibt die Tablet-Seite leer bzw. bilderlos.
  for (const key of [
    'id',
    'name',
    'prep_time',
    'image_url',
    'servings',
    'avg_stars',
    'rating_count',
  ]) {
    assert.ok(key in day.recipe, `Feld ${key} fehlt in der Plan-Antwort`);
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

test('Reste-Treffer bringen Bild, Portionen und Mealie-Felder mit', async () => {
  // Die Karte der Reste-Küche zeichnet dasselbe wie die Rezeptliste; fehlt hier
  // ein Feld, bleibt dort still die Bildkachel oder der Mealie-Knopf weg.
  const res = await api('/api/fridge/search', {
    method: 'POST',
    body: { items: ['Zucchini'] },
  });
  const r = res.json.results.find((x) => x.recipe.name === 'Zucchini-Auflauf')?.recipe;
  assert.ok(r, 'Zucchini-Auflauf nicht gefunden');
  assert.equal(r.image_url, 'https://example.invalid/zucchini.jpg');
  assert.equal(r.servings, '4 Portionen');
  for (const key of ['source', 'source_slug', 'times_cooked', 'incomplete']) {
    assert.ok(key in r, `Feld ${key} fehlt im Treffer`);
  }
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

test('FHEM-Werte bleiben Regex-tauglich und behalten Umlaute', async () => {
  // Rezeptname mit Umlauten und Anführungszeichen – letztere würden die
  // HTTPMOD-Regex "key":"([^"]*)" zerreißen und müssen entschärft sein.
  const created = await api('/api/recipes', {
    method: 'POST',
    body: { name: 'Gefüllte Auberginen "Oma Käthe" à la türkisch' },
  });
  assert.equal(created.status, 201, created.text);
  await api(`/api/plan/${todayIso}`, {
    method: 'PUT',
    body: { recipe_id: created.json.id },
  });

  const res = await realFetch(`${base}/api/fhem/plan?token=${TOKEN}`);
  const raw = await res.text();

  // Genau so liest HTTPMOD den Wert aus dem Rohtext.
  const today = /"today":"([^"]*)"/.exec(raw)?.[1];
  assert.equal(today, "Gefüllte Auberginen 'Oma Käthe' à la türkisch");
  assert.match(raw, /"state":"Heute: Gefüllte Auberginen 'Oma Käthe' à la türkisch"/);

  // Umlaute liegen als UTF-8 in der Antwort (nicht \u-escaped, nicht kaputt).
  assert.ok(res.headers.get('content-type')?.includes('utf-8'));
  assert.ok(raw.includes('Gefüllte'), 'Umlaute unverändert');
  assert.equal(raw.includes('\\u00fc'), false, 'keine \\u-Escapes');

  // Aufräumen, damit die folgenden Tests ihre Erwartungen behalten.
  await api(`/api/plan/${todayIso}`, { method: 'DELETE' });
  await api(`/api/recipes/${created.json.id}`, { method: 'DELETE' });
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

// ── Rezepte von einer beliebigen Koch-Seite ───────────────────────────────────

async function waitForSiteImport() {
  for (let i = 0; i < 100; i += 1) {
    const res = await api('/api/recipes/import/site-status');
    if (res.json.status !== 'running') return res.json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Import wurde nicht fertig');
}

function rezeptSeite(name) {
  return `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe',
    name,
    recipeIngredient: ['200 g Mehl', '2 Eier'],
    recipeInstructions: 'Verruehren und backen.',
    totalTime: 'PT30M',
  })}</script>`;
}

// Nachgebaute Blog-Uebersicht: zwei Rezepte, ein Blogeintrag ohne Rezeptdaten,
// dazu die ueblichen Nebenwege.
function fakeBlogFetch() {
  const uebersicht = `
    <a href="/rezepte/pfannkuchen/">Pfannkuchen</a>
    <a href="/rezepte/waffeln/">Waffeln</a>
    <a href="/rezepte/kein-rezept/">Nur ein Bericht</a>
    <a href="/impressum/">Impressum</a>
    <a href="https://fremde.example/werbung">Werbung</a>`;
  return async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    const seiten = {
      'https://blog.example/rezepte/': uebersicht,
      'https://blog.example/rezepte/pfannkuchen/': rezeptSeite('Pfannkuchen'),
      'https://blog.example/rezepte/waffeln/': rezeptSeite('Waffeln'),
      'https://blog.example/rezepte/kein-rezept/': '<p>Heute war schoenes Wetter.</p>',
    };
    const body = seiten[href];
    if (body === undefined) return new Response('weg', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

test('Probelauf findet Rezepte, legt aber nichts an', async () => {
  globalThis.fetch = fakeBlogFetch();
  try {
    const vorher = (await api('/api/recipes')).json.length;
    const start = await api('/api/recipes/import/site', {
      method: 'POST',
      body: { url: 'https://blog.example/rezepte/', dryRun: true, pages: 1 },
    });
    assert.equal(start.status, 202, start.text);

    const done = await waitForSiteImport();
    assert.equal(done.status, 'done', JSON.stringify(done.log));
    assert.equal(done.dryRun, true);
    assert.deepEqual(done.found.sort(), ['Pfannkuchen', 'Waffeln']);
    assert.equal(done.imported, 0);
    assert.equal((await api('/api/recipes')).json.length, vorher, 'nichts angelegt');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Site-Import legt die gefundenen Rezepte an und ueberspringt Dubletten', async () => {
  globalThis.fetch = fakeBlogFetch();
  try {
    await api('/api/recipes/import/site', {
      method: 'POST',
      body: { url: 'https://blog.example/rezepte/', pages: 1 },
    });
    const done = await waitForSiteImport();
    assert.equal(done.status, 'done', JSON.stringify(done.log));
    assert.equal(done.imported, 2, JSON.stringify(done.log));
    assert.equal(done.failed, 0);

    const liste = (await api('/api/recipes')).json;
    const waffeln = liste.find((r) => r.name === 'Waffeln');
    assert.ok(waffeln, 'Waffeln angelegt');
    assert.equal(waffeln.source, 'web');
    assert.deepEqual(waffeln.ingredients.map((i) => i.name), ['Mehl', 'Eier']);
    assert.ok(!liste.some((r) => r.name === 'Nur ein Bericht'));

    // Zweiter Lauf: alles schon da.
    await api('/api/recipes/import/site', {
      method: 'POST',
      body: { url: 'https://blog.example/rezepte/', pages: 1 },
    });
    const zweiter = await waitForSiteImport();
    assert.equal(zweiter.imported, 0);
    assert.equal(zweiter.skipped, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Seite ohne Rezeptdaten meldet einen verstaendlichen Fehler', async () => {
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    return new Response('<a href="/blog/eintrag/">Eintrag</a>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  try {
    await api('/api/recipes/import/site', {
      method: 'POST',
      body: { url: 'https://leer.example/liste/', pages: 1 },
    });
    const done = await waitForSiteImport();
    assert.equal(done.status, 'error');
    assert.match(done.error, /schema\.org/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('unvollstaendige Adresse wird abgelehnt', async () => {
  const res = await api('/api/recipes/import/site', {
    method: 'POST',
    body: { url: 'blog.example/rezepte' },
  });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /http/);
});

test('mitkopierter Text hinter der Adresse wird abgeschnitten', async () => {
  // Aus dem Feld kam schon eine 900 Zeichen lange "Adresse", weil die ganze
  // Ausgabe der letzten Suche mit eingefuegt wurde -> 404 auf %20-Ketten.
  globalThis.fetch = fakeBlogFetch();
  try {
    const start = await api('/api/recipes/import/site', {
      method: 'POST',
      body: {
        url: 'https://blog.example/rezepte/ hoechstens 20 Rezepte ueber 3 Uebersichtsseiten',
        dryRun: true,
        pages: 1,
      },
    });
    assert.equal(start.status, 202, start.text);
    assert.equal(start.json.url, 'https://blog.example/rezepte/');

    const done = await waitForSiteImport();
    assert.equal(done.status, 'done', JSON.stringify(done.log));
    assert.deepEqual(done.found.sort(), ['Pfannkuchen', 'Waffeln']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Kochvideo ─────────────────────────────────────────────────────────────────

function fakeYoutubeFetch(beschreibung, id = 'smWgIBFuVRU') {
  const player = {
    videoDetails: {
      videoId: id,
      title: 'Gnocchi-Auflauf | Rezept von Emmi',
      author: 'Emmi kocht einfach',
      lengthSeconds: '512',
      shortDescription: beschreibung,
      thumbnail: {
        thumbnails: [
          { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, width: 1280 },
        ],
      },
    },
  };
  const seite = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(
    player
  )};</script></html>`;
  return async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    if (href.includes('youtube.com/watch')) {
      return new Response(seite, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('weg', { status: 404 });
  };
}

test('Rezept aus einem Kochvideo uebernehmen', async () => {
  globalThis.fetch = fakeYoutubeFetch(
    [
      'Zutaten:',
      '500 g Gnocchi',
      '250 g Kirschtomaten',
      '1 Kugel Mozzarella',
      '',
      'Zubereitung:',
      'Alles mischen und in die Form geben.',
      '20 Minuten bei 200 Grad backen.',
      '',
      'Instagram: @emmikochteinfach',
    ].join('\n')
  );
  try {
    const res = await api('/api/recipes/add', {
      method: 'POST',
      body: { url: 'https://youtu.be/smWgIBFuVRU?si=u2Opfb20Jf_uPqVb' },
    });
    assert.equal(res.status, 201, res.text);
    assert.match(res.json.message, /Video/);

    const rezept = (await api('/api/recipes')).json.find((r) => r.name === 'Gnocchi-Auflauf');
    assert.ok(rezept, 'Titel ohne "| Rezept von Emmi"');
    assert.equal(rezept.source, 'youtube');
    assert.equal(rezept.source_url, 'https://www.youtube.com/watch?v=smWgIBFuVRU');
    assert.match(rezept.image_url, /maxresdefault/);
    assert.deepEqual(rezept.ingredients.map((i) => i.name), [
      'Gnocchi',
      'Kirschtomaten',
      'Mozzarella',
    ]);
    assert.match(rezept.instructions, /Alles mischen/);
    assert.doesNotMatch(rezept.instructions, /Instagram/);
    assert.ok(rezept.tags.includes('Video'), `Tags: ${rezept.tags}`);
    // Die Videolaenge (8:32) darf nicht als Kochzeit durchgehen.
    assert.ok(!rezept.prep_time, `prep_time=${rezept.prep_time}`);

    // Zweiter Versuch: dasselbe Video, andere Schreibweise -> Dublette.
    const again = await api('/api/recipes/add', {
      method: 'POST',
      body: { url: 'https://www.youtube.com/watch?v=smWgIBFuVRU' },
    });
    assert.equal(again.json.duplicate, true, again.text);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ein zweites Video ist keine Dublette des ersten', async () => {
  // Vorher wurde die Adresse am "?" abgeschnitten: von "watch?v=..." blieb
  // "https://www.youtube.com/watch" uebrig - und das steckt in jedem
  // Video-Rezept, jedes weitere Video galt also als schon bekannt.
  globalThis.fetch = fakeYoutubeFetch(
    ['300 g Linsen', '1 Zwiebel', '', 'Alles koecheln lassen.'].join('\n'),
    'zweitesVid0'
  );
  try {
    const res = await api('/api/recipes/add', {
      method: 'POST',
      body: { url: 'https://www.youtube.com/watch?v=zweitesVid0' },
    });
    assert.equal(res.status, 201, res.text);
    assert.ok(!res.json.duplicate, 'zweites Video wurde angelegt');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Rezept aus Screenshots (KI-Rueckfall) ─────────────────────────────────────

// Ein 1x1-PNG als Data-URL – Inhalt egal, geprueft wird die Verdrahtung.
const BILD =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('Analyse weist Unfug ab, bevor es die KI kostet', async () => {
  // Nichts dabei.
  const leer = await api('/api/recipes/analyze', { method: 'POST', body: {} });
  assert.equal(leer.status, 400);
  assert.match(leer.json.error, /Rezepttext|Bild/);

  // Zu viele Bilder.
  const zuviel = await api('/api/recipes/analyze', {
    method: 'POST',
    body: { images: [BILD, BILD, BILD, BILD, BILD] },
  });
  assert.equal(zuviel.status, 400);
  assert.match(zuviel.json.error, /4 Bilder/);

  // Keine Data-URL, sondern eine Adresse – die wuerde das Modell nicht laden.
  const falsch = await api('/api/recipes/analyze', {
    method: 'POST',
    body: { images: ['https://example.org/rezept.png'] },
  });
  assert.equal(falsch.status, 400);
  assert.match(falsch.json.error, /Data-URL/);
});

test('Analyse aus Screenshots: Bilder gehen als Blöcke an die KI', async () => {
  const alterKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let gesendet = null;

  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    if (!href.includes('openrouter.ai')) return new Response('weg', { status: 404 });
    gesendet = JSON.parse(opts.body);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                name: 'Omas Kartoffelsuppe',
                description: 'Vom Foto abgelesen.',
                instructions: '1. Gemüse würfeln.\n2. Köcheln lassen.',
                prep_time: 'ca. 40 Min.',
                ingredients: [
                  { name: 'Kartoffeln', amount: '750 g' },
                  { name: 'Möhren', amount: '2' },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    // Ohne `save`: Ergebnis geht nur zurueck, damit die Oberflaeche das
    // Formular fuellen kann.
    const res = await api('/api/recipes/analyze', {
      method: 'POST',
      body: { images: [BILD, BILD], text: 'für 6 Personen' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.name, 'Omas Kartoffelsuppe');
    assert.equal(res.json.ingredients.length, 2);

    // Die Anfrage muss beide Bilder als eigene Blöcke enthalten – und den
    // Hinweis, dass sie zusammengehoeren.
    const blocks = gesendet.messages.at(-1).content;
    assert.ok(Array.isArray(blocks), 'Content-Blöcke statt eines Strings');
    assert.equal(blocks.filter((b) => b.type === 'image_url').length, 2);
    assert.match(blocks[0].text, /2 Bilder zeigen EIN Rezept/);
    assert.match(blocks[0].text, /für 6 Personen/, 'Zusatztext wandert mit');

    // Mit `save`: es landet in der Sammlung (Mealie ist im Test aus).
    const gespeichert = await api('/api/recipes/analyze', {
      method: 'POST',
      body: { images: [BILD], save: true },
    });
    assert.equal(gespeichert.status, 201, gespeichert.text);
    assert.equal(gespeichert.json.target, 'lokal');
    assert.equal(gespeichert.json.recipe.source, 'bild');
    assert.equal(gespeichert.json.recipe.name, 'Omas Kartoffelsuppe');
    assert.match(gespeichert.json.recipe.instructions, /Gemüse würfeln/);
    // Ein einzelnes Bild bekommt den anderen Hinweis.
    assert.match(gesendet.messages.at(-1).content[0].text, /Das Bild zeigt ein Rezept/);
  } finally {
    globalThis.fetch = realFetch;
    if (alterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = alterKey;
  }
});

test('Analyse meldet verstaendlich, wenn im Bild kein Rezept steht', async () => {
  const alterKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ name: '', ingredients: [] }) } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    const res = await api('/api/recipes/analyze', { method: 'POST', body: { images: [BILD] } });
    assert.equal(res.status, 422, res.text);
    assert.match(res.json.error, /kein Rezept zu lesen/);
  } finally {
    globalThis.fetch = realFetch;
    if (alterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = alterKey;
  }
});

test('Rezept aus einem Instagram-Reel uebernehmen', async () => {
  // Der Fall aus der Praxis: Mealies Scraper liest nur die Meta-Daten, und
  // Instagram kuerzt die mitten im Satz ("... Zutaten fuer 4 Portionen 150").
  // Genau dort faengt die Liste an - deshalb kam vorher ein Rezept ohne
  // Zutaten heraus. Die Einbettungs-Seite hat den vollen Text.
  const caption = [
    'Cremiges Bircher Müsli über Nacht – in 15 Minuten vorbereitet! 🥣🍎 Du suchst ein gesundes Frühstück?',
    '',
    'Zutaten für 4 Portionen',
    '150 g Haferflocken',
    '400 g Joghurt',
    '1 Apfel',
    '50 g Nüsse',
    '',
    'Zubereitung',
    'Apfel reiben und alles verrühren.',
    'Über Nacht kühl stellen.',
    '',
    '#frühstück #mealprep',
  ].join('\n');

  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    if (!href.includes('/embed/captioned/')) return new Response('weg', { status: 404 });
    return new Response(
      `<html><head>
         <meta property="og:image" content="https://scontent.example/bircher.jpg" />
       </head><body><script>window.__additionalDataLoaded('extra',
         {"owner":{"username":"familienkost"},"edge_media_to_caption":{"edges":[{"node":{"text":${JSON.stringify(
           caption
         )}}}]}});</script></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } }
    );
  };
  try {
    const res = await api('/api/recipes/add', {
      method: 'POST',
      body: { url: 'https://www.instagram.com/reel/DcFt7BnDY4U/?igsh=abc' },
    });
    assert.equal(res.status, 201, res.text);
    assert.match(res.json.message, /Instagram/);

    const rezept = (await api('/api/recipes')).json.find(
      (r) => r.name === 'Cremiges Bircher Müsli über Nacht'
    );
    assert.ok(rezept, 'Name aus dem Aufhaenger, ohne Emoji und Untertitel');
    assert.equal(rezept.source, 'instagram');
    assert.equal(rezept.source_url, 'https://www.instagram.com/reel/DcFt7BnDY4U/');
    assert.equal(rezept.servings, '4 Portionen');
    assert.match(rezept.image_url, /bircher\.jpg/);
    assert.deepEqual(rezept.ingredients.map((i) => i.name), [
      'Haferflocken',
      'Joghurt',
      'Apfel',
      'Nüsse',
    ]);
    assert.match(rezept.instructions, /Apfel reiben/);
    assert.doesNotMatch(rezept.instructions, /frühstück|mealprep/);
    assert.ok(rezept.tags.includes('Instagram'), `Tags: ${rezept.tags}`);
    assert.ok(rezept.tags.includes('familienkost'));

    // Derselbe Beitrag als /p/-Adresse ist keine zweite Sache.
    const again = await api('/api/recipes/add', {
      method: 'POST',
      body: { url: 'https://www.instagram.com/p/DcFt7BnDY4U/' },
    });
    assert.equal(again.json.duplicate, true, again.text);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Anreichern fuellt Luecken, ohne Bewertungen anzufassen', async () => {
  // Rezept wie von Hand angelegt: Name und Videoadresse, sonst nichts.
  const angelegt = await api('/api/recipes', {
    method: 'POST',
    body: {
      name: 'Neapolitanische Pizza',
      source_url: 'https://youtu.be/PizzaBiga01',
      ingredients: [{ name: 'Mehl', amount: '1 kg' }],
    },
  });
  const id = angelegt.json.id;
  // Bewertung dran, damit wir sehen: die bleibt.
  await api(`/api/recipes/${id}/rate`, { method: 'POST', body: { rating: 'lecker' } });

  globalThis.fetch = fakeYoutubeFetch(
    [
      '1000 g Mehl Typo1',
      '650 ml Wasser',
      '25 g Salz',
      '2 g Hefe',
      '',
      'Biga 18 Stunden reifen lassen.',
    ].join('\n'),
    'PizzaBiga01'
  );
  try {
    const res = await api(`/api/recipes/${id}/enrich`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.outcome, 'enriched');
    assert.match(res.json.message, /Video/);

    const rezept = res.json.recipe;
    assert.equal(rezept.name, 'Neapolitanische Pizza', 'Name bleibt – daran haengt alles');
    assert.equal(rezept.ingredients.length, 4, 'mehr Zutaten als vorher');
    assert.match(rezept.instructions, /Biga 18 Stunden/);
    assert.match(rezept.image_url, /maxresdefault/);
    assert.equal(rezept.rating_count, 1, 'Bewertung unberuehrt');
    assert.equal(rezept.rejected_count, 0, 'nichts als "rausgeflogen" gebucht');

    // Zweiter Lauf ohne overwrite: es steht schon alles da.
    const nochmal = await api(`/api/recipes/${id}/enrich`, { method: 'POST', body: {} });
    assert.equal(nochmal.json.outcome, 'not-needed', nochmal.text);
    assert.equal(nochmal.json.recipe.ingredients.length, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Sammellauf ergaenzt duenne Rezepte aus verschiedenen Quellen', async () => {
  // Vorher konnte der Sammellauf nur Chefkoch. Hier sind es drei duenne
  // Rezepte mit drei verschiedenen Quellen – alle drei muessen ergaenzt werden.
  const duenn = [];
  for (const [name, url] of [
    ['Duenn per Video', 'https://youtu.be/sammelVid01'],
    ['Duenn per Instagram', 'https://www.instagram.com/reel/sammelInsta/'],
    ['Duenn per Blog', 'https://sammel.example/rezept/'],
  ]) {
    const res = await api('/api/recipes', {
      method: 'POST',
      body: { name, source_url: url, ingredients: [{ name: 'Mehl' }] },
    });
    assert.equal(res.status, 201, res.text);
    duenn.push(res.json.id);
  }
  // Ein viertes ohne Quelle darf der Lauf nicht anfassen.
  const ohneQuelle = (
    await api('/api/recipes', {
      method: 'POST',
      body: { name: 'Duenn ohne Quelle', ingredients: [{ name: 'Mehl' }] },
    })
  ).json;

  const zutaten = ['500 g Nudeln', '200 g Sahne', '1 Zwiebel', '2 EL Öl'];
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    if (href.includes('youtube.com/watch')) {
      return new Response(
        `<html><script>var ytInitialPlayerResponse = ${JSON.stringify({
          videoDetails: {
            videoId: 'sammelVid01',
            title: 'Nudeln aus dem Video',
            author: 'Kanal',
            lengthSeconds: '300',
            shortDescription: `${zutaten.join('\n')}\n\nAlles zusammen kochen.`,
          },
        })};</script></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
    if (href.includes('/embed/captioned/')) {
      return new Response(
        `<html><body><script>window.__additionalDataLoaded('extra',
           {"edge_media_to_caption":{"edges":[{"node":{"text":${JSON.stringify(
             `${zutaten.join('\n')}\n\nAlles zusammen kochen.`
           )}}}]}});</script></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
    if (href.includes('sammel.example')) {
      return new Response(
        `<script type="application/ld+json">${JSON.stringify({
          '@type': 'Recipe',
          name: 'Nudeln von der Seite',
          recipeIngredient: zutaten,
          recipeInstructions: 'Alles zusammen kochen.',
        })}</script>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
    return new Response('weg', { status: 404 });
  };

  try {
    const res = await api('/api/recipes/enrich/thin', { method: 'POST', body: { limit: 100 } });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.json.enriched >= 3, JSON.stringify(res.json));

    const liste = (await api('/api/recipes')).json;
    for (const id of duenn) {
      const r = liste.find((x) => x.id === id);
      assert.equal(r.ingredients.length, 4, `${r.name}: ${JSON.stringify(r.ingredients)}`);
      assert.match(r.instructions, /Alles zusammen kochen/, r.name);
      // Der Name bleibt in jedem Fall – daran haengen Plan und Bewertungen.
      assert.match(r.name, /^Duenn per /);
    }
    // Ohne Quelladresse bleibt es unangetastet.
    const unberuehrt = liste.find((x) => x.id === ohneQuelle.id);
    assert.equal(unberuehrt.ingredients.length, 1);
    assert.ok(!unberuehrt.instructions);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Sammellauf ist gedeckelt und sagt, was offen bleibt', async () => {
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, opts);
    return new Response('weg', { status: 404 }); // jede Quelle scheitert
  };
  try {
    // Zwei duenne Rezepte anlegen, aber nur eines pro Lauf zulassen.
    for (const name of ['Deckel A', 'Deckel B']) {
      await api('/api/recipes', {
        method: 'POST',
        body: { name, source_url: 'https://deckel.example/x/', ingredients: [{ name: 'Mehl' }] },
      });
    }
    const res = await api('/api/recipes/enrich/thin', { method: 'POST', body: { limit: 1 } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.checked, 1, 'nur eines angefasst');
    assert.ok(res.json.thin >= 2, JSON.stringify(res.json));
    assert.ok(res.json.remaining >= 1, 'der Rest wird gemeldet');
    assert.match(res.json.message, /noch offen/);
    // Eine gescheiterte Quelle ist kein Absturz, sondern eine Zeile im Bericht.
    assert.equal(res.json.failed, 1);
    assert.equal(res.json.errors.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Anreichern braucht eine Quelladresse', async () => {
  const angelegt = await api('/api/recipes', {
    method: 'POST',
    body: { name: 'Nur ein Zettel', ingredients: [{ name: 'Mehl' }] },
  });
  const res = await api(`/api/recipes/${angelegt.json.id}/enrich`, {
    method: 'POST',
    body: {},
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Quelladresse/);

  const weg = await api('/api/recipes/999999/enrich', { method: 'POST', body: {} });
  assert.equal(weg.status, 404);
});

test('Video ohne Zutatenliste gibt den Text zum Weiterarbeiten zurueck', async () => {
  globalThis.fetch = fakeYoutubeFetch(
    'Heute wird gekocht! Zutaten stehen im Video.',
    'ohneListe00'
  );
  try {
    const res = await api('/api/recipes/add', {
      method: 'POST',
      body: { url: 'https://youtu.be/ohneListe00' },
    });
    assert.equal(res.status, 422, res.text);
    assert.match(res.json.error, /keine erkennbare Zutatenliste/);
    assert.match(res.json.text, /Heute wird gekocht/, 'Text fuer die KI-Analyse dabei');
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

test('Status nennt Version und Stand – daran erkennt man den laufenden Build', async () => {
  const res = await api('/api/status');
  assert.match(res.json.version, /^\d+\.\d+\.\d+$/);
  // Zeitstempel der server.js im Image: sagt, wann der Code hineingekommen ist.
  assert.match(res.json.builtAt, /^\d{4}-\d{2}-\d{2}T/);
});

// ── Aufwand, Portionen, Verschieben ───────────────────────────────────────────

test('werktags bevorzugt der Würfel kurze Rezepte, am Wochenende die langen', async () => {
  const { effortFactor } = await import('../lib/mealplan.js');
  const schnell = { prep_time: '25 Min.' };
  const lang = { prep_time: '2 Stunden' };
  const dienstag = '2026-08-11';
  const samstag = '2026-08-15';

  assert.equal(effortFactor(schnell, dienstag), 1);
  assert.ok(effortFactor(lang, dienstag) < 0.5, 'werktags wird lang abgewertet');
  assert.ok(
    effortFactor(lang, samstag) > effortFactor(lang, dienstag),
    'am Wochenende darf es dauern'
  );
  // Ohne Zeitangabe wird nicht bestraft.
  assert.equal(effortFactor({ prep_time: '' }, dienstag), 1);
});

test('Haushaltsgröße lässt sich speichern und wird geprüft', async () => {
  const gesetzt = await api('/api/preferences', {
    method: 'PUT',
    body: { householdServings: 2.5 },
  });
  assert.equal(gesetzt.json.householdServings, 2.5);
  assert.equal((await api('/api/preferences')).json.householdServings, 2.5);

  const unsinn = await api('/api/preferences', {
    method: 'PUT',
    body: { householdServings: 99 },
  });
  assert.equal(unsinn.status, 400);
});

test('Würfel-Vorgaben: Zeitgrenze und Wetter', async () => {
  // Zwei Rezepte, die sich in der Zeit klar unterscheiden.
  const schnell = (
    await api('/api/recipes', {
      method: 'POST',
      body: {
        name: 'Schnelle Pfanne',
        prep_time: '15 Min.',
        ingredients: [{ name: 'Gemuese', amount: '300 g' }],
      },
    })
  ).json;
  const lang = (
    await api('/api/recipes', {
      method: 'POST',
      body: {
        name: 'Langer Schmorbraten',
        prep_time: '3 Stunden',
        ingredients: [{ name: 'Rindfleisch', amount: '1 kg' }],
      },
    })
  ).json;

  // Alles andere sperren, damit nur diese zwei in Frage kommen.
  const alle = (await api('/api/recipes')).json;
  const fremde = alle.filter((r) => r.id !== schnell.id && r.id !== lang.id);
  for (const r of fremde) {
    await api(`/api/recipes/${r.id}/block`, { method: 'POST', body: { blocked: true } });
  }

  try {
    const tag = await freierWochentag();
    // Mit Grenze 30 Min. darf der Schmorbraten nicht kommen – mehrfach würfeln,
    // damit es kein Zufallstreffer ist.
    for (let i = 0; i < 6; i += 1) {
      const res = await api('/api/plan/roll', {
        method: 'POST',
        body: { date: tag, maxMinutes: 30 },
      });
      assert.equal(res.status, 200, res.text);
      const gewuerfelt = res.json.plan.days.find((d) => d.date === tag).recipe;
      assert.equal(gewuerfelt.name, 'Schnelle Pfanne', 'Zeitgrenze wurde missachtet');
    }

    // Die Begründung nennt die Vorgabe, damit man sie im Plan wiederfindet.
    const mitGrund = await api('/api/plan/roll', {
      method: 'POST',
      body: { date: tag, maxMinutes: 30, weather: 'kalt' },
    });
    const notiz = mitGrund.json.plan.days.find((d) => d.date === tag).note || '';
    assert.match(notiz, /30 Min/);
    assert.match(notiz, /kalt/);

    // Unsinnige Vorgaben werden abgewiesen.
    assert.equal(
      (await api('/api/plan/roll', { method: 'POST', body: { date: tag, maxMinutes: 2 } })).status,
      400
    );
    assert.equal(
      (await api('/api/plan/roll', { method: 'POST', body: { date: tag, weather: 'nebel' } }))
        .status,
      400
    );
  } finally {
    for (const r of fremde) {
      await api(`/api/recipes/${r.id}/block`, { method: 'POST', body: { blocked: false } });
    }
    await api(`/api/recipes/${schnell.id}`, { method: 'DELETE' });
    await api(`/api/recipes/${lang.id}`, { method: 'DELETE' });
  }
});

test('Würfel-Schwellen lassen sich speichern und werden geprüft', async () => {
  const gesetzt = await api('/api/preferences', {
    method: 'PUT',
    body: { quickMinutes: 25, coldC: 8, warmC: 26 },
  });
  assert.equal(gesetzt.status, 200, gesetzt.text);
  assert.equal(gesetzt.json.quickMinutes, 25);
  assert.equal(gesetzt.json.coldC, 8);
  assert.equal(gesetzt.json.warmC, 26);
  assert.equal((await api('/api/preferences')).json.quickMinutes, 25);

  // Kalt muss unter warm liegen - auch wenn nur EINE der beiden gesetzt wird.
  const verdreht = await api('/api/preferences', { method: 'PUT', body: { coldC: 30 } });
  assert.equal(verdreht.status, 400);
  assert.match(verdreht.json.error, /Kalt-Schwelle/);

  assert.equal(
    (await api('/api/preferences', { method: 'PUT', body: { quickMinutes: 999 } })).status,
    400
  );

  // Leer speichern setzt auf den Wert aus der Umgebung zurueck.
  const zurueck = await api('/api/preferences', {
    method: 'PUT',
    body: { quickMinutes: '', coldC: '', warmC: '' },
  });
  assert.equal(zurueck.status, 200, zurueck.text);
  assert.equal(zurueck.json.quickMinutes, 40, 'Standard aus der Umgebung');
  assert.equal(zurueck.json.coldC, 10);
  assert.equal(zurueck.json.warmC, 24);
});

test('der Wocheneinkauf rechnet die Mengen auf die Haushaltsgröße um', async () => {
  const recipe = (
    await api('/api/recipes', {
      method: 'POST',
      body: {
        name: 'Rechenauflauf',
        servings: '4 Portionen',
        prep_time: '30 Min.',
        ingredients: [{ name: 'Kartoffeln', amount: '600 g' }],
      },
    })
  ).json;

  // Bewusst ein Tag DIESER Woche: der Wocheneinkauf sieht nur die laufende
  // Woche, und an einem Sonntag läge "morgen" schon in der nächsten.
  const tag = await freierWochentag();
  await api(`/api/plan/${tag}`, { method: 'PUT', body: { recipe_id: recipe.id } });

  const liste = await api('/api/plan/shopping?all=1');
  const kartoffeln = liste.json.items.find((i) => /Kartoffeln/i.test(i.name));
  assert.ok(kartoffeln, 'Kartoffeln erwartet');
  // 600 g für 4 Portionen -> 2,5 Portionen -> 380 g (auf Zehner gerundet)
  assert.match(kartoffeln.amount, /380 g/);
});

test('ein Tag lässt sich verschieben statt neu zu würfeln', async () => {
  // Beide Tage in derselben Woche – die Antwort zeigt nur eine Woche, und am
  // Sonntag wäre das Ziel sonst in der nächsten.
  const plan0 = (await api('/api/plan')).json;
  const von = plan0.days[0].date;
  const nach = plan0.days[1].date;
  const recipe = (await api('/api/recipes')).json[0];

  await api(`/api/plan/${von}`, { method: 'PUT', body: { recipe_id: recipe.id } });
  await api(`/api/plan/${nach}`, { method: 'DELETE' });

  const res = await api(`/api/plan/${von}/move`, { method: 'POST', body: { to: nach } });
  assert.equal(res.status, 200, res.text);

  const plan = res.json.plan;
  assert.equal(plan.days.find((d) => d.date === von).recipe, null, 'Quelle ist leer');
  assert.equal(plan.days.find((d) => d.date === nach).recipe.id, recipe.id);
});

test('ein Reste-Tag wird nicht überwürfelt', async () => {
  const morgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const markiert = await api(`/api/plan/${morgen}/status`, {
    method: 'POST',
    body: { status: 'leftovers' },
  });
  assert.equal(markiert.status, 200, markiert.text);
  assert.equal(markiert.json.plan.days.find((d) => d.date === morgen).status, 'leftovers');

  const vorher = markiert.json.plan.days.find((d) => d.date === morgen).recipe?.id ?? null;
  const gewuerfelt = await api('/api/plan/roll', { method: 'POST', body: { date: morgen } });
  const nachher = gewuerfelt.json.plan.days.find((d) => d.date === morgen);
  assert.equal(nachher.status, 'leftovers', 'der Status bleibt');
  assert.equal(nachher.recipe?.id ?? null, vorher, 'und das Gericht auch');
});

test('ein Dip wird nicht als Abendessen gewürfelt', async () => {
  const dip = (
    await api('/api/recipes', {
      method: 'POST',
      body: {
        name: 'Kräuterdip',
        tags: ['Dip'],
        ingredients: [{ name: 'Schmand', amount: '200 g' }],
      },
    })
  ).json;
  assert.equal(dip.course, 'side', dip.course_reason);

  // Alles andere sperren – bliebe der Dip würfelbar, käme jetzt genau er.
  const alle = (await api('/api/recipes')).json;
  for (const r of alle) {
    if (r.id !== dip.id) {
      await api(`/api/recipes/${r.id}/block`, { method: 'POST', body: { blocked: true } });
    }
  }
  // Tag vorher leeren und auf "geplant" stellen: ein gekochter oder als Reste
  // markierter Tag wird uebersprungen, dann meldet der Wuerfel gar keinen
  // Fehler und der Test prueft ins Leere.
  const tag = await freierWochentag();
  await api(`/api/plan/${tag}`, { method: 'DELETE' });
  const gewuerfelt = await api('/api/plan/roll', { method: 'POST', body: { date: tag } });
  assert.equal(gewuerfelt.status, 200, gewuerfelt.text);
  assert.match(gewuerfelt.json.results[0].error || '', /kein/i, 'kein Rezept übrig');

  // Von Hand zum Abendessen erklärt, darf er dann doch.
  const umgestellt = await api(`/api/recipes/${dip.id}/course`, {
    method: 'POST',
    body: { course: 'main' },
  });
  assert.equal(umgestellt.json.course, 'main');
  const nochmal = await api('/api/plan/roll', { method: 'POST', body: { date: tag } });
  assert.equal(nochmal.json.plan.days.find((d) => d.date === tag).recipe.name, 'Kräuterdip');

  // Aufräumen für die folgenden Tests.
  await api(`/api/recipes/${dip.id}`, { method: 'DELETE' });
  for (const r of alle) {
    if (r.id !== dip.id) {
      await api(`/api/recipes/${r.id}/block`, { method: 'POST', body: { blocked: false } });
    }
  }
});

// ── Verschieben mit Rückfrage und "schon eingekauft" ──────────────────────────

test('Verschieben: shift rueckt alles auf, replace laesst den Zieltag fallen', async () => {
  const plan0 = (await api('/api/plan')).json;
  const [a, b, c] = plan0.days.map((d) => d.date);
  const rezepte = (await api('/api/recipes')).json.filter((r) => !r.blocked).slice(0, 3);
  assert.ok(rezepte.length >= 3, 'drei Rezepte fuer den Test');

  const setzen = async (datum, r) =>
    api(`/api/plan/${datum}`, { method: 'PUT', body: { recipe_id: r.id } });
  for (const [i, datum] of [a, b, c].entries()) await setzen(datum, rezepte[i]);

  // shift: a -> b, dabei rueckt b auf c und c auf den Tag danach.
  const geschoben = await api(`/api/plan/${a}/move`, {
    method: 'POST',
    body: { to: b, mode: 'shift' },
  });
  assert.equal(geschoben.status, 200, geschoben.text);
  assert.ok(
    geschoben.json.verschoben.length >= 2,
    `mindestens die beiden Folgetage ruecken auf, waren: ${geschoben.json.verschoben.length}`
  );
  let plan = (await api('/api/plan')).json;
  const am = (datum) => plan.days.find((d) => d.date === datum)?.recipe?.name ?? null;
  assert.equal(am(a), null, 'Quelle ist leer');
  assert.equal(am(b), rezepte[0].name);
  assert.equal(am(c), rezepte[1].name, 'das alte b steht jetzt auf c');

  // replace: der Zieltag verliert sein Gericht.
  const ersetzt = await api(`/api/plan/${b}/move`, {
    method: 'POST',
    body: { to: c, mode: 'replace' },
  });
  assert.equal(ersetzt.json.verdraengt.name, rezepte[1].name);
  plan = (await api('/api/plan')).json;
  assert.equal(plan.days.find((d) => d.date === c).recipe.name, rezepte[0].name);

  // swap: tauschen statt verdraengen.
  await setzen(b, rezepte[2]);
  await api(`/api/plan/${b}/move`, { method: 'POST', body: { to: c, mode: 'swap' } });
  plan = (await api('/api/plan')).json;
  assert.equal(plan.days.find((d) => d.date === b).recipe.name, rezepte[0].name);
  assert.equal(plan.days.find((d) => d.date === c).recipe.name, rezepte[2].name);

  assert.equal(
    (await api(`/api/plan/${b}/move`, { method: 'POST', body: { to: c, mode: 'quatsch' } }))
      .status,
    400
  );
});

test('eingekaufte Tage ueberlebt der Wochenwurf', async () => {
  const plan0 = (await api('/api/plan')).json;
  const tag = plan0.days.find((d) => d.date !== todayIso && d.status !== 'cooked').date;
  const rezept = (await api('/api/recipes')).json.find((r) => !r.blocked);
  await api(`/api/plan/${tag}`, { method: 'PUT', body: { recipe_id: rezept.id } });

  const markiert = await api(`/api/plan/${tag}/shopped`, {
    method: 'POST',
    body: { shopped: true },
  });
  assert.equal(markiert.status, 200, markiert.text);
  assert.equal(markiert.json.plan.days.find((d) => d.date === tag).shopped, true);

  // Ganze Woche wuerfeln laesst den Tag in Ruhe ...
  await api('/api/plan/roll', { method: 'POST', body: { week: 'current' } });
  let plan = (await api('/api/plan')).json;
  assert.equal(plan.days.find((d) => d.date === tag).recipe.id, rezept.id);

  // ... ein ausdruecklicher Wurf fuer genau diesen Tag aber schon.
  await api('/api/plan/roll', { method: 'POST', body: { date: tag } });
  plan = (await api('/api/plan')).json;
  const danach = plan.days.find((d) => d.date === tag);
  assert.notEqual(danach.recipe.id, rezept.id, 'derselbe Tag bekommt etwas anderes');
  assert.equal(danach.shopped, false, 'anderes Gericht -> Einkauf gilt nicht mehr');

  // Zuruecknehmen geht auch.
  await api(`/api/plan/${tag}`, { method: 'PUT', body: { recipe_id: rezept.id } });
  await api(`/api/plan/${tag}/shopped`, { method: 'POST', body: { shopped: true } });
  const zurueck = await api(`/api/plan/${tag}/shopped`, {
    method: 'POST',
    body: { shopped: false },
  });
  assert.equal(zurueck.json.plan.days.find((d) => d.date === tag).shopped, false);
});

test('die Einkauf-Markierung wandert beim Verschieben mit', async () => {
  const plan0 = (await api('/api/plan')).json;
  const frei = plan0.days.filter((d) => d.status !== 'cooked').map((d) => d.date);
  const [a, b] = [frei[0], frei[1]];
  const rezept = (await api('/api/recipes')).json.find((r) => !r.blocked);

  await api(`/api/plan/${a}`, { method: 'PUT', body: { recipe_id: rezept.id } });
  await api(`/api/plan/${a}/shopped`, { method: 'POST', body: { shopped: true } });
  await api(`/api/plan/${b}`, { method: 'DELETE' });

  const res = await api(`/api/plan/${a}/move`, { method: 'POST', body: { to: b } });
  assert.equal(res.status, 200, res.text);
  const ziel = res.json.plan.days.find((d) => d.date === b);
  assert.equal(ziel.recipe.id, rezept.id);
  assert.equal(ziel.shopped, true, 'eingekauft bleibt eingekauft');
});

test('die FHEM-Antwort beginnt bei heute und blickt nur nach vorn', async () => {
  const res = await api('/api/fhem/plan');
  assert.equal(res.status, 200, res.text);
  const p = res.json;

  assert.equal(p.from, todayIso, 'das Fenster beginnt heute');
  const in6 = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  assert.equal(p.to, in6, 'und endet sechs Tage spaeter');

  // Jeder Wochentag traegt ein Datum, und keines liegt in der Vergangenheit.
  // Die Nutzdaten benutzen englische Schluessel; erst HTTPMOD macht daraus
  // die Readings mo..so.
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const daten = keys.map((k) => p[`${k}_datum`]);
  assert.equal(new Set(daten).size, 7, 'sieben verschiedene Tage');
  for (const d of daten) assert.ok(d >= todayIso, `${d} liegt in der Vergangenheit`);

  // tag1 ist heute, die Reihenfolge stimmt.
  assert.equal(p[`${p.tag1_key}_datum`], todayIso);
  assert.equal(p.today, p[p.tag1_key], 'heute steht doppelt drin, aber gleich');

  // Der eigentliche Anlass: an einem SONNTAG liegt morgen in der naechsten
  // Woche. Vorher wurde "morgen" nur in der laufenden Woche gesucht und blieb
  // deshalb sonntags leer - samt der Abend-Erinnerung, die daran haengt.
  const morgenIso = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.equal(p[`${p.tag2_key}_datum`], morgenIso, 'tag2 ist immer morgen');
  assert.equal(
    p.tomorrow,
    p[p.tag2_key],
    'das Reading "morgen" passt zum zweiten Tag des Fensters'
  );
});

test('unbekannte Status werden abgelehnt', async () => {
  const heute = new Date().toISOString().slice(0, 10);
  const res = await api(`/api/plan/${heute}/status`, {
    method: 'POST',
    body: { status: 'irgendwas' },
  });
  assert.equal(res.status, 400);
});

// ── Wetter und Vorlauf ────────────────────────────────────────────────────────

test('das Wetter kommt von FHEM und wird für heute und morgen benutzt', async () => {
  const { climateBias, weatherFactor, dishTemperament } = await import('../lib/climate.js');

  // Gemessen: gilt nur für heute/morgen und nur, solange der Wert frisch ist.
  const jetzt = '2026-04-15T18:00:00.000Z';
  const frisch = { temp: 4, measuredAt: '2026-04-15T17:30:00.000Z', now: jetzt };
  assert.equal(climateBias('2026-04-15', frisch), 'kalt');
  assert.equal(climateBias('2026-04-16', frisch), 'kalt');
  // Übermorgen sagt ein Messwert nichts – und April ist weder noch.
  assert.equal(climateBias('2026-04-17', frisch), null);
  // Alter Messwert zählt nicht.
  assert.equal(
    climateBias('2026-04-15', { temp: 4, measuredAt: '2026-04-14T06:00:00.000Z', now: jetzt }),
    null
  );
  // Ohne Messwert entscheidet der Monat des geplanten Tages.
  assert.equal(climateBias('2027-01-20'), 'kalt');
  assert.equal(climateBias('2026-07-20'), 'warm');

  assert.equal(dishTemperament({ name: 'Kürbissuppe', tags: [] }), 'winter');
  assert.equal(dishTemperament({ name: 'Nudelsalat', tags: [] }), 'sommer');
  assert.equal(dishTemperament({ name: 'Spaghetti', tags: [] }), null);

  assert.ok(weatherFactor({ name: 'Kürbissuppe' }, 'kalt') > 1);
  assert.ok(weatherFactor({ name: 'Kürbissuppe' }, 'warm') < 1);
  assert.equal(weatherFactor({ name: 'Spaghetti' }, 'kalt'), 1, 'neutrale Gerichte bleiben');
  assert.equal(weatherFactor({ name: 'Kürbissuppe' }, null), 1, 'ohne Wetter keine Wichtung');
});

test('FHEM meldet die Temperatur, unplausible Werte werden abgelehnt', async () => {
  const ok = await api('/api/fhem/weather?temp=3.5');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.temp, 3.5);
  assert.equal(ok.json.bias, 'kalt');

  // Komma statt Punkt kommt aus FHEM durchaus vor.
  assert.equal((await api('/api/fhem/weather?temp=26,5')).json.bias, 'warm');
  assert.equal((await api('/api/fhem/weather?temp=abc')).status, 400);
  assert.equal((await api('/api/fhem/weather?temp=999')).status, 400);
});

test('Vorlauf steht am Rezept und in den FHEM-Readings', async () => {
  const heute = new Date().toISOString().slice(0, 10);
  const recipe = (
    await api('/api/recipes', {
      method: 'POST',
      body: {
        name: 'Gulasch aus der Truhe',
        instructions: 'Das Fleisch am Vortag auftauen lassen. Dann schmoren.',
        ingredients: [{ name: 'Rindfleisch', amount: '500 g' }],
      },
    })
  ).json;
  assert.match(recipe.prep_hint, /auftauen/);

  await api(`/api/plan/${heute}`, { method: 'PUT', body: { recipe_id: recipe.id } });
  const fhem = await api('/api/fhem/plan');
  assert.match(fhem.json.today_prep, /auftauen/);

  // Ein Rezept ohne Vorlauf bekommt auch keinen Hinweis.
  const ohne = (
    await api('/api/recipes', {
      method: 'POST',
      body: { name: 'Butterbrot', instructions: 'Brot streichen.', ingredients: [] },
    })
  ).json;
  assert.equal(ohne.prep_hint, '');
});

test('die FHEM-Readings tragen absolute Bild-Adressen samt Token', async () => {
  const heute = new Date().toISOString().slice(0, 10);
  const recipe = (
    await api('/api/recipes', {
      method: 'POST',
      body: {
        name: 'Bildrezept',
        image_url: '/api/mealie/image/abc',
        ingredients: [{ name: 'Zutat' }],
      },
    })
  ).json;
  await api(`/api/plan/${heute}`, { method: 'PUT', body: { recipe_id: recipe.id } });

  // Über den Helfer, nicht über globalThis.fetch – das ist in dieser Datei
  // für die Import-Tests umgebogen.
  const payload = (await api(`/api/fhem/plan?token=${TOKEN}`)).json;
  // Relativ gespeichert, absolut ausgeliefert – FHEMVIZ läuft unter einer
  // anderen Adresse und käme mit einem Pfad nicht weiter.
  assert.match(payload.today_img, /^http:\/\/127\.0\.0\.1:\d+\/api\/mealie\/image\/abc\?token=/);
  const tagKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  assert.ok(tagKeys.every((k) => `${k}_img` in payload), 'je Tag ein Bild-Reading');
});

test('absolute Bild-Adressen (Cookidoo) bleiben unverändert', async () => {
  const heute = new Date().toISOString().slice(0, 10);
  const recipe = (
    await api('/api/recipes', {
      method: 'POST',
      body: {
        name: 'Thermomix-Rezept',
        image_url: 'https://assets.tmecosys.com/bild.jpg',
        ingredients: [{ name: 'Zutat' }],
      },
    })
  ).json;
  await api(`/api/plan/${heute}`, { method: 'PUT', body: { recipe_id: recipe.id } });

  const payload = (await api(`/api/fhem/plan?token=${TOKEN}`)).json;
  assert.equal(payload.today_img, 'https://assets.tmecosys.com/bild.jpg');
});
