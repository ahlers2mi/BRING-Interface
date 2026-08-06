import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAmountNumber,
  ingredientMatches,
  isPantryItem,
  matchRecipeToFridge,
  normalizeName,
  splitAmount,
} from '../lib/normalize.js';

test('splitAmount trennt Menge und Zutat', () => {
  assert.deepEqual(splitAmount('500 g Mehl'), { amount: '500 g', name: 'Mehl' });
  assert.deepEqual(splitAmount('2 EL Olivenöl'), { amount: '2 EL', name: 'Olivenöl' });
  assert.deepEqual(splitAmount('1/2 Bund Petersilie'), {
    amount: '1/2 Bund',
    name: 'Petersilie',
  });
  assert.deepEqual(splitAmount('½ TL Salz'), { amount: '½ TL', name: 'Salz' });
  assert.deepEqual(splitAmount('3 Eier'), { amount: '3', name: 'Eier' });
  assert.deepEqual(splitAmount('Salz und Pfeffer'), {
    amount: '',
    name: 'Salz und Pfeffer',
  });
  assert.deepEqual(splitAmount('500g Hackfleisch'), {
    amount: '500 g',
    name: 'Hackfleisch',
  });
});

test('ingredientMatches erkennt Singular/Plural und Umlaute', () => {
  assert.ok(ingredientMatches('Zwiebeln', 'Zwiebel'));
  assert.ok(ingredientMatches('Tomaten', 'tomate'));
  assert.ok(ingredientMatches('Möhren', 'Moehre'));
  assert.ok(ingredientMatches('Kartoffeln', 'Kartoffel'));
});

test('ingredientMatches greift bei Komposita', () => {
  assert.ok(ingredientMatches('Hähnchenbrustfilet', 'Hähnchenbrust'));
  assert.ok(ingredientMatches('Rinderhackfleisch', 'Hackfleisch'));
});

test('ingredientMatches bleibt bei Verschiedenem negativ', () => {
  assert.equal(ingredientMatches('Zucchini', 'Aubergine'), false);
  assert.equal(ingredientMatches('Mehl', 'Milch'), false);
  assert.equal(ingredientMatches('Reis', 'Eis'), false);
});

test('normalizeName wirft Beiwerk weg', () => {
  assert.equal(normalizeName('2 große Zwiebeln, frisch'), normalizeName('Zwiebel'));
  assert.equal(normalizeName('Paprika (rot)'), normalizeName('Paprika'));
});

test('Vorräte werden erkannt', () => {
  assert.ok(isPantryItem('Salz'));
  assert.ok(isPantryItem('etwas Pfeffer'));
  assert.equal(isPantryItem('Lachsfilet'), false);
});

test('matchRecipeToFridge zählt Vorräte nicht als fehlend', () => {
  const ingredients = [
    { name: 'Zucchini', amount: '2' },
    { name: 'Hackfleisch', amount: '500 g' },
    { name: 'Salz', amount: '1 TL' },
    { name: 'Feta', amount: '200 g' },
  ];
  const res = matchRecipeToFridge(ingredients, ['Zucchini', 'Rinderhackfleisch']);
  assert.deepEqual(
    res.matched.map((m) => m.name),
    ['Zucchini', 'Hackfleisch']
  );
  assert.deepEqual(
    res.missing.map((m) => m.name),
    ['Feta']
  );
  assert.equal(res.coverage, 2 / 3);

  const strict = matchRecipeToFridge(ingredients, ['Zucchini'], { assumePantry: false });
  assert.equal(strict.missing.length, 3); // Salz zählt jetzt mit
});

test('formatAmountNumber schreibt Brüche lesbar', () => {
  assert.equal(formatAmountNumber(0.5), '1/2');
  assert.equal(formatAmountNumber(2), '2');
  assert.equal(formatAmountNumber(1.5), '1,5');
  assert.equal(formatAmountNumber(0), '');
});
