// Hintergrundlauf: Rezepte von einer Übersichtsseite einsammeln und anlegen.
//
// Zwei Betriebsarten, je nachdem wie die App eingerichtet ist:
//   - Mealie an  -> die gefundene Adresse geht an Mealies eigenen Importer
//     (/api/recipes/create/url). Der bringt den gepflegten recipe-scrapers-
//     Fundus mit und kann mehr Seiten als wir. Danach Spiegel abgleichen.
//   - Mealie aus -> das beim Prüfen schon gelesene schema.org-Rezept wird
//     direkt lokal angelegt; ein zweiter Abruf wäre Verschwendung.
//
// `dryRun` läuft alles bis vor das Anlegen und meldet nur, was gefunden wurde.
// Das ist der ehrliche Weg, eine unbekannte Seite auszuprobieren.

import { discoverCandidates, verifyRecipeUrls } from './site-import.js';
import { importUrlToMealie, mealieEnabled, syncFromMealie } from './mealie.js';

let job = null;

export function getSiteJob() {
  if (!job) return null;
  const { cancelled, ...rest } = job;
  return { ...rest, log: job.log.slice(-60) };
}

export function cancelSiteJob() {
  if (job && job.status === 'running') {
    job.cancelled = true;
    job.log.push('Abbruch angefordert …');
    return true;
  }
  return false;
}

export function startSiteImportJob({
  url,
  count = 20,
  pages = 3,
  dryRun = false,
  deps,
  fetchImpl = fetch,
}) {
  if (job && job.status === 'running') {
    throw new Error('Es läuft bereits ein Import. Bitte warten oder abbrechen.');
  }
  let start;
  try {
    start = new URL(url);
  } catch {
    throw new Error('Bitte eine vollständige http(s)-Adresse angeben.');
  }
  if (!/^https?:$/.test(start.protocol)) {
    throw new Error('Bitte eine vollständige http(s)-Adresse angeben.');
  }

  const delay = Number(process.env.IMPORT_DELAY_MS || 250);
  const toMealie = mealieEnabled();

  job = {
    id: `site-${Date.now()}`,
    status: 'running',
    url: start.toString(),
    host: start.host,
    dryRun: Boolean(dryRun),
    target: toMealie ? 'mealie' : 'lokal',
    requested: Math.max(1, Math.min(200, Number(count) || 20)),
    pages: Math.max(1, Math.min(20, Number(pages) || 3)),
    candidates: 0,
    total: 0,
    done: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    found: [], // Namen für die Vorschau
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    log: [],
    cancelled: false,
  };
  const log = (msg) => {
    job.log.push(msg);
    if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
  };

  (async () => {
    try {
      log(`Lese ${job.url} …`);
      const candidates = await discoverCandidates({
        url: job.url,
        maxPages: job.pages,
        // Großzügig suchen: es sind längst nicht alle Links Rezepte.
        maxCandidates: job.requested * 4,
        fetchImpl,
        delayMs: delay,
        log,
      });
      job.candidates = candidates.length;
      if (!candidates.length) {
        throw new Error(
          'Auf der Seite wurden keine Links gefunden, die ein Rezept sein könnten. ' +
            'Ist es wirklich eine Übersichtsseite – und darf der Server sie erreichen?'
        );
      }

      log(`${candidates.length} Adressen gefunden, prüfe welche davon Rezepte sind …`);
      const hits = await verifyRecipeUrls(candidates, {
        fetchImpl,
        delayMs: delay,
        limit: job.requested,
        log,
        isCancelled: () => job.cancelled,
      });
      job.total = hits.length;
      job.found = hits.map((h) => h.recipe.name);
      if (!hits.length) {
        throw new Error(
          'Keine der Seiten enthält maschinenlesbare Rezeptdaten (schema.org). ' +
            'Diese Seite lässt sich so nicht einlesen.'
        );
      }

      if (job.dryRun) {
        job.status = 'done';
        log(`Probelauf: ${hits.length} Rezepte gefunden, nichts angelegt.`);
        return;
      }

      for (const hit of hits) {
        if (job.cancelled) break;
        try {
          // Schon da? Die Quell-Adresse ist der verlässlichste Schlüssel.
          const key = new URL(hit.url).pathname;
          if (deps.findRecipeBySourceUrlPart(key) || deps.findRecipeByName(hit.recipe.name)) {
            job.skipped += 1;
          } else if (toMealie) {
            await importUrlToMealie(hit.url, { fetchImpl });
            job.imported += 1;
          } else {
            deps.createRecipe({ ...hit.recipe, source: 'web' });
            job.imported += 1;
          }
        } catch (err) {
          job.failed += 1;
          log(`${hit.url}: ${err.message}`);
        }
        job.done += 1;
        await new Promise((r) => setTimeout(r, delay));
      }

      if (toMealie && job.imported) {
        log('Gleiche den Spiegel ab …');
        const state = await syncFromMealie({ deps, fetchImpl });
        log(`Abgleich: ${state.added} neu, ${state.updated} aktualisiert.`);
      }

      job.status = job.cancelled ? 'cancelled' : 'done';
      log(
        `Fertig: ${job.imported} importiert, ${job.skipped} schon vorhanden, ` +
          `${job.failed} fehlgeschlagen.`
      );
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      log(`Fehler: ${err.message}`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return getSiteJob();
}
