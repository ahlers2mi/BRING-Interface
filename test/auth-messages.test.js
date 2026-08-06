// Läuft in einem eigenen Prozess (node --test startet je Datei einen), damit
// hier APP_PASSWORD ohne API_TOKEN geprüft werden kann – der häufigste
// Stolperstein beim FHEM-Zugang: Variable nicht im Container.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const dbFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bring-auth-')),
  'test.db'
);
process.env.DB_PATH = dbFile;
process.env.PORT = '0';
process.env.APP_PASSWORD = 'geheim';
delete process.env.API_TOKEN; // genau der Fehlerfall

const { app } = await import('../server.js');
const server = app.listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

test('ohne Token: schlichtes "Nicht angemeldet."', async () => {
  const res = await fetch(`${base}/api/fhem/plan`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'Nicht angemeldet.');
});

test('mit Token, aber API_TOKEN fehlt im Container: Hinweis darauf', async () => {
  for (const req of [
    fetch(`${base}/api/fhem/plan?token=irgendwas`),
    fetch(`${base}/api/fhem/plan`, { headers: { 'X-API-Token': 'irgendwas' } }),
    fetch(`${base}/api/fhem/plan`, { headers: { Authorization: 'Bearer irgendwas' } }),
  ]) {
    const res = await req;
    assert.equal(res.status, 401);
    const { error } = await res.json();
    assert.match(error, /API_TOKEN nicht gesetzt/);
    assert.match(error, /printenv API_TOKEN/);
  }
});

test('Status meldet, dass der Token-Zugang aus ist', async () => {
  // /api/status hängt hinter der Sperre – mit Session-Cookie geht es.
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=geheim',
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/api/status`, { headers: { cookie } });
  const status = await res.json();
  assert.equal(status.authEnabled, true);
  assert.equal(status.apiTokenEnabled, false);
});

test('angemeldet ist der Wochenplan erreichbar (Beweis für den neuen Stand)', async () => {
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=geheim',
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/api/fhem/plan`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match((await res.json()).week, /^\d{4}-W\d{2}$/);
});
