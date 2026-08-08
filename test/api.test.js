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

  const morgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await api(`/api/plan/${morgen}`, { method: 'PUT', body: { recipe_id: recipe.id } });

  const liste = await api('/api/plan/shopping?all=1');
  const kartoffeln = liste.json.items.find((i) => /Kartoffeln/i.test(i.name));
  assert.ok(kartoffeln, 'Kartoffeln erwartet');
  // 600 g für 4 Portionen -> 2,5 Portionen -> 380 g (auf Zehner gerundet)
  assert.match(kartoffeln.amount, /380 g/);
});

test('ein Tag lässt sich verschieben statt neu zu würfeln', async () => {
  const heute = new Date().toISOString().slice(0, 10);
  const morgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const recipe = (await api('/api/recipes')).json[0];

  await api(`/api/plan/${heute}`, { method: 'PUT', body: { recipe_id: recipe.id } });
  await api(`/api/plan/${morgen}`, { method: 'DELETE' });

  const res = await api(`/api/plan/${heute}/move`, { method: 'POST', body: { to: morgen } });
  assert.equal(res.status, 200, res.text);

  const plan = res.json.plan;
  assert.equal(plan.days.find((d) => d.date === heute).recipe, null, 'Quelle ist leer');
  assert.equal(plan.days.find((d) => d.date === morgen).recipe.id, recipe.id);
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
