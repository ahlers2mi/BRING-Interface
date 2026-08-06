// Anbindung an Mealie (https://mealie.io) als Rezeptquelle.
//
// Mealie ist die Wahrheit für Rezepte – gepflegt wird dort. Diese App hält
// einen lokalen Spiegel, weil Bewertungen und Wochenplan per Fremdschlüssel auf
// `recipes.id` zeigen und Würfeln/Reste-Suche in SQL über die Zutaten rechnen.
// Der Spiegel wird beim Start, im Intervall und auf Knopfdruck abgeglichen.
//
// Zurück nach Mealie geschrieben werden nur `rating` und `lastMade` – und das
// nur best-effort, ein Fehler dort darf die Bewertung hier nicht verhindern.

import { formatAmountNumber } from './normalize.js';
import {
  discoverChefkochCandidates,
  filterChefkochByRating,
} from './recipe-import.js';

const TIMEOUT_MS = Number(process.env.MEALIE_TIMEOUT_MS || 20000);

export function mealieConfig() {
  const base = String(process.env.MEALIE_URL || '').trim().replace(/\/+$/, '');
  // Adresse für Links im Browser. `MEALIE_URL` zeigt bei einer gemeinsamen Stack
  // auf den Dienstnamen (http://mealie:9000) – im Browser unerreichbar. Deshalb
  // getrennt, mit dem BASE_URL des Mealie-Containers als naheliegendem Standard.
  const publicBase = String(
    process.env.MEALIE_PUBLIC_URL || process.env.MEALIE_BASE_URL || base || ''
  )
    .trim()
    .replace(/\/+$/, '');
  return {
    enabled: Boolean(base && process.env.MEALIE_TOKEN),
    url: base,
    publicUrl: publicBase,
    token: process.env.MEALIE_TOKEN || '',
    syncMinutes: Math.max(1, Number(process.env.MEALIE_SYNC_MINUTES || 15)),
    pushRatings: process.env.MEALIE_PUSH_RATINGS !== '0',
    // Adresse eines Rezepts in der Mealie-Oberfläche. Ältere Versionen nutzen
    // {base}/recipe/{slug}.
    recipeUrlPattern:
      process.env.MEALIE_RECIPE_URL || '{base}/g/home/r/{slug}',
  };
}

export function mealieEnabled() {
  return mealieConfig().enabled;
}

