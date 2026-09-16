// „Wann wurde zuletzt dafür eingekauft?" – die Spalte `recipes.last_shopped`.
//
// Eigene Datei direkt gegen `database.js`, aus demselben Grund wie bei den
// Vorräten: gesetzt wird die Marke in den Bring-Routen, und die brauchen ein
// Konto (sie sind in `api.test.js` aussen vor).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shopped-test-')), 'test.db');
process.env.DB_PATH = dbFile;

const { createRecipe, getRecipeById, markRecipeShopped, clearRecipeShopped } =
  await import('../database.js');

test.after(() => fs.rmSync(path.dirname(dbFile), { recursive: true, force: true }));

const neu = (name) => createRecipe({ name, ingredients: [{ name: 'Salz' }] }).id;

test('frisch angelegt steht da kein Datum', () => {
  const id = neu('Linsensuppe');
  assert.equal(getRecipeById(id).last_shopped, null);
});

test('markieren setzt ein Datum, löschen nimmt es wieder weg', () => {
  const id = neu('Chili');
  markRecipeShopped(id);
  const datum = getRecipeById(id).last_shopped;
  assert.match(datum, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  clearRecipeShopped(id);
  assert.equal(getRecipeById(id).last_shopped, null);
});

test('die Marke hängt am Rezept, nicht am Plan-Tag', () => {
  const a = neu('Ofengemüse');
  const b = neu('Nudelauflauf');
  markRecipeShopped(a);
  assert.ok(getRecipeById(a).last_shopped, 'markiertes Rezept hat ein Datum');
  assert.equal(getRecipeById(b).last_shopped, null, 'das andere bleibt unberührt');
});
