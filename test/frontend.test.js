// Prüft Verdrahtungen zwischen HTML und Oberflächen-Modulen, die sonst nur beim
// Klicken auffallen – Anlass: das Auswahlfeld der Reste-Küche blieb leer, weil
// seine id nicht in LIST_SELECT_IDS stand.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const core = fs.readFileSync(path.join(root, 'public/js/core.js'), 'utf8');

function idsInHtml(pattern) {
  return [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).filter((id) => pattern.test(id));
}

test('jedes Bring-Listen-Auswahlfeld wird auch gefüllt', () => {
  const inHtml = idsInHtml(/[Ll]istSelect$/);
  assert.ok(inHtml.length >= 4, `erwartet mehrere Auswahlfelder, gefunden: ${inHtml}`);

  const block = /const LIST_SELECT_IDS = \[([\s\S]*?)\]/.exec(core);
  assert.ok(block, 'LIST_SELECT_IDS nicht gefunden');
  const registered = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  for (const id of inHtml) {
    assert.ok(
      registered.includes(id),
      `${id} steht im HTML, aber nicht in LIST_SELECT_IDS – das Dropdown bliebe leer`
    );
  }
});

test('cookidoo.js gehört zu den geprüften Modulen', () => {
  // (Wächter für die Liste unten – neue Module sonst leicht vergessen.)
  const files = fs.readdirSync(path.join(root, 'public/js'));
  assert.ok(files.includes('cookidoo.js'));
});

test('jede Filter-Auswahl der Rezeptliste wird auch ausgewertet', () => {
  const recipes = fs.readFileSync(path.join(root, 'public/js/recipes.js'), 'utf8');
  const select = /<select id="recipeFilter">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, 'Auswahlfeld recipeFilter nicht gefunden');
  const values = [...select[1].matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 8, `erwartet mehrere Filter, gefunden: ${values}`);

  for (const value of values) {
    if (value === 'all') continue; // "Alle" ist der Standardfall ohne eigene Zeile
    assert.ok(
      recipes.includes(`'${value}'`),
      `Filter "${value}" steht im HTML, wird in recipes.js aber nirgends ausgewertet`
    );
  }
});

test('die Module sprechen nur Elemente an, die es im HTML gibt', () => {
  const files = [
    'core.js',
    'app.js',
    'shopping.js',
    'plan.js',
    'recipes.js',
    'fridge.js',
    'cookidoo.js',
  ];
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // Elemente, die die Module selbst erzeugen (nicht im HTML) – bewusst erlaubt.
  const dynamic = new Set(['orphanCleanBtn', 'orphanCleanAllBtn']);

  for (const file of files) {
    const code = fs.readFileSync(path.join(root, 'public/js', file), 'utf8');
    const used = new Set([
      ...[...code.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...code.matchAll(/\bon\('([^']+)',/g)].map((m) => m[1]),
    ]);
    for (const id of used) {
      if (dynamic.has(id)) continue;
      assert.ok(htmlIds.has(id), `${file} greift auf #${id} zu, das es im HTML nicht gibt`);
    }
  }
});
