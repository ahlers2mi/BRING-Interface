// Zeit- und Mengenumrechnung: beides steckt in den Quellen als Text, und beides
// darf im Zweifel lieber gar nichts tun als etwas Falsches ausrechnen.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMinutes,
  parseServings,
  scaleAmountText,
  scaleFactor,
  scaleIngredients,
} from '../lib/scale.js';

test('Zeitangaben aus den Quellen werden zu Minuten', () => {
  assert.equal(parseMinutes('45 Min.'), 45);
  assert.equal(parseMinutes('20 Minuten'), 20);
  assert.equal(parseMinutes('1 Stunde'), 60);
  assert.equal(parseMinutes('1 Std. 30 Min.'), 90);
  // Cookidoo liefert "aktiv" und "gesamt" in einem Feld – zusammenzählen.
  assert.equal(parseMinutes('15 Min. aktiv · 45 Min.'), 60);
  assert.equal(parseMinutes('PT1H30M'), 90);
  assert.equal(parseMinutes('30'), 30);
});

test('ohne verwertbare Zeitangabe gibt es keine Zahl (und keine Strafe)', () => {
  assert.equal(parseMinutes(''), null);
  assert.equal(parseMinutes(null), null);
  assert.equal(parseMinutes('keine Angabe'), null);
  assert.equal(parseMinutes('0 Min.'), null);
});

test('Portionen aus dem Text', () => {
  assert.equal(parseServings('4 Portionen'), 4);
  assert.equal(parseServings('für 2 Personen'), 2);
  assert.equal(parseServings('6'), 6);
  assert.equal(parseServings(''), null);
  assert.equal(parseServings('einige'), null);
});

test('Umrechnungsfaktor – ohne Portionsangabe wird nicht gerechnet', () => {
  assert.equal(scaleFactor('4 Portionen', 2.5), 0.625);
  assert.equal(scaleFactor('2 Portionen', 5), 2.5);
  assert.equal(scaleFactor('', 2.5), null, 'ohne Angabe lieber nichts anfassen');
  assert.equal(scaleFactor('4 Portionen', 0), null, 'Haushaltsgröße 0 = aus');
  assert.equal(scaleFactor('4 Portionen', 4), null, 'gleich viel = nichts zu tun');
  assert.equal(scaleFactor('4 Portionen', 4.1), null, 'winzige Abweichung lohnt nicht');
});

test('Mengen werden auf lesbare Schritte gerundet', () => {
  const f = scaleFactor('4 Portionen', 2.5); // 0,625
  assert.equal(scaleAmountText('600 g', f), '380 g');
  assert.equal(scaleAmountText('200 ml', f), '130 ml');
  assert.equal(scaleAmountText('2 Stück', f), '1,5 Stück');
  assert.equal(scaleAmountText('1 Bund', f), '1/2 Bund');
  // Was sich nicht rechnen lässt, bleibt stehen.
  assert.equal(scaleAmountText('etwas', f), 'etwas');
  assert.equal(scaleAmountText('', f), '');
  assert.equal(scaleAmountText('600 g', null), '600 g');
});

test('Brüche werden verstanden', () => {
  assert.equal(scaleAmountText('1/2 TL', 2), '1 TL');
  assert.equal(scaleAmountText('1/2 TL', 4), '2 TL');
});

test('doppelte Angaben werden beide umgerechnet', () => {
  // "1 Dose Kokosmilch (ca. 400 g)" wird beim Spiegeln zu Menge
  // "1 Dose oder 400 g". Ohne Sonderbehandlung faellt die zweite Angabe beim
  // Umrechnen weg, weil splitAmount nur die erste sieht.
  assert.equal(scaleAmountText('1 Dose oder 400 g', 0.5), '1/2 Dose oder 200 g');
  assert.equal(scaleAmountText('1 Glas oder 720 ml', 2), '2 Glas oder 1440 ml');
});

test('Verdoppeln ist der Normalfall bei Besuch', () => {
  const f = scaleFactor('4 Portionen', 8);
  assert.equal(f, 2);
  assert.deepEqual(
    scaleIngredients(
      [
        { name: 'Mehl', amount: '250 g' },
        { name: 'Eier', amount: '3' },
        { name: 'Salz', amount: '' },
      ],
      f
    ),
    [
      { name: 'Mehl', amount: '500 g' },
      { name: 'Eier', amount: '6' },
      { name: 'Salz', amount: '' },
    ]
  );
});

test('ohne Faktor bleibt die Liste, wie sie ist', () => {
  const zutaten = [{ name: 'Mehl', amount: '250 g' }];
  assert.deepEqual(scaleIngredients(zutaten, null), zutaten);
});
