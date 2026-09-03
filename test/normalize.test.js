import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAmountNumber,
  ingredientMatches,
  isIncompleteRecipe,
  isPantryItem,
  isTeaserIngredient,
  matchRecipeToFridge,
  mergeAmounts,
  normalizeName,
  realIngredients,
  recipeItemsOnList,
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

// ── Mengen zusammenrechnen (Wocheneinkauf) ────────────────────────────────────
//
// Vorher wurden die Mengen bloss aneinandergehaengt. Auf dem Zettel stand
// "½ TL + 1 TL + 1 TL Salz" und "2 + 1 Knoblauchzehen" – beides echte Beispiele
// aus einer Wochenliste.

test('gleiche Einheit wird addiert', () => {
  assert.equal(mergeAmounts(['½ TL', '1 TL', '1 TL']), '2,5 TL');
  assert.equal(mergeAmounts(['2', '1']), '3');
  assert.equal(mergeAmounts(['1 TL', '2 TL']), '3 TL');
  assert.equal(mergeAmounts(['1/2 TL', '1/2 TL']), '1 TL');
  assert.equal(mergeAmounts(['400 g']), '400 g');
  assert.equal(mergeAmounts([]), '');
  assert.equal(mergeAmounts(['', null]), '');
});

test('Ein- und Mehrzahl derselben Einheit sind dieselbe Einheit', () => {
  assert.equal(mergeAmounts(['2 Dosen', '1 Dose']), '3 Dosen');
  // Die Mehrzahl gewinnt, wenn sie vorkommt – "3 Zehe" liest sich falsch.
  assert.equal(mergeAmounts(['1 Zehe', '2 Zehen']), '3 Zehen');
  assert.equal(mergeAmounts(['1 Prise', '2 Prisen']), '3 Prisen');
  // Ausgeschrieben ist es dieselbe Einheit wie die Abkuerzung.
  assert.equal(mergeAmounts(['2 EL', '1 Esslöffel']), '3 EL');
});

test('umgerechnet wird nur, wo es verlustfrei ist – und in die erste Einheit', () => {
  assert.equal(mergeAmounts(['1 kg', '500 g']), '1,5 kg');
  assert.equal(mergeAmounts(['500 g', '1 kg']), '1500 g');
  assert.equal(mergeAmounts(['200 ml', '0,5 l']), '700 ml');
  // TL und EL bleiben getrennt: "5⅓ EL" ist als Kaufmenge unbrauchbar.
  assert.equal(mergeAmounts(['4 EL', '4 TL']), '4 EL + 4 TL');
});

test('was sich nicht verrechnen laesst, bleibt unveraendert stehen', () => {
  // Groessenangabe, Bereich, Klammerzusatz – lieber ehrlich hintereinander
  // als falsch addiert.
  assert.equal(mergeAmounts(['1 kleine', '2']), '1 kleine + 2');
  assert.equal(mergeAmounts(['2-3 EL', '1 EL']), '2-3 EL + 1 EL');
  assert.equal(mergeAmounts(['2 EL (ca. 30 g)']), '2 EL (ca. 30 g)');
});

test('eine Klammer VOR dem Namen ist eine Anmerkung, kein Artikel', () => {
  // Regel 4 fasst nur die Klammer am Ende. Mitten in der Zeile blieb sie am
  // Namen kleben – "(ca. 30 g) Butter" findet Bring in seinem Katalog nicht.
  assert.deepEqual(splitIngredientText('2 EL (ca. 30 g) Butter'), {
    name: 'Butter',
    amount: '2 EL',
  });
  assert.deepEqual(splitIngredientText('400 g (ca. 150 g roher Reis) gekochter Basmatireis'), {
    name: 'gekochter Basmatireis',
    amount: '400 g',
  });
  assert.deepEqual(
    splitIngredientText('200 g (frisch oder abgetropft aus der Dose) Ananasstücke'),
    { name: 'Ananasstücke', amount: '200 g' }
  );
  // Eine Klammer HINTER dem Namen bleibt: die bezeichnet die Sorte.
  assert.deepEqual(splitIngredientText('Nudeln (Spirelli)'), {
    name: 'Nudeln (Spirelli)',
    amount: '',
  });
});

