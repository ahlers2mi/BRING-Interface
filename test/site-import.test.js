// Rezepte von einer beliebigen Koch-Seite einsammeln.
//
// Die echten Seiten sind hier nicht erreichbar; geprüft wird deshalb gegen
// nachgebaute Übersichtsseiten im üblichen WordPress-Zuschnitt und eine
// klassische PHP-Liste.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absolutize,
  collectLinks,
  discoverCandidates,
  looksLikeCandidate,
  looksLikeSingleRecipe,
  nextPageUrl,
  sameHost,
  verifyRecipeUrls,
} from '../lib/site-import.js';

const BASE = 'https://blog.example/rezepte/hauptgerichte/';

const listing = `
  <html><head><link rel="next" href="/rezepte/hauptgerichte/page/2/" /></head>
  <body>
    <a href="/rezepte/nudelauflauf/">Nudelauflauf</a>
    <a href="https://blog.example/rezepte/linsensuppe/">Linsensuppe</a>
    <a href="rezepte/kartoffelsalat/">Kartoffelsalat (relativ)</a>
    <a href="/rezepte/hauptgerichte/">Diese Seite</a>
    <a href="/kategorie/vegetarisch/">Kategorie</a>
    <a href="/impressum/">Impressum</a>
    <a href="/wp-json/wp/v2/posts">API</a>
    <a href="/bilder/foto.jpg">Foto</a>
    <a href="https://instagram.com/blog">Instagram</a>
    <a href="mailto:hallo@blog.example">Mail</a>
    <a href="#inhalt">Sprungmarke</a>
  </body></html>`;

test('Links werden absolut gemacht und Fremdes fällt raus', () => {
  assert.equal(absolutize('/a/', BASE), 'https://blog.example/a/');
  assert.equal(absolutize('mailto:x@y.de', BASE), null);
  assert.equal(absolutize('#weiter', BASE), null);
  assert.equal(absolutize('', BASE), null);
  // Anker werden abgeschnitten, sonst zählt dieselbe Seite mehrfach.
  assert.equal(absolutize('/a/#zutaten', BASE), 'https://blog.example/a/');
});

test('sameHost ignoriert www.', () => {
  assert.ok(sameHost('https://www.blog.example/a', 'https://blog.example/b'));
  assert.ok(!sameHost('https://andere.example/a', 'https://blog.example/b'));
});

test('nur plausible Rezept-Links bleiben übrig', () => {
  const links = collectLinks(listing, BASE).filter((u) => looksLikeCandidate(u, BASE));
  assert.deepEqual(links.sort(), [
    'https://blog.example/rezepte/hauptgerichte/rezepte/kartoffelsalat/',
    'https://blog.example/rezepte/linsensuppe/',
    'https://blog.example/rezepte/nudelauflauf/',
  ]);
});

test('die Übersichtsseite selbst zählt nicht als Rezept', () => {
  assert.ok(!looksLikeCandidate(BASE, BASE));
  assert.ok(!looksLikeCandidate('https://blog.example/rezepte/hauptgerichte/page/2/', BASE));
});

test('nächste Seite: rel=next, WordPress und PHP-Zähler', () => {
  assert.equal(
    nextPageUrl(listing, BASE),
    'https://blog.example/rezepte/hauptgerichte/page/2/'
  );

  const wp = '<a href="/rezepte/hauptgerichte/page/3/">weiter</a>';
  assert.equal(
    nextPageUrl(wp, 'https://blog.example/rezepte/hauptgerichte/page/2/'),
    'https://blog.example/rezepte/hauptgerichte/page/3/'
  );

  const php = '<a href="rezepte.php?seite=2">weiter</a>';
  assert.equal(
    nextPageUrl(php, 'https://kost.example/rezepte.php?seite=1'),
    'https://kost.example/rezepte.php?seite=2'
  );

  // Steht die nächste Seite nirgends auf der Seite, ist Schluss.
  assert.equal(nextPageUrl('<p>Ende</p>', 'https://blog.example/liste/page/9/'), null);
});

// ── Zusammenspiel mit gefälschtem Netz ────────────────────────────────────────

function recipePage(name) {
  return `<html><head><script type="application/ld+json">
    ${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name,
      recipeIngredient: ['500 g Nudeln', '1 Zwiebel'],
      recipeInstructions: 'Kochen.',
      recipeYield: '4 Portionen',
      totalTime: 'PT35M',
    })}
  </script></head><body>…</body></html>`;
}

