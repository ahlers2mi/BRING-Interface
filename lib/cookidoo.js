// Cookidoo (Thermomix) als zweite Rezeptquelle.
//
// Gesprochen wird nicht mit Cookidoo selbst, sondern mit dem Sidecar-Dienst in
// `cookidoo-bridge/` – Cookidoo hat keine offizielle Schnittstelle, und die
// nachgebaute Anmeldung steckt in einer gepflegten Python-Bibliothek. Hier bleibt
// dadurch nur schlichtes JSON übrig.
//
// Gespiegelt werden Name, Zutaten, Zeiten, Bild und der Link zurück nach
// Cookidoo – gekocht wird am Gerät. Damit landen die Rezepte im Würfeltopf und
// ihre Zutaten im Bring-Wocheneinkauf.

const TIMEOUT_MS = Number(process.env.COOKIDOO_TIMEOUT_MS || 45000);

export function cookidooConfig() {
  const url = String(process.env.COOKIDOO_URL || '').replace(/\/+$/, '');
  return {
    url,
    token: process.env.COOKIDOO_TOKEN || '',
    enabled: Boolean(url),
    // Welche Sammlungen in den Würfeltopf wandern: `custom` = die eigenen
    // Listen, `managed` = gekaufte/kuratierte, `all` = beides.
    kind: process.env.COOKIDOO_COLLECTIONS || 'custom',
    // Optional auf Namen einschränken, z. B. "Wochenplan,Lieblinge".
    only: String(process.env.COOKIDOO_ONLY || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    syncMinutes: Math.max(5, Number(process.env.COOKIDOO_SYNC_MINUTES || 180)),
  };
}

export function cookidooEnabled() {
  return cookidooConfig().enabled;
}

async function bridgeFetch(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const cfg = cookidooConfig();
  if (!cfg.enabled) throw new Error('Cookidoo ist nicht konfiguriert (COOKIDOO_URL).');

  const res = await fetchImpl(`${cfg.url}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(cfg.token ? { 'X-Bridge-Token': cfg.token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keine JSON-Antwort – Meldung unten */
  }

  if (res.status === 401) {
    throw new Error('Die Cookidoo-Brücke lehnt den Token ab – COOKIDOO_TOKEN prüfen.');
  }
  if (!res.ok) {
    throw new Error(
      data?.error || `Cookidoo-Brücke antwortet mit HTTP ${res.status} bei ${path}`
    );
  }
  return data;
}

export function cookidooCheck({ fetchImpl = fetch } = {}) {
  return bridgeFetch('/check', { fetchImpl });
}

// ── Umrechnen ─────────────────────────────────────────────────────────────────

// Cookidoo liefert Sekunden.
export function minutesText(seconds) {
  const total = Math.round(Number(seconds || 0) / 60);
  if (!Number.isFinite(total) || total <= 0) return '';
  if (total < 60) return `${total} Min.`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} Std. ${rest} Min.` : `${hours} Std.`;
}

export function mapCookidooRecipe(payload) {
  if (!payload || !payload.id || !payload.name) return null;

  const ingredients = (payload.ingredients || [])
    .map((ing) => ({
      name: String(ing?.name || '').trim(),
      // Bei Cookidoo steht die Menge in `description` ("200 g", "2 Stück").
      amount: String(ing?.description || '').trim(),
    }))
    .filter((ing) => ing.name);

  const times = [
    payload.active_time ? `${minutesText(payload.active_time)} aktiv` : '',
    minutesText(payload.total_time),
  ].filter(Boolean);

  const notes = (payload.notes || []).filter(Boolean).join('\n');
  // Die Schritt-für-Schritt-Anleitung gibt Cookidoo nicht heraus (geführtes
  // Kochen läuft nur am Gerät) – deshalb der Verweis statt eines leeren Felds.
  const instructions = payload.custom
    ? notes
    : [notes, 'Zubereitung: geführtes Kochen in Cookidoo bzw. am Thermomix.']
        .filter(Boolean)
        .join('\n\n');

  return {
    name: String(payload.name).trim().slice(0, 200),
    description: payload.difficulty ? `Schwierigkeit: ${payload.difficulty}` : '',
    source_url: String(payload.url || ''),
    instructions,
    prep_time: times.join(' · '),
    servings:
      Number(payload.serving_size) > 0 ? `${Number(payload.serving_size)} Portionen` : '',
    image_url: String(payload.image || ''),
    tags: ['Thermomix', ...(payload.categories || [])].filter(Boolean).slice(0, 12),
    ingredients,
    source: 'cookidoo',
    external_id: `cookidoo:${payload.id}`,
    source_slug: String(payload.id),
    source_updated_at: '',
  };
}

// ── Abgleich ──────────────────────────────────────────────────────────────────

let syncState = {
  status: 'idle', // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  added: 0,
  updated: 0,
  missing: 0,
  failed: 0,
  total: 0,
  collections: [],
  error: null,
};

export function getCookidooState() {
  const cfg = cookidooConfig();
  return { ...syncState, enabled: cfg.enabled, kind: cfg.kind, only: cfg.only };
}

export function resetCookidooState() {
  syncState = { ...syncState, status: 'idle', error: null };
}

// Rezept-Ids aus den gewählten Sammlungen sammeln – doppelte Rezepte in mehreren
// Sammlungen zählen einmal.
export function collectRecipeIds(collections, only = []) {
  const wanted = new Set(only.map((s) => s.toLowerCase()));
  const ids = new Map(); // id -> Name der ersten Sammlung
  for (const coll of collections || []) {
    if (wanted.size && !wanted.has(String(coll.name || '').toLowerCase())) continue;
    for (const recipe of coll.recipes || []) {
      if (recipe?.id && !ids.has(recipe.id)) ids.set(recipe.id, coll.name);
    }
  }
  return ids;
}

// `deps`: { upsertRecipeFromSource, markRecipesMissing }
export async function syncFromCookidoo({ deps, fetchImpl = fetch, chunk = 40 } = {}) {
  if (syncState.status === 'running') return getCookidooState();
  const cfg = cookidooConfig();
  if (!cfg.enabled) throw new Error('Cookidoo ist nicht konfiguriert (COOKIDOO_URL).');

  syncState = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    added: 0,
    updated: 0,
    missing: 0,
    failed: 0,
    total: 0,
    collections: [],
    error: null,
  };

  try {
    const { collections } = await bridgeFetch(`/collections?kind=${cfg.kind}`, {
      fetchImpl,
    });
    const ids = collectRecipeIds(collections, cfg.only);
    syncState.total = ids.size;
    syncState.collections = (collections || []).map((c) => ({
      name: c.name,
      kind: c.kind,
      recipes: (c.recipes || []).length,
    }));

    const seen = [];
    const list = [...ids.keys()];
    for (let i = 0; i < list.length; i += chunk) {
      const { items, failed } = await bridgeFetch('/recipes/details', {
        method: 'POST',
        body: { ids: list.slice(i, i + chunk) },
        fetchImpl,
      });
      syncState.failed += (failed || []).length;

      for (const payload of items || []) {
        const recipe = mapCookidooRecipe(payload);
        if (!recipe) continue;
        const before = deps.findRecipeByExternalId?.(recipe.external_id);
        deps.upsertRecipeFromSource(recipe);
        seen.push(recipe.external_id);
        if (before) syncState.updated += 1;
        else syncState.added += 1;
      }
    }

    syncState.missing = deps.markRecipesMissing('cookidoo:', seen);
    syncState.status = 'done';
  } catch (err) {
    syncState.status = 'error';
    syncState.error = err.message;
  }
  syncState.finishedAt = new Date().toISOString();
  return getCookidooState();
}

// ── Einkaufsliste ─────────────────────────────────────────────────────────────

// Cookidoos eigene Einkaufsliste als Bring-taugliche Einträge. Abgehakte bzw.
// als vorhanden markierte Sachen (`is_owned`) bleiben draußen.
export async function cookidooShoppingItems({ fetchImpl = fetch, all = false } = {}) {
  const data = await bridgeFetch('/shopping', { fetchImpl });
  const take = (list) =>
    (list || [])
      .filter((item) => all || !item.is_owned)
      .map((item) => ({
        name: String(item.name || '').trim(),
        amount: String(item.description || '').trim(),
      }))
      .filter((item) => item.name);

  return {
    items: [...take(data?.ingredients), ...take(data?.additional)],
    recipes: (data?.recipes || []).map((r) => r.name),
  };
}
