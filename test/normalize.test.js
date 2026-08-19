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
  tidyItems,
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

test('splitAmount kennt die haushaltsuebliche Einheiten', () => {
  // "1 Schuss Balsamico" wurde zum Artikel "Schuss Balsamico" - die Einheit
  // fehlte einfach in der Liste. Dasselbe fuer die anderen hier.
  assert.deepEqual(splitAmount('1 Schuss Balsamico'), { amount: '1 Schuss', name: 'Balsamico' });
  assert.deepEqual(splitAmount('1 Spritzer Zitrone'), { amount: '1 Spritzer', name: 'Zitrone' });
  assert.deepEqual(splitAmount('1 Kopf Salat'), { amount: '1 Kopf', name: 'Salat' });
  assert.deepEqual(splitAmount('1 Knolle Sellerie'), { amount: '1 Knolle', name: 'Sellerie' });
  assert.deepEqual(splitAmount('2 Tafeln Schokolade'), {
    amount: '2 Tafeln',
    name: 'Schokolade',
  });
  assert.deepEqual(splitAmount('1 Messerspitze Zimt'), {
    amount: '1 Messerspitze',
    name: 'Zimt',
  });
  // Und die Gegenprobe: ein Artikel, der mit einer Einheit ANFAENGT, bleibt ganz.
  assert.deepEqual(splitAmount('1 Kopfsalat'), { amount: '1', name: 'Kopfsalat' });
  assert.deepEqual(splitAmount('2 Handtuecher'), { amount: '2', name: 'Handtuecher' });
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

  // Gewicht in Klammern gehoert nicht in den Artikelnamen. Es gilt EINE Menge:
  // die Packungseinheit, denn die legt man in den Wagen.
  assert.deepEqual(f('1 Dose/n Kokosmilch (ca. 400 g)'), {
    amount: '1 Dose',
    name: 'Kokosmilch',
  });
  assert.deepEqual(f('1 Glas Rotkohl (720 ml)'), { amount: '1 Glas', name: 'Rotkohl' });
  // Steht sonst keine Menge da, tritt das Gewicht an ihre Stelle.
  assert.deepEqual(f('Kokosmilch (ca. 400 g)'), { amount: '400 g', name: 'Kokosmilch' });
  // "je" gehoert zur selben Sorte Klammer.
  assert.deepEqual(f('2 Pck. Sahne (je 200 g)'), { amount: '2 Pck', name: 'Sahne' });
  // Eine Klammer, die keine Menge ist, bleibt stehen.
  assert.deepEqual(f('Nudeln (Spirelli)'), { amount: '', name: 'Nudeln (Spirelli)' });

  // Ohne Menge bleibt alles, wie es ist.
  assert.deepEqual(f('Salz und Pfeffer'), { amount: '', name: 'Salz und Pfeffer' });
  assert.deepEqual(f(''), { amount: '', name: '' });
});

test('tidyItems findet die Artikel mit Menge im Namen', () => {
  // Genau die Liste aus dem Alltag: oben von Hand eingetragene Artikel, unten
  // die, die der Rezept-Import ungetrennt draufgeschrieben hat.
  const liste = [
    { name: 'Spülbürste', specification: '1' },
    { name: 'Erdinger', specification: 'alkoholfreies' },
    { name: 'Glasreiniger', specification: '' },
    { name: 'Q Tips', specification: '?' },
    { name: 'Salz und Pfeffer', specification: '' },
    { name: '1 kleine Zwiebel(n)', specification: '' },
    { name: '400 g Hähnchenbrustfilet(s)', specification: '' },
    { name: 'n. B. Reis', specification: '' },
    { name: '0.25 Salatgurke(n)', specification: '' },
    { name: '1 Dose/n Kokosmilch (ca. 400 g)', specification: '' },
  ];

  const changes = tidyItems(liste);
  assert.deepEqual(
    changes.map((c) => `${c.from} => ${c.to}|${c.amount}`),
    [
      '1 kleine Zwiebel(n) => Zwiebel|1 kleine',
      '400 g Hähnchenbrustfilet(s) => Hähnchenbrustfilet|400 g',
      'n. B. Reis => Reis|',
      '0.25 Salatgurke(n) => Salatgurke|1/4',
      '1 Dose/n Kokosmilch (ca. 400 g) => Kokosmilch|1 Dose',
    ]
  );

  // Von Hand eingetragene Artikel bleiben unangetastet – auch die mit "?" oder
  // einem Wort im Mengenfeld.
  for (const name of ['Spülbürste', 'Erdinger', 'Glasreiniger', 'Q Tips', 'Salz und Pfeffer']) {
    assert.ok(!changes.some((c) => c.from === name), `${name} darf nicht angefasst werden`);
  }
});

test('tidyItems verliert kein von Hand eingetragenes Mengenfeld', () => {
  const [change] = tidyItems([{ name: '400 g Hähnchenbrustfilet(s)', specification: 'Bio' }]);
  assert.equal(change.to, 'Hähnchenbrustfilet');
  assert.equal(change.amount, '400 g Bio');
  assert.equal(change.hadSpec, true);
  assert.deepEqual(tidyItems([]), []);
  assert.deepEqual(tidyItems(null), []);
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