function fakeFetch(pages) {
  return async (url) => {
    const body = pages[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
}

test('Übersicht über mehrere Seiten einsammeln', async () => {
  const seite2 = `
    <a href="/rezepte/ofengemuese/">Ofengemüse</a>
    <a href="/rezepte/hauptgerichte/page/3/">weiter</a>`;
  const fetchImpl = fakeFetch({
    [BASE]: listing,
    'https://blog.example/rezepte/hauptgerichte/page/2/': seite2,
  });

  const found = await discoverCandidates({
    url: BASE,
    maxPages: 2,
    fetchImpl,
    delayMs: 0,
  });
  assert.ok(found.includes('https://blog.example/rezepte/nudelauflauf/'));
  assert.ok(found.includes('https://blog.example/rezepte/ofengemuese/'), 'Seite 2 mitgelesen');
});

test('maxPages wird eingehalten', async () => {
  const holt = [];
  const fetchImpl = async (url) => {
    holt.push(url);
    return { ok: true, status: 200, text: async () => listing };
  };
  await discoverCandidates({ url: BASE, maxPages: 1, fetchImpl, delayMs: 0 });
  assert.equal(holt.length, 1, 'nur die erste Übersichtsseite');
});

test('nur Adressen mit echten Rezeptdaten bleiben übrig', async () => {
  const fetchImpl = fakeFetch({
    'https://blog.example/rezepte/nudelauflauf/': recipePage('Nudelauflauf'),
    'https://blog.example/rezepte/linsensuppe/': '<html><body>Nur ein Blogeintrag</body></html>',
  });
  const hits = await verifyRecipeUrls(
    [
      'https://blog.example/rezepte/nudelauflauf/',
      'https://blog.example/rezepte/linsensuppe/',
      'https://blog.example/rezepte/gibtsnicht/',
    ],
    { fetchImpl, delayMs: 0 }
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].recipe.name, 'Nudelauflauf');
  assert.equal(hits[0].recipe.ingredients.length, 2);
  assert.equal(hits[0].recipe.servings, '4 Portionen');
});

test('die Obergrenze bricht das Prüfen ab', async () => {
  const geholt = [];
  const fetchImpl = async (url) => {
    geholt.push(url);
    return { ok: true, status: 200, text: async () => recipePage(`Rezept ${geholt.length}`) };
  };
  const urls = Array.from({ length: 10 }, (_, i) => `https://blog.example/r/${i}/`);
  const hits = await verifyRecipeUrls(urls, { fetchImpl, delayMs: 0, limit: 3 });
  assert.equal(hits.length, 3);
  assert.equal(geholt.length, 3, 'nach dem Treffer-Limit wird nichts mehr geholt');
});

// ── Übersichtsseiten, die sich als Rezept ausgeben ────────────────────────────
//
// familienkost.de hängt schema.org-Rezeptdaten auch an seine Kategorieseiten.
// Der Probelauf hat dort 20 "Rezepte" gefunden, die alle Übersichten waren
// ("Hauptgerichte - die besten Rezepte für die Familie").

test('Kategorieseiten als einzelne Datei fallen aus den Kandidaten', () => {
  const basis = 'https://kost.example/kategorie-fleischgerichte.html';
  for (const pfad of [
    '/kategorie-fleischgerichte.html',
    '/category-dinner.html',
    '/tag-schnell.html',
    '/rezepte.php',
  ]) {
    assert.ok(
      !looksLikeCandidate(`https://kost.example${pfad}`, basis),
      `${pfad} sollte nicht als Rezept gelten`
    );
  }
  // Ein echtes Rezept derselben Seite bleibt drin.
  assert.ok(looksLikeCandidate('https://kost.example/frikadellen.html', basis));
});

test('ohne Zutaten ist es kein einzelnes Rezept', () => {
  assert.ok(!looksLikeSingleRecipe({ name: 'Hauptgerichte', ingredients: [] }));
  assert.ok(!looksLikeSingleRecipe({ name: 'Salat Rezepte' }));
  assert.ok(!looksLikeSingleRecipe({ name: 'Fast nichts', ingredients: [{ name: 'Mehl' }] }));
  assert.ok(
    looksLikeSingleRecipe({ name: 'Frikadellen', ingredients: [{ name: 'Hack' }, { name: 'Ei' }] })
  );
  // Chefkoch-PLUS-Anrisse zählen nicht als Zutaten (Marker aus normalize.js).
  assert.ok(
    !looksLikeSingleRecipe({
      name: 'Angerissen',
      ingredients: [
        { name: '500 g Mehl' },
        { name: '-- additional ingredients not fully disclosed --' },
      ],
    }),
    'eine echte Zutat plus Anriss-Platzhalter reicht nicht'
  );
});

test('die Prüfung wirft Übersichtsseiten weg und meldet das', async () => {
  const uebersicht = `<script type="application/ld+json">
    {"@type":"Recipe","name":"Hauptgerichte - die besten Rezepte"}</script>`;
  const echtes = `<script type="application/ld+json">
    {"@type":"Recipe","name":"Frikadellen","recipeIngredient":["500 g Hack","1 Ei"]}</script>`;
  const meldungen = [];
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => (String(url).includes('frikadellen') ? echtes : uebersicht),
  });

  const hits = await verifyRecipeUrls(
    ['https://kost.example/uebersicht.html', 'https://kost.example/frikadellen.html'],
    { fetchImpl, delayMs: 0, log: (m) => meldungen.push(m) }
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].recipe.name, 'Frikadellen');
  assert.ok(
    meldungen.some((m) => /Übersicht/.test(m)),
    `Hinweis erwartet, bekommen: ${meldungen.join(' | ')}`
  );
});
