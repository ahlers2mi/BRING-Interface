// Netzfehler lesbar machen. Anlass: in der Oberfläche stand nur
// "Fehler: fetch failed" – daraus liest niemand ab, ob DNS, Firewall oder die
// Gegenstelle das Problem ist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeNetError, errorCode, fetchOrExplain } from '../lib/neterror.js';

function fetchError(code, message = 'kaputt') {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error(message), { code });
  return err;
}

test('der Code steckt in cause und wird gefunden', () => {
  assert.equal(errorCode(fetchError('ENOTFOUND')), 'ENOTFOUND');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'ECONNREFUSED');
  assert.equal(errorCode(new Error('ohne Code')), '');
});

test('verschachtelte Ursachen werden aufgelöst', () => {
  const innen = Object.assign(new Error('tief'), { code: 'ETIMEDOUT' });
  const mitte = Object.assign(new Error('mitte'), { cause: innen });
  const aussen = Object.assign(new TypeError('fetch failed'), { cause: mitte });
  assert.equal(errorCode(aussen), 'ETIMEDOUT');
});

test('gesammelte Fehlversuche (IPv4 + IPv6) werden ausgewertet', () => {
  // Node probiert bei Namen mit A- UND AAAA-Eintrag beide Adressen und legt
  // die Einzelfehler in errors[] ab – der Code steht dann nur dort.
  const aggregat = new AggregateError(
    [
      Object.assign(new Error('connect ENETUNREACH 2a01::1:443'), { code: 'ENETUNREACH' }),
      Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
    ],
    'alle Versuche fehlgeschlagen'
  );
  const err = Object.assign(new TypeError('fetch failed'), { cause: aggregat });
  assert.equal(errorCode(err), 'ENETUNREACH');
  assert.match(describeNetError(err, 'blog.example'), /IPv6/);
});

test('die Meldung nennt Code, Ziel und einen Hinweis', () => {
  const text = describeNetError(fetchError('ENOTFOUND'), 'Mealie unter http://mealie:9000');
  assert.match(text, /ENOTFOUND/);
  assert.match(text, /mealie:9000/);
  assert.match(text, /nur innerhalb desselben Stacks/);

  assert.match(describeNetError(fetchError('ECONNREFUSED'), 'x'), /abgelehnt/);
  assert.match(describeNetError(fetchError('ENETUNREACH'), 'x'), /IPv6/);
});

test('ohne erkennbaren Code bleibt die ursprüngliche Meldung', () => {
  assert.match(describeNetError(new Error('irgendwas'), 'Ziel'), /irgendwas \(Ziel\)/);
});

test('fetchOrExplain ersetzt Verbindungsfehler, lässt HTTP-Fehler durch', async () => {
  await assert.rejects(
    () =>
      fetchOrExplain(
        'http://ziel.invalid/',
        {},
        {
          fetchImpl: async () => {
            throw fetchError('ECONNREFUSED');
          },
          was: 'Mealie',
        }
      ),
    /ECONNREFUSED \(Mealie\)/
  );

  // Ein 404 ist kein Verbindungsfehler – die Antwort kommt unverändert zurück.
  const res = await fetchOrExplain(
    'http://ziel.invalid/',
    {},
    { fetchImpl: async () => ({ ok: false, status: 404 }) }
  );
  assert.equal(res.status, 404);
});

test('Zeitüberschreitung wird als solche benannt', () => {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  assert.match(describeNetError(err, 'Mealie'), /Zeitüberschreitung.*Mealie/);
});