export function mealieRecipeUrl(slug) {
  const cfg = mealieConfig();
  if (!cfg.enabled || !slug) return '';
  return cfg.recipeUrlPattern
    .replace('{base}', cfg.publicUrl || cfg.url)
    .replace('{slug}', slug);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function mealieFetch(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const cfg = mealieConfig();
  if (!cfg.enabled) throw new Error('Mealie ist nicht konfiguriert (MEALIE_URL/MEALIE_TOKEN).');

  const res = await fetchImpl(`${cfg.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Mealie lehnt den Token ab (HTTP ${res.status}). MEALIE_TOKEN prüfen – ` +
        'der Token wird in Mealie unter „Manage Your API Tokens" erzeugt.'
    );
  }
  if (!res.ok) {
    throw new Error(`Mealie-Fehler (HTTP ${res.status}) bei ${path}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Kurzer Verbindungstest für die Oberfläche.
export async function mealieAbout({ fetchImpl = fetch } = {}) {
  const about = await mealieFetch('/api/app/about', { fetchImpl });
  return { version: about?.version || 'unbekannt' };
}

export function fetchRecipePage({ page = 1, perPage = 100, fetchImpl = fetch } = {}) {
  return mealieFetch(
    `/api/recipes?page=${page}&perPage=${perPage}&orderBy=updatedAt&orderDirection=desc`,
    { fetchImpl }
  );
}

export function fetchRecipeDetail(slug, { fetchImpl = fetch } = {}) {
  return mealieFetch(`/api/recipes/${encodeURIComponent(slug)}`, { fetchImpl });
}

// ── Abbildung auf unser Rezeptformat ──────────────────────────────────────────

function instructionsOf(detail) {
  const steps = (detail.recipeInstructions || [])
    .map((step) => (typeof step === 'string' ? step : step?.text || ''))
    .map((text) => String(text).trim())
    .filter(Boolean);
  return steps.map((step, i) => (/^\d+\./.test(step) ? step : `${i + 1}. ${step}`)).join('\n');
}

function timeOf(detail) {
  const total = String(detail.totalTime || '').trim();
  if (total) return total;
  const parts = [detail.prepTime, detail.performTime, detail.cookTime]
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  return parts.join(' + ');
}

function servingsOf(detail) {
  const yieldText = String(detail.recipeYield || '').trim();
  if (yieldText) return yieldText;
  const servings = Number(detail.recipeServings);
  return Number.isFinite(servings) && servings > 0 ? `${servings} Portionen` : '';
}

function imageOf(detail, base) {
  if (!detail.image || !detail.id) return '';
  return `${base}/api/media/recipes/${detail.id}/images/min-original.webp`;
}

function tagsOf(detail) {
  const names = [
    ...(detail.tags || []),
    ...(detail.recipeCategory || []),
  ]
    .map((t) => (typeof t === 'string' ? t : t?.name || ''))
    .map((t) => String(t).trim())
    .filter(Boolean);
  return [...new Set(names)].slice(0, 12);
}

// Mealie-Zutat -> {name, amount}.
// Bevorzugt die strukturierten Felder (food/unit/quantity); Mealie erlaubt aber
// auch reine Freitext-Zutaten, dann steht alles in `note` bzw. `display`.
export function mapMealieIngredient(ing) {
  if (!ing) return null;
  const unit = ing.unit?.abbreviation || ing.unit?.name || '';
  const amount = [formatAmountNumber(ing.quantity), String(unit).trim()]
    .filter(Boolean)
    .join(' ')
    .trim();

  const food = String(ing.food?.name || '').trim();
  const note = String(ing.note || '').trim();

  if (food) {
    // Anmerkungen wie "gewürfelt" hängen wir an – für die Reste-Suche werden
    // solche Beiworte ohnehin herausgefiltert.
    return { name: note ? `${food}, ${note}` : food, amount };
  }
  const fallback = note || String(ing.display || '').trim();
  if (!fallback) return null;
  // Ohne strukturierte Menge steckt sie oft im Text – der bleibt dann stehen.
  return { name: fallback, amount };
}

// Vollständiges Mealie-Rezept -> unser Format (wie `createRecipe` es erwartet).
export function mapMealieRecipe(detail, baseUrl = '') {
  if (!detail || !detail.id || !detail.name) return null;
  const base = String(baseUrl || mealieConfig().url || '').replace(/\/+$/, '');

  const ingredients = (detail.recipeIngredient || [])
    .map(mapMealieIngredient)
    .filter((ing) => ing && ing.name);

  return {
    name: String(detail.name).trim().slice(0, 200),
    description: String(detail.description || '').trim().slice(0, 1000),
    source_url: String(detail.orgURL || '').trim(),
    instructions: instructionsOf(detail),
    prep_time: timeOf(detail),
    servings: servingsOf(detail),
    image_url: imageOf(detail, base),
    tags: tagsOf(detail),
    ingredients,
    source: 'mealie',
    external_id: `mealie:${detail.id}`,
    source_slug: detail.slug || '',
    source_updated_at: String(detail.updatedAt || detail.dateUpdated || ''),
  };
}

// ── Abgleich ──────────────────────────────────────────────────────────────────

let syncState = {
  status: 'idle', // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  added: 0,
  updated: 0,
  unchanged: 0,
  missing: 0,
  total: 0,
  error: null,
  version: null,
};

export function getSyncState() {
  const cfg = mealieConfig();
  return {
    ...syncState,
    enabled: cfg.enabled,
    url: cfg.url,
    publicUrl: cfg.publicUrl || cfg.url,
  };
}

// Holt alle Rezepte aus Mealie und spiegelt sie in die lokale Datenbank.
// Details werden nur für neue oder geänderte Rezepte geladen (Vergleich über
// `updatedAt`), damit auch 500 Rezepte kein Problem sind.
// `deps`: { upsertRecipeFromSource, getSourceIndex, markRecipesMissing }
export async function syncFromMealie({ deps, fetchImpl = fetch, perPage = 100 } = {}) {
  if (syncState.status === 'running') return getSyncState();
  if (!mealieEnabled()) throw new Error('Mealie ist nicht konfiguriert.');

  syncState = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    added: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    total: 0,
    error: null,
    version: syncState.version,
  };

  try {
    const { version } = await mealieAbout({ fetchImpl });
    syncState.version = version;

    const index = deps.getSourceIndex('mealie:'); // external_id -> {id, source_updated_at}
    const seen = new Set();
    const base = mealieConfig().url;

    for (let page = 1; ; page += 1) {
      const data = await fetchRecipePage({ page, perPage, fetchImpl });
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) break;
      syncState.total += items.length;

      for (const item of items) {
        if (!item?.id) continue;
        const key = `mealie:${item.id}`;
        seen.add(key);
        const stamp = String(item.updatedAt || item.dateUpdated || '');
        const known = index.get(key);

        if (known && stamp && known.source_updated_at === stamp) {
          syncState.unchanged += 1;
          continue;
        }
        const detail = await fetchRecipeDetail(item.slug || item.id, { fetchImpl });
        const recipe = mapMealieRecipe(detail, base);
        if (!recipe) continue;
        deps.upsertRecipeFromSource(recipe);
        if (known) syncState.updated += 1;
        else syncState.added += 1;
      }

      const totalPages = Number(data.total_pages ?? data.totalPages ?? 0);
      if (totalPages && page >= totalPages) break;
      if (items.length < perPage) break;
    }

    // In Mealie gelöschte Rezepte bleiben hier stehen (Bewertungen und
    // Plan-Historie hängen daran), werden aber markiert und nicht mehr
    // gewürfelt.
    syncState.missing = deps.markRecipesMissing('mealie:', [...seen]);
    syncState.status = 'done';
  } catch (err) {
    syncState.status = 'error';
    syncState.error = err.message;
  } finally {
    syncState.finishedAt = new Date().toISOString();
  }
  return getSyncState();
}

// Rezept in Mealie löschen. Der Weg über die API ist verlässlich – in der
// Mealie-Oberfläche ist das Löschen einzelner Rezepte je nach Version schwer zu
// finden oder defekt.
export async function deleteRecipeInMealie(slug, { fetchImpl = fetch } = {}) {
  await mealieFetch(`/api/recipes/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    fetchImpl,
  });
  return true;
}

