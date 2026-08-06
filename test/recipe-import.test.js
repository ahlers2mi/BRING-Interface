import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectJsonLdNodes,
  extractChefkochCandidatesFromApi,
  filterChefkochByRating,
  readChefkochRating,
  decodeEntities,
  extractChefkochIdsFromApi,
  extractChefkochIdsFromHtml,
  formatMinutes,
  mapChefkochApiRecipe,
  parseIsoDuration,
  parseRecipeFromHtml,
  stripHtml,
} from '../lib/recipe-import.js';

const CHEFKOCH_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"Chefkoch"},
  {"@type":"Recipe","name":"Zucchini-Auflauf mit Feta",
   "description":"Schnell &amp; g&uuml;nstig",
   "url":"https://www.chefkoch.de/rezepte/1234567890/Zucchini-Auflauf.html",
   "image":[{"@type":"ImageObject","url":"https://img.example/bild.jpg"}],
   "recipeYield":"4",
   "prepTime":"PT20M","cookTime":"PT40M",
   "keywords":"Auflauf, Vegetarisch",
   "recipeCategory":"Hauptgericht",
   "recipeIngredient":["2 Zucchini","200 g Feta","1 Zwiebel","Salz und Pfeffer"],
   "recipeInstructions":[
     {"@type":"HowToStep","text":"Zucchini <b>waschen</b> und schneiden."},
     {"@type":"HowToStep","text":"Alles in eine Form geben."}]}
]}
</script></head><body>
<a href="/rezepte/1234567890/Zucchini-Auflauf.html">Rezept</a>
<a href="/rezepte/987654321/Chili.html">Chili</a>
<a href="/rezepte/1234567890/Zucchini-Auflauf.html">nochmal</a>
</body></html>`;

test('parseIsoDuration und formatMinutes', () => {
  assert.equal(parseIsoDuration('PT30M'), 30);
  assert.equal(parseIsoDuration('PT1H30M'), 90);
  assert.equal(parseIsoDuration('P1DT2H'), 24 * 60 + 120);
  assert.equal(parseIsoDuration('quatsch'), null);
  assert.equal(formatMinutes(30), 'ca. 30 Min.');
  assert.equal(formatMinutes(90), 'ca. 1 Std. 30 Min.');
  assert.equal(formatMinutes(120), 'ca. 2 Std.');
  assert.equal(formatMinutes(0), '');
});

test('stripHtml und decodeEntities räumen HTML auf', () => {
  assert.equal(stripHtml('<p>Hallo<br>Welt</p>'), 'Hallo\nWelt');
  assert.equal(decodeEntities('Gem&uuml;se &amp; Obst'), 'Gemüse & Obst');
  assert.equal(decodeEntities('&#8364;'), '€');
});

test('collectJsonLdNodes findet Knoten auch im @graph', () => {
  const nodes = collectJsonLdNodes(CHEFKOCH_HTML);
  assert.ok(nodes.some((n) => n['@type'] === 'Recipe'));
  assert.ok(nodes.some((n) => n['@type'] === 'WebSite'));
});

test('parseRecipeFromHtml liest ein schema.org-Rezept vollständig', () => {
  const recipe = parseRecipeFromHtml(CHEFKOCH_HTML, 'https://www.chefkoch.de/x');
  assert.equal(recipe.name, 'Zucchini-Auflauf mit Feta');
  assert.equal(recipe.description, 'Schnell & günstig');
  assert.equal(recipe.prep_time, 'ca. 1 Std.'); // 20 + 40 Minuten
  assert.equal(recipe.servings, '4 Portionen');
  assert.equal(recipe.image_url, 'https://img.example/bild.jpg');
  assert.deepEqual(recipe.tags, ['Auflauf', 'Vegetarisch', 'Hauptgericht']);
  assert.deepEqual(recipe.ingredients, [
    { name: 'Zucchini', amount: '2' },
    { name: 'Feta', amount: '200 g' },
    { name: 'Zwiebel', amount: '1' },
    { name: 'Salz und Pfeffer', amount: '' },
  ]);
  assert.equal(
    recipe.instructions,
    '1. Zucchini waschen und schneiden.\n2. Alles in eine Form geben.'
  );
});

test('parseRecipeFromHtml gibt null ohne Rezeptdaten', () => {
  assert.equal(parseRecipeFromHtml('<html><body>nix</body></html>'), null);
  // Kaputtes JSON-LD darf nicht werfen.
  assert.equal(
    parseRecipeFromHtml('<script type="application/ld+json">{kaputt</script>'),
    null
  );
});

test('extractChefkochIdsFromHtml entdoppelt Rezept-IDs', () => {
  assert.deepEqual(extractChefkochIdsFromHtml(CHEFKOCH_HTML), [
    '1234567890',
    '987654321',
  ]);
});

test('extractChefkochIdsFromApi versteht die Suchantwort', () => {
  assert.deepEqual(
    extractChefkochIdsFromApi({
      results: [{ recipe: { id: 'abc123456' } }, { recipe: { id: '999888777' } }],
    }),
    ['abc123456', '999888777']
  );
  assert.deepEqual(extractChefkochIdsFromApi({}), []);
});

test('mapChefkochApiRecipe übernimmt Zutatengruppen und Zeiten', () => {
  const mapped = mapChefkochApiRecipe({
    id: '1234567890',
    title: 'Chili con Carne',
    subtitle: 'Klassiker',
    servings: 4,
    preparationTime: 20,
    cookingTime: 40,
    difficulty: 1,
    instructions: 'Zwiebeln anbraten.\nRest dazu.',
    siteUrl: 'https://www.chefkoch.de/rezepte/1234567890/Chili.html',
    previewImageUrlTemplate: 'https://img.example/<format>/chili.jpg',
    categories: [{ title: 'Hauptgericht' }],
    tags: ['Mexikanisch'],
    ingredientGroups: [
      {
        header: '',
        ingredients: [
          { name: 'Hackfleisch', unit: 'g', amount: 500 },
          { name: 'Zwiebel', unit: '', amount: 2 },
          { name: 'Kidneybohnen', unit: 'Dose', amount: 0.5 },
        ],
      },
    ],
  });

  assert.equal(mapped.name, 'Chili con Carne');
  assert.equal(mapped.prep_time, 'ca. 1 Std.');
  assert.equal(mapped.servings, '4 Portionen');
  assert.equal(mapped.external_id, 'chefkoch:1234567890');
  assert.equal(mapped.image_url, 'https://img.example/crop-360x240/chili.jpg');
  assert.deepEqual(mapped.tags, ['Mexikanisch', 'Hauptgericht', 'einfach']);
  assert.deepEqual(mapped.ingredients, [
    { name: 'Hackfleisch', amount: '500 g' },
    { name: 'Zwiebel', amount: '2' },
    { name: 'Kidneybohnen', amount: '1/2 Dose' },
  ]);
});

test('mapChefkochApiRecipe verträgt unvollständige Antworten', () => {
  assert.equal(mapChefkochApiRecipe(null), null);
  assert.equal(mapChefkochApiRecipe({ id: '1' }), null); // ohne Titel unbrauchbar
  const minimal = mapChefkochApiRecipe({ id: '2', title: 'Nur Titel' });
  assert.equal(minimal.name, 'Nur Titel');
  assert.deepEqual(minimal.ingredients, []);
  assert.equal(minimal.prep_time, '');
});

test('readChefkochRating versteht beide Schreibweisen', () => {
  assert.deepEqual(readChefkochRating({ rating: { rating: 4.6, numVotes: 120 } }), {
    rating: 4.6,
    votes: 120,
  });
  assert.deepEqual(readChefkochRating({ rating: 3.2, numVotes: 5 }), {
    rating: 3.2,
    votes: 5,
  });
  assert.deepEqual(readChefkochRating({}), { rating: null, votes: null });
  assert.deepEqual(readChefkochRating(null), { rating: null, votes: null });
});

test('extractChefkochCandidatesFromApi liefert Bewertungen mit', () => {
  const candidates = extractChefkochCandidatesFromApi({
    results: [
      { recipe: { id: '1', rating: { rating: 4.8, numVotes: 300 } } },
      { recipe: { id: '2' } },
    ],
  });
  assert.deepEqual(candidates, [
    { id: '1', rating: 4.8, votes: 300 },
    { id: '2', rating: null, votes: null },
  ]);
});

test('filterChefkochByRating siebt schlechte und dünn bewertete Rezepte aus', async () => {
  const candidates = [
    { id: 'gut', rating: 4.7, votes: 250 },
    { id: 'mittel', rating: 3.4, votes: 90 },
    { id: 'ausreisser', rating: 5, votes: 1 }, // eine einzige Wertung
  ];
  assert.deepEqual(
    await filterChefkochByRating(candidates, { minRating: 4, minVotes: 20 }),
    ['gut']
  );
  // Ohne Filter bleibt alles drin.
  assert.deepEqual(await filterChefkochByRating(candidates, {}), [
    'gut',
    'mittel',
    'ausreisser',
  ]);
});

test('filterChefkochByRating laedt fehlende Bewertungen nach', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    const id = /\/recipes\/([^/]+)$/.exec(String(url))?.[1];
    asked.push(id);
    const rating = id === 'topf' ? 4.9 : 2.0;
    return new Response(JSON.stringify({ id, rating: { rating, numVotes: 80 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const kept = await filterChefkochByRating(
    [{ id: 'topf', rating: null, votes: null }, { id: 'flop', rating: null, votes: null }],
    { minRating: 4, minVotes: 10, fetchImpl }
  );
  assert.deepEqual(kept, ['topf']);
  assert.deepEqual(asked.sort(), ['flop', 'topf']);
});

test('filterChefkochByRating: Rezepte ohne Bewertung fallen raus (oder bleiben auf Wunsch)', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ rating: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const candidates = [{ id: 'x', rating: null, votes: null }];
  assert.deepEqual(
    await filterChefkochByRating(candidates, { minRating: 4, fetchImpl }),
    []
  );
  assert.deepEqual(
    await filterChefkochByRating(candidates, { minRating: 4, fetchImpl, keepUnrated: true }),
    ['x']
  );
});