// ── Zutaten wieder von der Bring-Liste nehmen ─────────────────────────────────

const REZEPT = [
  { name: 'Zwiebeln', amount: '2' },
  { name: 'Olivenöl', amount: '2 EL' },
  { name: 'Zucker', amount: '1 TL' },
  { name: 'Hackfleisch', amount: '500 g' },
  { name: '-- additional ingredients not fully disclosed --' },
];

test('nur was zum Rezept gehoert, kommt weg', () => {
  const liste = [
    { name: 'Zwiebel', specification: '2' }, // Einzahl auf der Liste
    { name: 'Olivenöl', specification: '2 EL' },
    { name: 'Klopapier', specification: '' }, // fremd
    { name: 'Puderzucker', specification: '1 Pck' }, // NICHT "Zucker"
  ];
  const res = recipeItemsOnList(liste, REZEPT);

  assert.deepEqual(res.remove.map((r) => r.name), ['Zwiebel', 'Olivenöl']);
  // Die Zutat steht dabei, nicht nur der Listenname – so ist nachvollziehbar,
  // warum "Zwiebel" gemeint ist.
  assert.equal(res.remove[0].ingredient, 'Zwiebeln');
  assert.equal(res.remove[0].amount, '2');
  // Fehlendes ist kein Fehler, nur eine Auskunft.
  assert.deepEqual(res.missing.sort(), ['Hackfleisch', 'Zucker']);
});

test('die Teilwort-Regel gilt hier NICHT', () => {
  // `ingredientMatches` zieht "Tomatenmark" auf "Tomaten" und "Buttermilch" auf
  // "Milch". Beim Zusammenlegen von Mengen ist so ein Fehlgriff eine krumme
  // Zahl, beim Loeschen fehlt hinterher ein Lebensmittel im Wagen – und zwar
  // eines, das jemand anders eingetragen hat.
  assert.equal(ingredientMatches('Tomaten', 'Tomatenmark'), true);
  assert.equal(ingredientMatches('Milch', 'Buttermilch'), true);

  const res = recipeItemsOnList(
    [{ name: 'Tomatenmark' }, { name: 'Buttermilch' }],
    [{ name: 'Tomaten' }, { name: 'Milch' }]
  );
  assert.deepEqual(res.remove, []);
  assert.deepEqual(res.missing.sort(), ['Milch', 'Tomaten']);

  // Die Einzahl/Mehrzahl-Regel greift aber weiter: dieselbe Zutat, anders
  // geschrieben, wird gefunden.
  assert.deepEqual(
    recipeItemsOnList([{ name: 'Zwiebel' }], [{ name: 'Zwiebeln' }]).remove.map((r) => r.name),
    ['Zwiebel']
  );
});

test('Vorraete auf der Liste bleiben stehen', () => {
  // Das Öl liegt auf der Liste, weil es LEER ist – nicht wegen des Rezepts.
  const res = recipeItemsOnList(
    [{ name: 'Olivenöl', specification: '' }, { name: 'Zwiebeln', specification: '2' }],
    REZEPT,
    { keepNames: ['Olivenöl'] }
  );
  assert.deepEqual(res.remove.map((r) => r.name), ['Zwiebeln']);
  assert.deepEqual(res.kept.map((k) => k.name), ['Olivenöl']);
  assert.equal(res.kept[0].reason, 'vorrat');
});

test('der PLUS-Platzhalter zaehlt auch hier nicht als Zutat', () => {
  const res = recipeItemsOnList(
    [{ name: '-- additional ingredients not fully disclosed --' }],
    REZEPT
  );
  assert.deepEqual(res.remove, []);
  assert.ok(!res.missing.some((n) => /disclosed/.test(n)));
});

test('leere Eingaben ergeben leere Antworten', () => {
  assert.deepEqual(recipeItemsOnList([], []), { remove: [], kept: [], missing: [] });
  assert.deepEqual(recipeItemsOnList(null, null), { remove: [], kept: [], missing: [] });
  // Namenlose Zeilen von Bring werden uebersprungen, nicht gematcht.
  assert.deepEqual(recipeItemsOnList([{ name: '  ' }], REZEPT).remove, []);
});