// ── Rezepte von Chefkoch nach Mealie schieben ─────────────────────────────────

// Eine URL an Mealies Importer geben. Mealie liest die Seite selbst (dort steckt
// der gepflegte recipe-scrapers-Fundus) und legt das Rezept an.
export async function importUrlToMealie(url, { fetchImpl = fetch } = {}) {
  const created = await mealieFetch('/api/recipes/create/url', {
    method: 'POST',
    body: { url, includeTags: true },
    fetchImpl,
  });
  // Mealie antwortet mit dem Slug (als String oder Objekt, je nach Version).
  return typeof created === 'string' ? created : created?.slug || created?.id || '';
}

let chefkochJob = null;

export function getChefkochJob() {
  if (!chefkochJob) return null;
  const { cancelled, ...rest } = chefkochJob;
  return { ...rest, log: chefkochJob.log.slice(-40) };
}

export function cancelChefkochJob() {
  if (chefkochJob && chefkochJob.status === 'running') {
    chefkochJob.cancelled = true;
    chefkochJob.log.push('Abbruch angefordert …');
    return true;
  }
  return false;
}

// Sucht Rezepte auf Chefkoch und lässt Mealie sie importieren; am Ende wird der
// Spiegel abgeglichen. `deps.findRecipeBySourceUrlPart` verhindert Dubletten
// (Rezepte, die über diesen Weg schon da sind).
export function startChefkochToMealieJob({
  query = '',
  count = 20,
  minRating = 0,
  minVotes = 0,
  deps,
  fetchImpl = fetch,
}) {
  if (chefkochJob && chefkochJob.status === 'running') {
    throw new Error('Es läuft bereits ein Import. Bitte warten oder abbrechen.');
  }
  if (!mealieEnabled()) throw new Error('Mealie ist nicht konfiguriert.');

  const job = {
    id: `ck2mealie-${Date.now()}`,
    status: 'running',
    query,
    requested: Math.max(1, Math.min(500, Number(count) || 20)),
    minRating: Number(minRating) || 0,
    minVotes: Number(minVotes) || 0,
    total: 0,
    done: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    log: [],
    cancelled: false,
  };
  chefkochJob = job;
  const log = (msg) => {
    job.log.push(msg);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };
  const delay = Number(process.env.IMPORT_DELAY_MS || 250);

  (async () => {
    try {
      log(
        `Suche ${job.requested} Rezepte auf Chefkoch${query ? ` zu "${query}"` : ''}` +
          `${job.minRating ? `, mindestens ${job.minRating}★` : ''}` +
          `${job.minVotes ? ` bei ${job.minVotes}+ Stimmen` : ''} …`
      );
      const candidates = await discoverChefkochCandidates({
        query,
        count: job.minRating || job.minVotes ? job.requested * 3 : job.requested,
        fetchImpl,
        log,
      });
      const ids = (
        await filterChefkochByRating(candidates, {
          minRating: job.minRating,
          minVotes: job.minVotes,
          fetchImpl,
          log,
        })
      ).slice(0, job.requested);
      job.total = ids.length;
      if (!ids.length) {
        throw new Error(
          'Keine Rezepte gefunden. Prüfe den Suchbegriff und ob der Server chefkoch.de erreichen darf.'
        );
      }
      log(`${ids.length} Rezepte gefunden, übergebe sie an Mealie …`);

      for (const id of ids) {
        if (job.cancelled) break;
        const url = `https://www.chefkoch.de/rezepte/${id}/`;
        try {
          if (deps.findRecipeBySourceUrlPart(`/rezepte/${id}/`)) {
            job.skipped += 1;
          } else {
            await importUrlToMealie(url, { fetchImpl });
            job.imported += 1;
            if (job.imported % 5 === 0) log(`${job.imported} Rezepte in Mealie angelegt …`);
          }
        } catch (err) {
          job.failed += 1;
          log(`Rezept ${id} fehlgeschlagen: ${err.message}`);
        }
        job.done += 1;
        await new Promise((r) => setTimeout(r, delay));
      }

      log('Gleiche den Spiegel ab …');
      const state = await syncFromMealie({ deps, fetchImpl });
      job.status = job.cancelled ? 'cancelled' : 'done';
      log(
        `Fertig: ${job.imported} in Mealie angelegt, ${job.skipped} übersprungen, ` +
          `${job.failed} fehlgeschlagen. Abgleich: ${state.added} neu.`
      );
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      log(`Fehler: ${err.message}`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return getChefkochJob();
}

// Bewertung nach Mealie zurückschreiben (rating 1–5, lastMade als Datum).
// Fehler werden nur protokolliert – die lokale Bewertung steht schon.
export async function pushRatingToMealie(
  { slug, rating, lastMade },
  { fetchImpl = fetch } = {}
) {
  const cfg = mealieConfig();
  if (!cfg.enabled || !cfg.pushRatings || !slug) return false;
  const payload = {};
  if (Number.isFinite(Number(rating))) payload.rating = Number(rating);
  if (lastMade) payload.lastMade = `${lastMade}T12:00:00.000Z`;
  if (!Object.keys(payload).length) return false;

  try {
    await mealieFetch(`/api/recipes/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: payload,
      fetchImpl,
    });
    return true;
  } catch (err) {
    console.warn(`Mealie: Bewertung konnte nicht zurückgeschrieben werden: ${err.message}`);
    return false;
  }
}
