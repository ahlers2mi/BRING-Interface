// Packliste als Einkaufslisten-Anbieter: der Client muss dieselbe Form liefern wie Bring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shoppingBackend, createPacklisteClient } from '../lib/shopping.js';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, ...opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    const { status = 200, json = {} } = handler(url, opts) || {};
    return { ok: status < 400, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

test('SHOPPING_BACKEND: Standard ist bring, nur "packliste" schaltet um', () => {
  const old = process.env.SHOPPING_BACKEND;
  delete process.env.SHOPPING_BACKEND;
  assert.equal(shoppingBackend(), 'bring');
  process.env.SHOPPING_BACKEND = ' Packliste ';
  assert.equal(shoppingBackend(), 'packliste');
  process.env.SHOPPING_BACKEND = 'quatsch';
  assert.equal(shoppingBackend(), 'bring');
  if (old === undefined) delete process.env.SHOPPING_BACKEND; else process.env.SHOPPING_BACKEND = old;
});

test('Packliste-Client ruft die Dienst-Schnittstelle mit Token auf', async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith('/api/svc/lists')) return { json: { lists: [{ listUuid: 'einkauf', name: 'Einkauf' }] } };
    if (url.endsWith('/items')) return { json: { uuid: 'einkauf', purchase: [{ name: 'Milch', specification: '2 l' }], recently: [] } };
    return { json: { ok: true } };
  });
  const c = createPacklisteClient({ url: 'http://packliste:8080/', token: 'abc', user: 'Wochenplan', fetchImpl: f });
  await c.login();
  assert.deepEqual(await c.loadLists(), { lists: [{ listUuid: 'einkauf', name: 'Einkauf' }] });
  const items = await c.getItems('einkauf');
  assert.equal(items.purchase[0].specification, '2 l');
  await c.saveItem('einkauf', 'Gehackte Tomaten', '2 Dosen');
  await c.removeItem('einkauf', 'Käse & Wurst');
  await c.moveToRecentList('einkauf', 'Milch');

  const [, , , save, remove, done] = f.calls;
  assert.equal(save.method, 'POST');
  assert.equal(save.url, 'http://packliste:8080/api/svc/lists/einkauf/items');
  assert.deepEqual(save.body, { name: 'Gehackte Tomaten', specification: '2 Dosen' });
  assert.equal(remove.method, 'DELETE');
  assert.equal(remove.url, 'http://packliste:8080/api/svc/lists/einkauf/items/K%C3%A4se%20%26%20Wurst');
  assert.equal(done.url, 'http://packliste:8080/api/svc/lists/einkauf/items/Milch/done');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer abc');
  assert.equal(f.calls[0].headers['X-User'], 'Wochenplan');
});

test('Packliste-Client: verständliche Fehler', async () => {
  await assert.rejects(createPacklisteClient({ token: '', fetchImpl: fakeFetch(() => ({})) }).login(), /PACKLISTE_TOKEN fehlt/);
  await assert.rejects(createPacklisteClient({ token: 'x', fetchImpl: fakeFetch(() => ({ status: 401 })) }).loadLists(), /Token falsch/);
  const broken = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  await assert.rejects(createPacklisteClient({ token: 'x', fetchImpl: broken }).loadLists(), /nicht erreichbar.*ENOTFOUND/);
});
