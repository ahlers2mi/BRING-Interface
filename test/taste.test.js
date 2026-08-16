import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTasteProfile,
  pickWeighted,
  ratingValue,
  recipeWeight,
  tasteFactor,
} from '../lib/taste.js';

const recipe = (id, name, ingredients, tags = []) => ({
  id,
  name,
  ingredients: ingredients.map((n) => ({ name: n })),
  tags,
  rating_count: 0,
  avg_stars: null,
  rejected_count: 0,
  blocked: false,
});

test('ratingValue bildet Sterne auf -1..1 ab', () => {
  assert.deepEqual(ratingValue({ kind: 'cooked', stars: 5 }), { value: 1, weight: 1 });
  assert.deepEqual(ratingValue({ kind: 'cooked', stars: 3 }), { value: 0, weight: 1 });
  assert.deepEqual(ratingValue({ kind: 'cooked', stars: 1 }), { value: -1, weight: 1 });
  assert.equal(ratingValue({ kind: 'cooked', stars: 9 }), null);
  const rejected = ratingValue({ kind: 'rejected' });
  assert.ok(rejected.value < 0 && rejected.weight < 1);
});

test('buildTasteProfile lernt beliebte und unbeliebte Zutaten', () => {
  const recipes = [
    recipe(1, 'Lachs 1', ['Lachs', 'Zitrone'], ['Fisch']),
    recipe(2, 'Lachs 2', ['Lachs', 'Dill'], ['Fisch']),
    recipe(3, 'Rosenkohl 1', ['Rosenkohl', 'Speck']),
    recipe(4, 'Rosenkohl 2', ['Rosenkohl', 'Kartoffel']),
  ];
  const ratings = [
    { recipe_id: 1, kind: 'cooked', stars: 5 },
    { recipe_id: 2, kind: 'cooked', stars: 5 },
    { recipe_id: 3, kind: 'cooked', stars: 1 },
    { recipe_id: 4, kind: 'cooked', stars: 2 },
  ];
  const profile = buildTasteProfile(recipes, ratings);

  const liked = profile.liked.map((e) => e.label.toLowerCase());
  const disliked = profile.disliked.map((e) => e.label.toLowerCase());
  assert.ok(liked.includes('lachs'), `erwartet Lachs in ${liked}`);
  assert.ok(disliked.includes('rosenkohl'), `erwartet Rosenkohl in ${disliked}`);
  // Salz & Co. dürfen nie im Profil landen.
  assert.equal(
    profile.ingredients.some((e) => e.label.toLowerCase() === 'salz'),
    false
  );

  // Ein unbewertetes Lachsrezept profitiert, ein Rosenkohlrezept nicht.
  const neu = recipe(5, 'Lachs neu', ['Lachs', 'Sahne'], ['Fisch']);
  const doof = recipe(6, 'Rosenkohl neu', ['Rosenkohl', 'Sahne']);
  assert.ok(tasteFactor(neu, profile) > 1.1);
  assert.ok(tasteFactor(doof, profile) < 0.9);
});

test('recipeWeight sperrt Blockiertes und dämpft kürzlich Gekochtes', () => {
  const profile = buildTasteProfile([], []);
  const base = { ...recipe(1, 'X', ['Nudeln']), rating_count: 2, avg_stars: 4 };

  assert.equal(recipeWeight({ ...base, blocked: true }, profile), 0);
  assert.equal(
    recipeWeight(base, profile, { excludeIds: new Set([1]) }),
    0,
    'schon in der Woche eingeplant'
  );

  const frisch = recipeWeight(base, profile, { daysSinceCooked: 2 });
  const alt = recipeWeight(base, profile, { daysSinceCooked: 90 });
  assert.ok(frisch < alt / 5, `frisch=${frisch} alt=${alt}`);

  const gut = recipeWeight({ ...base, avg_stars: 5 }, profile, { daysSinceCooked: 90 });
  const schlecht = recipeWeight({ ...base, avg_stars: 1 }, profile, {
    daysSinceCooked: 90,
  });
  assert.ok(gut > schlecht * 5, `gut=${gut} schlecht=${schlecht}`);

  const rausgeflogen = recipeWeight(
    { ...base, rejected_count: 1 },
    profile,
    { daysSinceCooked: 90 }
  );
  assert.ok(rausgeflogen < alt);
});

test('"rausgeflogen" dämpft auch ein nie gekochtes Rezept', () => {
  // `rating_count` zählt nur gekochte Bewertungen. Ein Rezept, das nur
  // weggeklickt wurde, steht dort auf 0 – trotzdem muss es seltener kommen.
  const profile = buildTasteProfile([], []);
  const base = recipe(1, 'Gnocchi-Auflauf', ['Gnocchi', 'Mozzarella']);

  const neu = recipeWeight(base, profile);
  const einmal = recipeWeight({ ...base, rejected_count: 1 }, profile);
  const zweimal = recipeWeight({ ...base, rejected_count: 2 }, profile);

  assert.ok(einmal < neu / 3, `neu=${neu} einmal=${einmal}`);
  assert.ok(zweimal < einmal, `einmal=${einmal} zweimal=${zweimal}`);
  assert.ok(zweimal > 0, 'gesperrt wird nur per blocked');
});

test('zwei aussortierte Rezepte machen noch kein "mögen wir nicht"', () => {
  const recipes = [
    recipe(1, 'Gnocchi-Auflauf', ['Gnocchi', 'Mozzarella']),
    recipe(2, 'Gnocchi-Pfanne', ['Gnocchi', 'Mozzarella']),
    recipe(3, 'Gnocchi-Salat', ['Gnocchi', 'Rucola']),
  ];
  const weg = (id) => ({ recipe_id: id, kind: 'rejected' });

  // Zweimal weggeklickt reicht als Beleg nicht.
  const duenn = buildTasteProfile(recipes, [weg(1), weg(2)]);
  assert.deepEqual(duenn.disliked, []);
  assert.equal(tasteFactor(recipes[0], duenn), 1);

  // Dreimal schon – dann ist es ein Muster.
  const klar = buildTasteProfile(recipes, [weg(1), weg(2), weg(3)]);
  assert.ok(
    klar.disliked.some((e) => e.label.toLowerCase() === 'gnocchi'),
    `erwartet Gnocchi in ${klar.disliked.map((e) => e.label)}`
  );
  assert.ok(tasteFactor(recipes[0], klar) < 1);

  // Zwei gekochte Bewertungen wiegen schwerer als zwei Absagen.
  const gekocht = buildTasteProfile(recipes, [
    { recipe_id: 1, kind: 'cooked', stars: 1 },
    { recipe_id: 2, kind: 'cooked', stars: 1 },
  ]);
  assert.ok(gekocht.disliked.some((e) => e.label.toLowerCase() === 'gnocchi'));
});

test('pickWeighted respektiert die Gewichte', () => {
  const items = ['a', 'b', 'c'];
  assert.equal(pickWeighted(items, [0, 1, 0], () => 0.99), 'b');
  assert.equal(pickWeighted(items, [1, 0, 0], () => 0.0), 'a');
  assert.equal(pickWeighted(items, [0, 0, 0], () => 0.5), null);

  // Verteilung: Gewicht 9:1 muss deutlich sichtbar sein.
  let seq = 0;
  const rand = () => ((seq++ % 100) + 0.5) / 100;
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 100; i += 1) {
    counts[pickWeighted(['a', 'b'], [9, 1], rand)] += 1;
  }
  assert.equal(counts.a, 90);
  assert.equal(counts.b, 10);
});
