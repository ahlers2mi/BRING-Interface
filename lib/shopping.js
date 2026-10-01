// Einkaufslisten-Anbieter umschaltbar: Bring (Standard) oder die eigene Packliste-App.
//
//   SHOPPING_BACKEND=bring      -> wie bisher über bring-shopping (BRING_MAIL/BRING_PASSWORD)
//   SHOPPING_BACKEND=packliste  -> Packliste-Dienstschnittstelle
//       PACKLISTE_URL=http://packliste:8080   (im Netz mealie-share)
//       PACKLISTE_TOKEN=<Inhalt von data/SERVICE-TOKEN.txt der Packliste>
//       PACKLISTE_USER=Wochenplan             (Name, der in der App als „hinzugefügt von“ erscheint)
//
// Der Packliste-Client bietet dieselben Methoden, die server.js vom Bring-Client
// nutzt: login, loadLists, getItems, saveItem, removeItem, moveToRecentList.
// Rückgaben haben dieselbe Form wie bei Bring ({ lists:[{listUuid,name}] },
// { purchase:[{name,specification}], recently:[…] }).

export function shoppingBackend() {
  const v = String(process.env.SHOPPING_BACKEND || 'bring').trim().toLowerCase();
  return v === 'packliste' ? 'packliste' : 'bring';
}

export function createPacklisteClient({
  url = process.env.PACKLISTE_URL || 'http://packliste:8080',
  token = process.env.PACKLISTE_TOKEN || '',
  user = process.env.PACKLISTE_USER || 'Wochenplan',
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(url).replace(/\/+$/, '') + '/api/svc';

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-User': encodeURIComponent(user) === user ? user : 'Wochenplan',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(`Packliste nicht erreichbar (${url}): ${err.cause?.code || err.message}`);
    }
    let data = {};
    try { data = await res.json(); } catch { /* leer */ }
    if (res.status === 401) throw new Error('Packliste: Token falsch oder fehlt (PACKLISTE_TOKEN).');
    if (!res.ok) throw new Error(`Packliste: ${data.error || 'Fehler ' + res.status}`);
    return data;
  }

  const enc = encodeURIComponent;
  return {
    backend: 'packliste',
    label: `Packliste (${url})`,
    async login() {
      if (!token) throw new Error('PACKLISTE_TOKEN fehlt. Den Token aus data/SERVICE-TOKEN.txt der Packliste eintragen.');
      await call('GET', '/lists');
    },
    loadLists: () => call('GET', '/lists'),
    getItems: (listUuid) => call('GET', `/lists/${enc(listUuid)}/items`),
    saveItem: (listUuid, name, specification = '') =>
      call('POST', `/lists/${enc(listUuid)}/items`, { name, specification }),
    removeItem: (listUuid, name) => call('DELETE', `/lists/${enc(listUuid)}/items/${enc(name)}`),
    moveToRecentList: (listUuid, name) => call('POST', `/lists/${enc(listUuid)}/items/${enc(name)}/done`),
  };
}
