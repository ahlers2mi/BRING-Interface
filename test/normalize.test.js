import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAmountNumber,
  ingredientMatches,
  isIncompleteRecipe,
  isPantryItem,
  isTeaserIngredient,
  matchRecipeToFridge,
  normalizeName,
  realIngredients,
  splitAmount,
  splitIngredientText,
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

test('splitAmount laesst die Einheit nicht mitten im Wort greifen', () => {
  // Das "g" fuer Gramm griff in "Glas", das "l" in "Liter", das "st" in
  // "Stangen": aus "1 Glas Rotkohl" wurde "1 G" + "las Rotkohl".
  assert.deepEqual(splitAmount('1 Glas Rotkohl'), { amount: '1 Glas', name: 'Rotkohl' });
  assert.deepEqual(splitAmount('1 Liter Milch'), { amount: '1 Liter', name: 'Milch' });
  assert.deepEqual(splitAmount('2 Stangen Porree'), { amount: '2 Stangen', name: 'Porree' });
  assert.deepEqual(splitAmount('3 Tassen Reis'), { amount: '3 Tassen', name: 'Reis' });
  // Punkt hinter der Einheit und Einheit direkt an der Zahl gehen weiterhin.
  assert.deepEqual(splitAmount('1 TL. Salz'), { amount: '1 TL', name: 'Salz' });
  assert.deepEqual(splitAmount('200ml Sahne'), { amount: '200 ml', name: 'Sahne' });
});

test('splitIngredientText raeumt Freitext-Zutaten auf', () => {
  // Alle Zeilen echt so von der Bring-Liste bzw. aus Mealie.
  const f = (text) => splitIngredientText(text);

  assert.deepEqual(f('400 g Hähnchenbrustfilet(s)'), {
    amount: '400 g',
    name: 'Hähnchenbrustfilet',
  });
  assert.deepEqual(f('100 g Bulgur'), { amount: '100 g', name: 'Bulgur' });
  assert.deepEqual(f('200 ml Orangensaft'), { amount: '200 ml', name: 'Orangensaft' });

  // Krumme Zahlen lesbar: 0.25 -> 1/4.
  assert.deepEqual(f('0.25 Salatgurke(n)'), { amount: '1/4', name: 'Salatgurke' });
  assert.deepEqual(f('0.5 Paprikaschote(n)'), { amount: '1/2', name: 'Paprikaschote' });

  // "n. B." heisst "nach Bedarf" - keine Menge, und schon gar kein Name.
  assert.deepEqual(f('n. B. Reis'), { amount: '', name: 'Reis' });
  assert.deepEqual(f('etwas Butter'), { amount: '', name: 'Butter' });

  // Groesse gehoert zur Menge: Bring kennt "Zwiebel", nicht "kleine Zwiebel".
  assert.deepEqual(f('1 kleine Zwiebel(n)'), { amount: '1 kleine', name: 'Zwiebel' });
  assert.deepEqual(f('2 kleine Champignons'), { amount: '2 kleine', name: 'Champignons' });
  // Farbe/Sorte bleibt am Namen - das ist ein anderes Produkt.
  assert.deepEqual(f('1 Paprikaschote(n), rote'), {
    amount: '1',
    name: 'Paprikaschote, rote',
  });

  // Gewicht in Klammern gehoert zur Menge, nicht in den Artikelnamen.
  assert.deepEqual(f('1 Dose/n Kokosmilch (ca. 400 g)'), {
    amount: '1 Dose oder 400 g',
    name: 'Kokosmilch',
  });
  assert.deepEqual(f('1 Glas Rotkohl (720 ml)'), {
    amount: '1 Glas oder 720 ml',
    name: 'Rotkohl',
  });
  // Eine Klammer, die keine Menge ist, bleibt stehen.
  assert.deepEqual(f('Nudeln (Spirelli)'), { amount: '', name: 'Nudeln (Spirelli)' });

  // Ohne Menge bleibt alles, wie es ist.
  assert.deepEqual(f('Salz und Pfeffer'), { amount: '', name: 'Salz und Pfeffer' });
  assert.deepEqual(f(''), { amount: '', name: '' });
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

// ── Angerissene Rezepte (Chefkoch PLUS) ───────────────────────────────────────

test('der PLUS-Platzhalter gilt nicht als Zutat', () => {
  assert.equal(isTeaserIngredient('-- additional ingredients not fully disclosed --'), true);
  assert.equal(isTeaserIngredient('Zutaten nicht vollständig'), true);
  assert.equal(isTeaserIngredient('450 g Kartoffel(n), in dünnen Scheiben'), false);
  assert.equal(isTeaserIngredient(''), false);
  assert.equal(isTeaserIngredient(null), false);
});

test('realIngredients wirft nur den Platzhalter weg', () => {
  const list = [
    { name: 'Kartoffeln' },
    { name: '-- additional ingredients not fully disclosed --' },
    { name: 'Chorizo' },
  ];
  assert.deepEqual(
    realIngredients(list).map((i) => i.name),
    ['Kartoffeln', 'Chorizo']
  );
});

test('unvollständig ist ein Rezept mit Platzhalter oder ganz ohne Zutaten', () => {
  assert.equal(
    isIncompleteRecipe({
      ingredients: [{ name: 'Kartoffeln' }, { name: '-- additional ingredients not fully disclosed --' }],
    }),
    true
  );
  assert.equal(isIncompleteRecipe({ ingredients: [] }), true);
  assert.equal(isIncompleteRecipe({ ingredients: [{ name: 'Kartoffeln' }] }), false);
  // Ohne geladene Zutatenliste lieber nichts behaupten.
  assert.equal(isIncompleteRecipe({}), false);
});

test('die Reste-Suche rechnet den Platzhalter nicht als fehlende Zutat', () => {
  const res = matchRecipeToFridge(
    [{ name: 'Kartoffeln' }, { name: '-- additional ingredients not fully disclosed --' }],
    ['Kartoffeln'],
    { assumePantry: false }
  );
  assert.equal(res.coverage, 1);
  assert.equal(res.missing.length, 0);
});
