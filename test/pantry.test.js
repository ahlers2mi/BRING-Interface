// Vorratskammer: die Logik hinter „abgehakt in der Bring-App = gekauft".
//
// Eigene Datei, damit sie direkt gegen `database.js` läuft: über die HTTP-Route
// käme man an den interessanten Fall nicht heran, weil das Auf-die-Liste-Schieben
// ein Bring-Konto braucht (und die Bring-Routen sind in den Tests aussen vor).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-test-')), 'test.db');
process.env.DB_PATH = dbFile;

const {
  addPantryItem,
  applyPantryPurchases,
  getPantry,
  markPantryListed,
  seedPantry,
  setAllPantryStatus,
  updatePantryItem,
} = await import('../database.js');

test.after(() => fs.rmSync(path.dirname(dbFile), { recursive: true, force: true }));

const status = (name) => getPantry().find((i) => i.name === name)?.status;
const listed = (name) => Boolean(getPantry().find((i) => i.name === name)?.listed_at);

test('Grundstock legt nichts doppelt an', () => {
  assert.equal(seedPantry(['Salz', 'Pfeffer', 'Mehl']), 3);
  assert.equal(seedPantry(['Salz', 'Zucker']), 1, 'nur Zucker ist neu');
  assert.equal(getPantry().length, 4);
});

test('addPantryItem frischt auf statt zu verdoppeln', () => {
  addPantryItem({ name: 'Backpapier', amount: '1 Rolle' });
  addPantryItem({ name: 'Backpapier', status: 'low' });
  const treffer = getPantry().filter((i) => i.name === 'Backpapier');
  assert.equal(treffer.length, 1);
  assert.equal(treffer[0].status, 'low');
  assert.equal(treffer[0].amount, '1 Rolle', 'die Menge bleibt, wenn keine neue kommt');
});

test('abgehakt in der Bring-App wird als gekauft uebernommen', () => {
  setAllPantryStatus('have');
  const alle = getPantry();
  const salz = alle.find((i) => i.name === 'Salz');
  const mehl = alle.find((i) => i.name === 'Mehl');
  updatePantryItem(salz.id, { status: 'out' });
  updatePantryItem(mehl.id, { status: 'low' });

  // 1. Ohne dass etwas auf der Liste war, aendert ein Abgleich NICHTS. Sonst
  //    zieht ein alter Eintrag unter "zuletzt gekauft" jeden frisch auf "knapp"
  //    gesetzten Vorrat sofort wieder auf "da".
  let res = applyPantryPurchases({ purchase: [], recently: [{ name: 'Salz' }] });
  assert.deepEqual(res.bought, []);
  assert.equal(status('Salz'), 'out');

  // 2. Jetzt auf die Liste geschoben.
  assert.equal(markPantryListed(['Salz', 'Mehl']), 2);
  assert.equal(listed('Salz'), true);

  // 3. Steht es noch auf der Liste, ist es nicht gekauft.
  res = applyPantryPurchases({ purchase: [{ name: 'Salz' }, { name: 'Mehl' }], recently: [] });
  assert.deepEqual(res.bought, []);
  assert.equal(status('Salz'), 'out');
  assert.equal(listed('Salz'), true, 'wartet weiter');

  // 4. Salz abgehakt: weg von der Liste, dafuer unter "zuletzt gekauft".
  res = applyPantryPurchases({ purchase: [{ name: 'Mehl' }], recently: [{ name: 'Salz' }] });
  assert.deepEqual(res.bought, ['Salz']);
  assert.equal(status('Salz'), 'have');
  assert.equal(listed('Salz'), false, 'Merkung ist verbraucht');
  assert.equal(status('Mehl'), 'low', 'Mehl liegt noch an');
});

test('von der Liste genommen ist nicht gekauft', () => {
  setAllPantryStatus('have');
  const mehl = getPantry().find((i) => i.name === 'Mehl');
  updatePantryItem(mehl.id, { status: 'out' });
  markPantryListed(['Mehl']);

  // Weder auf der Liste noch unter "zuletzt gekauft": jemand hat es von Hand
  // von der Liste geworfen. Dann bleibt der Zustand - gekauft wurde nichts.
  const res = applyPantryPurchases({ purchase: [], recently: [] });
  assert.deepEqual(res.bought, []);
  assert.deepEqual(res.dropped, ['Mehl']);
  assert.equal(status('Mehl'), 'out', 'weiter leer');
  assert.equal(listed('Mehl'), false, 'wartet aber nicht mehr');
});

test('Namen werden nicht buchstabengenau verglichen', () => {
  setAllPantryStatus('have');
  const zucker = getPantry().find((i) => i.name === 'Zucker');
  updatePantryItem(zucker.id, { status: 'low' });
  markPantryListed(['Zucker']);

  // Bring gibt den Artikel klein geschrieben zurueck – das darf den Abgleich
  // nicht aufhalten.
  const res = applyPantryPurchases({ purchase: [], recently: [{ name: 'zucker' }] });
  assert.deepEqual(res.bought, ['Zucker']);
  assert.equal(status('Zucker'), 'have');
});

test('leere Eingaben tun nichts', () => {
  assert.deepEqual(applyPantryPurchases(), { bought: [], dropped: [] });
  assert.deepEqual(applyPantryPurchases({}), { bought: [], dropped: [] });
  assert.equal(markPantryListed(), 0);
  assert.equal(markPantryListed(['gibt es nicht']), 0);
});
