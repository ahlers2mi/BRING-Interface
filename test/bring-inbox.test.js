// Bring als Eingang: Artikel wandern in die Packliste und verschwinden danach aus Bring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInboxOnce, findInboxList } from '../lib/bring-inbox.js';

function fakeBring(items) {
  const removed = [];
  return {
    removed,
    getItems: async () => ({ purchase: items.filter((i) => !removed.includes(i.name)), recently: [] }),
    removeItem: async (_l, name) => { removed.push(name); },
    getUserSettings: async () => ({ usersettings: [{ key: 'defaultListUUID', value: 'std' }, { key: 'alexaDefaultList', value: 'alexa' }] }),
    loadLists: async () => ({ lists: [{ listUuid: 'erste' }] }),
  };
}

test('übernimmt Artikel mit Menge und leert Bring danach', async () => {
  const bring = fakeBring([{ name: 'Milch', specification: '2 l' }, { name: 'Röstzwiebeln', specification: '' }]);
  const saved = [];
  const target = { saveItem: async (l, n, s) => { saved.push([l, n, s]); } };
  const r = await runInboxOnce({ bring, target, inboxList: 'alexa', targetList: 'einkauf' });
  assert.deepEqual(saved, [['einkauf', 'Milch', '2 l'], ['einkauf', 'Röstzwiebeln', '']]);
  assert.deepEqual(bring.removed, ['Milch', 'Röstzwiebeln']);
  assert.deepEqual(r.moved, ['Milch (2 l)', 'Röstzwiebeln']);
});

test('bei Fehler beim Speichern bleibt der Artikel in Bring', async () => {
  const bring = fakeBring([{ name: 'Brot' }, { name: 'Eier' }]);
  const target = { saveItem: async (_l, n) => { if (n === 'Brot') throw new Error('Packliste weg'); } };
  const r = await runInboxOnce({ bring, target, inboxList: 'alexa', targetList: 'einkauf' });
  assert.deepEqual(bring.removed, ['Eier']);
  assert.equal(r.failed[0].name, 'Brot');
});

test('Eingangsliste: BRING_INBOX_LIST, sonst Alexas Standardliste', async () => {
  const old = process.env.BRING_INBOX_LIST;
  delete process.env.BRING_INBOX_LIST;
  assert.equal(await findInboxList(fakeBring([])), 'alexa');
  process.env.BRING_INBOX_LIST = 'fest';
  assert.equal(await findInboxList(fakeBring([])), 'fest');
  if (old === undefined) delete process.env.BRING_INBOX_LIST; else process.env.BRING_INBOX_LIST = old;
});
