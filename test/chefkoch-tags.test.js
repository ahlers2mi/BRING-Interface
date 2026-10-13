import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverChefkochCandidates, normalizeChefkochTags } from '../lib/recipe-import.js';

test('Chefkoch-Kategorien werden bereinigt', () => {
  assert.deepEqual(normalizeChefkochTags([21, '32', 32, 'x', -1, 0, 1.5]), [21, 32]);
  assert.deepEqual(normalizeChefkochTags('21, 32'), [21, 32]);
  assert.deepEqual(normalizeChefkochTags(undefined), []);
});

test('Kategorien und Mindestbewertung gehen an die Chefkoch-Suche', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const results = urls.length === 1 ? [{ recipe: { id: '111', rating: { rating: 4.6, numVotes: 50 } } }] : [];
    return new Response(JSON.stringify({ count: 1, results }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const found = await discoverChefkochCandidates({
    query: '',
    count: 1,
    tags: [21, 32],
    minRating: 4,
    fetchImpl,
  });
  assert.equal(found.length, 1);
  assert.match(urls[0], /&tags=21,32/);
  assert.match(urls[0], /&minimumRating=4/);
});

test('ohne API keine ungefilterte Webseiten-Suche, wenn Kategorien gewählt sind', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response('kaputt', { status: 500 });
  };
  const logs = [];
  const found = await discoverChefkochCandidates({
    count: 5,
    tags: [32],
    fetchImpl,
    log: (m) => logs.push(m),
  });
  assert.equal(found.length, 0);
  assert.ok(urls.every((u) => u.includes('api.chefkoch.de')));
  assert.ok(logs.some((m) => m.includes('nicht nach Kategorien')));
});
