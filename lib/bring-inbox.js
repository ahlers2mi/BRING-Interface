// Bring als Eingang, wenn die Einkaufsliste in der Packliste („Abgehakt“) liegt.
//
// Alexa kennt nur Bring („Alexa, setz Milch auf die Einkaufsliste“). Mit
// SHOPPING_BACKEND=packliste schaut dieser Abgleich regelmäßig in die
// Bring-Liste, die Alexa benutzt, schreibt neue Artikel in die Packliste und
// nimmt sie danach aus Bring heraus. Bring bleibt so leer und dient nur als
// Briefkasten.
//
//   BRING_INBOX=0                  abschalten (Standard: an, sobald SHOPPING_BACKEND=packliste)
//   BRING_INBOX_LIST=<uuid>        Bring-Liste; Standard: Alexas Standardliste aus den Bring-Einstellungen
//   BRING_INBOX_TARGET=<id>        Ziel-Liste in der Packliste; Standard: lastListUuid bzw. erste Liste
//   BRING_INBOX_SECONDS=60         Abfrageintervall

/**
 * Ein Durchlauf: alles Offene aus der Bring-Liste in die Packliste übernehmen
 * und danach aus Bring entfernen. Erst nach erfolgreichem Speichern wird in
 * Bring gelöscht – bei einem Fehler bleibt der Artikel in Bring und kommt beim
 * nächsten Durchlauf erneut.
 */
export async function runInboxOnce({ bring, target, inboxList, targetList, log = () => {} }) {
  const data = await bring.getItems(inboxList);
  const items = data?.purchase || [];
  const moved = [];
  const failed = [];
  for (const it of items) {
    const name = String(it.name || '').trim();
    if (!name) continue;
    const spec = String(it.specification || '').trim();
    try {
      await target.saveItem(targetList, name, spec);
      await bring.removeItem(inboxList, it.name);
      moved.push(spec ? `${name} (${spec})` : name);
    } catch (err) {
      failed.push({ name, error: err.message });
    }
  }
  if (moved.length) log(`Bring-Eingang: ${moved.join(', ')} → Packliste`);
  if (failed.length) log(`Bring-Eingang: ${failed.length} Fehler – ${failed.map((f) => f.name + ': ' + f.error).join('; ')}`);
  return { moved, failed };
}

/** Bring-Liste bestimmen, in die Alexa schreibt. */
export async function findInboxList(bring) {
  if (process.env.BRING_INBOX_LIST) return process.env.BRING_INBOX_LIST;
  try {
    const s = await bring.getUserSettings();
    const hit = (s?.usersettings || []).find((x) => x.key === 'alexaDefaultList')
      || (s?.usersettings || []).find((x) => x.key === 'defaultListUUID');
    if (hit?.value) return hit.value;
  } catch { /* weiter mit erster Liste */ }
  const { lists } = await bring.loadLists();
  return lists?.[0]?.listUuid;
}

export function startBringInbox({ makeBring, target, getTargetList, log = console.log }) {
  const seconds = Math.max(20, Number(process.env.BRING_INBOX_SECONDS) || 60);
  let bring = null;
  let inboxList = null;
  let running = false;
  let lastError = '';
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!bring) { bring = makeBring(); await bring.login(); }
      if (!inboxList) {
        inboxList = await findInboxList(bring);
        log(`Bring-Eingang aktiv: Bring-Liste ${inboxList} → Packliste, alle ${seconds} s`);
      }
      const targetList = await getTargetList();
      await runInboxOnce({ bring, target, inboxList, targetList, log });
      lastError = '';
    } catch (err) {
      if (err.message !== lastError) log(`Bring-Eingang fehlgeschlagen: ${err.message}`);
      lastError = err.message;
      bring = null; // beim nächsten Mal neu anmelden
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, seconds * 1000).unref();
}
