// Rezept-Import: einzelne URLs und Massenimport von Chefkoch.
//
// Drei Wege, absteigend nach Zuverlässigkeit:
//  1. Chefkoch-JSON-API (api.chefkoch.de/v2) – Suche + Rezeptdetails
//  2. schema.org-JSON-LD aus der HTML-Seite (funktioniert auch bei anderen
//     Rezeptseiten und ist der Fallback, wenn die API sich ändert)
//  3. Nur beim Einzelimport: KI-Analyse des Seitentexts (siehe server.js)
//
// Alle Parser sind reine Funktionen und ohne Netz testbar.

import { formatAmountNumber, splitAmount } from './normalize.js';
import { fetchOrExplain } from './neterror.js';

// Derselbe Name wie im Seiten-Sammler (site-import.js). Vorher stand hier ein
// reiner Eigenname ohne "Mozilla/5.0" – manche Schutzschilde (Cloudflare & Co.)
// trennen die Verbindung dann wortlos, was in Node als nacktes "fetch failed"
// ankommt. Aufgefallen ist es an gaumenfreundin.de: die Übersichtsseite ging
// über den Seiten-Sammler, dasselbe Rezept einzeln nicht.
export const USER_AGENT =
  process.env.IMPORT_USER_AGENT ||
  'Mozilla/5.0 (compatible; BRING-Interface/1.0; +private use)';
const REQUEST_DELAY_MS = Number(process.env.IMPORT_DELAY_MS || 250);
const REQUEST_TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS || 20000);
const CONCURRENCY = Math.max(1, Number(process.env.IMPORT_CONCURRENCY || 3));

const CHEFKOCH_API = 'https://api.chefkoch.de/v2';
const CHEFKOCH_WEB = 'https://www.chefkoch.de';

// ── kleine Helfer ─────────────────────────────────────────────────────────────

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  deg: '°',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
};

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

export function stripHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ISO-8601-Dauer ("PT1H30M") -> Minuten.
export function parseIsoDuration(value) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    String(value || '').trim()
  );
  if (!m) return null;
  const [, d, h, min] = m;
  const total = (Number(d || 0) * 24 * 60) + Number(h || 0) * 60 + Number(min || 0);
  return total > 0 ? total : null;
}

export function formatMinutes(minutes) {
  const min = Number(minutes);
  if (!Number.isFinite(min) || min <= 0) return '';
  if (min < 60) return `ca. ${min} Min.`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `ca. ${h} Std. ${rest} Min.` : `ca. ${h} Std.`;
}

function uniqueTags(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values.flat()) {
    if (raw === null || raw === undefined) continue;
    for (const part of String(raw).split(',')) {
      const tag = part.trim();
      if (!tag || tag.length > 30) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out.slice(0, 12);
}

// ── JSON-LD (schema.org/Recipe) ───────────────────────────────────────────────

// Alle JSON-LD-Blöcke einer Seite einsammeln und flach machen (@graph, Arrays).
export function collectJsonLdNodes(html) {
  const nodes = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(decodeEntities(match[1].trim()));
    } catch {
      continue; // kaputte Blöcke überspringen
    }
    const stack = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
      } else if (node && typeof node === 'object') {
        nodes.push(node);
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
      }
    }
  }
  return nodes;
}

function isRecipeNode(node) {
  const type = node?.['@type'];
  if (!type) return false;
  const list = Array.isArray(type) ? type : [type];
  return list.some((t) => String(t).toLowerCase() === 'recipe');
}

function jsonLdImage(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return jsonLdImage(image[0]);
  if (typeof image === 'object') return image.url || image.contentUrl || '';
  return '';
}

function jsonLdInstructions(value) {
  if (!value) return '';
  if (typeof value === 'string') return stripHtml(value);
  if (Array.isArray(value)) {
    const steps = [];
    for (const item of value) {
      if (typeof item === 'string') {
        steps.push(stripHtml(item));
      } else if (item && typeof item === 'object') {
        if (Array.isArray(item.itemListElement)) {
          const sub = jsonLdInstructions(item.itemListElement);
          if (item.name) steps.push(`${stripHtml(item.name)}:`);
          if (sub) steps.push(sub);
        } else if (item.text) {
          steps.push(stripHtml(item.text));
        } else if (item.name) {
          steps.push(stripHtml(item.name));
        }
      }
    }
    const clean = steps.filter(Boolean);
    // Nur nummerieren, wenn es echte Schritte sind (nicht bei Abschnitten).
    return clean
      .map((step, i) => (/^\d+\./.test(step) || step.endsWith(':') ? step : `${i + 1}. ${step}`))
      .join('\n');
  }
  if (typeof value === 'object') return jsonLdInstructions([value]);
  return '';
}

function jsonLdYield(value) {
  if (!value) return '';
  const first = Array.isArray(value) ? value[0] : value;
  const text = String(first).trim();
  if (!text) return '';
  return /portion|person|stück|gläser|personen/i.test(text) ? text : `${text} Portionen`;
}

// JSON-LD-Knoten -> Rezept im Format dieser App.
export function mapJsonLdRecipe(node, fallbackUrl = '') {
  const ingredients = (Array.isArray(node.recipeIngredient)
    ? node.recipeIngredient
    : node.recipeIngredient
      ? [node.recipeIngredient]
      : []
  )
    .map((line) => splitAmount(stripHtml(line)))
    .filter((ing) => ing.name);

  const minutes =
    parseIsoDuration(node.totalTime) ||
    (parseIsoDuration(node.prepTime) || 0) + (parseIsoDuration(node.cookTime) || 0);

  return {
    name: stripHtml(node.name || '').slice(0, 200),
    description: stripHtml(node.description || '').slice(0, 1000),
    source_url: node.url || node['@id'] || fallbackUrl || '',
    instructions: jsonLdInstructions(node.recipeInstructions),
    prep_time: formatMinutes(minutes),
    servings: jsonLdYield(node.recipeYield),
    image_url: jsonLdImage(node.image),
    tags: uniqueTags([node.keywords || [], node.recipeCategory || [], node.recipeCuisine || []]),
    ingredients,
  };
}

// Erstes Recipe-Objekt einer HTML-Seite als Rezept zurückgeben (oder null).
export function parseRecipeFromHtml(html, url = '') {
  const node = collectJsonLdNodes(html).find(isRecipeNode);
  if (!node) return null;
  const recipe = mapJsonLdRecipe(node, url);
  return recipe.name ? recipe : null;
}

// ── Chefkoch-API ──────────────────────────────────────────────────────────────

// Rezept-Objekt der Chefkoch-API -> Rezept im Format dieser App.
export function mapChefkochApiRecipe(data) {
  if (!data || typeof data !== 'object') return null;
  const groups = Array.isArray(data.ingredientGroups) ? data.ingredientGroups : [];
  const ingredients = [];
  for (const group of groups) {
    for (const ing of group.ingredients || []) {
      const name = stripHtml(ing.name || '').trim();
      if (!name) continue;
      const amount = [formatAmountNumber(ing.amount), (ing.unit || '').trim()]
        .filter(Boolean)
        .join(' ')
        .trim();
      ingredients.push({ name, amount });
    }
  }

  const minutes =
    Number(data.totalTime) ||
    Number(data.preparationTime || 0) +
      Number(data.cookingTime || 0) +
      Number(data.restingTime || 0);

  const tags = uniqueTags([
    (data.tags || []).map((t) => (typeof t === 'string' ? t : t?.title || t?.name)),
    (data.categories || []).map((c) => (typeof c === 'string' ? c : c?.title || c?.name)),
    data.difficulty === 1 ? 'einfach' : data.difficulty === 3 ? 'aufwendig' : [],
  ]);

  const image =
    typeof data.previewImageUrlTemplate === 'string'
      ? data.previewImageUrlTemplate.replace('<format>', 'crop-360x240')
      : '';

  const name = stripHtml(data.title || '').trim();
  if (!name) return null;

  return {
    name: name.slice(0, 200),
    description: stripHtml(data.subtitle || '').slice(0, 1000),
    source_url: data.siteUrl || (data.id ? `${CHEFKOCH_WEB}/rezepte/${data.id}/` : ''),
    instructions: stripHtml(data.instructions || ''),
    prep_time: formatMinutes(minutes),
    servings: data.servings ? `${data.servings} Portionen` : '',
    image_url: image,
    tags,
    ingredients,
    external_id: data.id ? `chefkoch:${data.id}` : null,
    rating: data.rating?.rating ? Number(data.rating.rating) : null,
  };
}

// Rezept-IDs aus einer Chefkoch-Suchergebnisseite (HTML-Fallback).
export function extractChefkochIdsFromHtml(html) {
  const ids = [];
  const seen = new Set();
  const re = /\/rezepte\/(\d{6,})\//g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    ids.push(m[1]);
  }
  return ids;
}

// Suchergebnis der JSON-API -> IDs.
export function extractChefkochIdsFromApi(json) {
  return extractChefkochCandidatesFromApi(json).map((c) => c.id);
}

// Bewertung aus einem Chefkoch-Objekt lesen. Die API liefert je nach Stelle
// `rating: {rating, numVotes}` oder eine nackte Zahl – beides wird akzeptiert.
export function readChefkochRating(recipe) {
  if (!recipe) return { rating: null, votes: null };
  const raw = recipe.rating;
  const value = typeof raw === 'object' && raw !== null ? raw.rating : raw;
  const votesRaw =
    (typeof raw === 'object' && raw !== null
      ? raw.numVotes ?? raw.votes ?? raw.count
      : undefined) ??
    recipe.numVotes ??
    recipe.ratingCount;
  const num = Number(value);
  // Achtung: Number(null) ist 0 – "keine Angabe" muss null bleiben, sonst
  // verwirft der Stimmen-Filter Rezepte, statt die Bewertung nachzuladen.
  const votesNum = Number(votesRaw);
  return {
    rating: Number.isFinite(num) && num > 0 ? num : null,
    votes:
      votesRaw === null || votesRaw === undefined || !Number.isFinite(votesNum)
        ? null
        : votesNum,
  };
}

// Suchergebnis -> Kandidaten inkl. Bewertung, falls die Suche sie mitliefert.
export function extractChefkochCandidatesFromApi(json) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const out = [];
  for (const item of results) {
    const recipe = item?.recipe || item;
    if (!recipe?.id) continue;
    out.push({ id: String(recipe.id), ...readChefkochRating(recipe) });
  }
  return out;
}

// Bewertung eines Rezepts nachladen (nur nötig, wenn die Suche sie nicht liefert).
export async function fetchChefkochRating(id, { fetchImpl = fetch } = {}) {
  try {
    const json = await getJson(`${CHEFKOCH_API}/recipes/${id}`, { fetchImpl });
    return readChefkochRating(json);
  } catch {
    return { rating: null, votes: null };
  }
}

// Kandidaten nach Bewertung sieben. Wo die Bewertung fehlt, wird sie einzeln
// nachgeladen. `unrated` entscheidet, was mit Rezepten ohne Bewertung passiert.
export async function filterChefkochByRating(
  candidates,
  { minRating = 0, minVotes = 0, fetchImpl = fetch, log = () => {}, keepUnrated = false } = {}
) {
  if (!minRating && !minVotes) return candidates.map((c) => c.id);

  const kept = [];
  let dropped = 0;
  for (const candidate of candidates) {
    let { rating, votes } = candidate;
    if (rating === null || (minVotes && votes === null)) {
      const fetched = await fetchChefkochRating(candidate.id, { fetchImpl });
      rating = rating ?? fetched.rating;
      votes = votes ?? fetched.votes;
      await sleep(REQUEST_DELAY_MS);
    }
    if (rating === null) {
      if (keepUnrated) kept.push(candidate.id);
      else dropped += 1;
      continue;
    }
    if (rating < minRating || (minVotes && (votes ?? 0) < minVotes)) {
      dropped += 1;
      continue;
    }
    kept.push(candidate.id);
  }
  if (dropped) {
    log(
      `${dropped} Rezepte wegen der Bewertung übersprungen ` +
        `(mindestens ${minRating}★${minVotes ? ` bei ${minVotes}+ Stimmen` : ''}).`
    );
  }
  return kept;
}

// ── Netzwerk ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url, { fetchImpl = fetch, accept = 'text/html' } = {}) {
  const res = await fetchOrExplain(
    url,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'de-DE,de;q=0.9',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    { fetchImpl, was: url }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  return res;
}

async function getJson(url, opts = {}) {
  const res = await httpGet(url, { ...opts, accept: 'application/json' });
  return res.json();
}

async function getText(url, opts = {}) {
  const res = await httpGet(url, opts);
  return res.text();
}

// Ein Rezept von einer beliebigen URL holen (JSON-LD). Für Chefkoch-URLs wird
// zuerst die API versucht.
export async function fetchRecipeFromUrl(url, { fetchImpl = fetch } = {}) {
  // Absichtlich `\d+` und nicht `\d{6,}`: alte Chefkoch-Rezepte haben kurze
  // Nummern. Greift die API-Vermutung daneben, faellt es ohnehin auf das HTML
  // zurueck – zu streng zu sein kostet dagegen den ganzen API-Weg.
  const ckId = /chefkoch\.de\/rezepte\/(\d+)/.exec(url)?.[1];
  if (ckId) {
    try {
      const recipe = await fetchChefkochRecipe(ckId, { fetchImpl });
      if (recipe) return recipe;
    } catch {
      /* Fallback auf HTML */
    }
  }
  const html = await getText(url, { fetchImpl });
  const recipe = parseRecipeFromHtml(html, url);
  if (!recipe) return null;
  return { ...recipe, source: hostOf(url) };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'import';
  }
}

// Einzelnes Chefkoch-Rezept: API zuerst, sonst HTML/JSON-LD.
export async function fetchChefkochRecipe(id, { fetchImpl = fetch } = {}) {
  try {
    const json = await getJson(`${CHEFKOCH_API}/recipes/${id}`, { fetchImpl });
    const mapped = mapChefkochApiRecipe(json);
    if (mapped && mapped.ingredients.length) return { ...mapped, source: 'chefkoch' };
  } catch {
    /* weiter mit HTML */
  }
  const url = `${CHEFKOCH_WEB}/rezepte/${id}/`;
  const html = await getText(url, { fetchImpl });
  const recipe = parseRecipeFromHtml(html, url);
  if (!recipe) return null;
  return { ...recipe, external_id: `chefkoch:${id}`, source: 'chefkoch' };
}

// Rezept-IDs für den Massenimport sammeln: erst API-Suche, dann HTML-Suche.
export async function discoverChefkochIds(opts = {}) {
  const candidates = await discoverChefkochCandidates(opts);
  return candidates.map((c) => c.id);
}

// Wie `discoverChefkochIds`, liefert aber {id, rating, votes} – die JSON-Suche
// bringt die Bewertung meist mit, die HTML-Suche nicht.
export async function discoverChefkochCandidates({
  query = '',
  count = 50,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const wanted = Math.max(1, Math.min(1000, Number(count) || 50));
  const ids = [];
  const seen = new Set();
  const push = (list) => {
    for (const entry of list) {
      const candidate = typeof entry === 'string' ? { id: entry, rating: null, votes: null } : entry;
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      ids.push(candidate);
    }
  };

  // 1) JSON-API (50 Treffer je Seite)
  let apiWorked = false;
  for (let offset = 0; ids.length < wanted && offset < wanted + 200; offset += 50) {
    const url =
      `${CHEFKOCH_API}/search-gateway/recipes?query=${encodeURIComponent(query)}` +
      `&limit=50&offset=${offset}&orderBy=2&order=1`;
    try {
      const json = await getJson(url, { fetchImpl });
      const found = extractChefkochCandidatesFromApi(json);
      if (!found.length) break;
      apiWorked = true;
      push(found);
      log(`API-Suche: ${ids.length} Rezepte gefunden …`);
    } catch (err) {
      log(`API-Suche nicht verfügbar (${err.message}) – versuche die Webseite.`);
      break;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // 2) HTML-Suchergebnisseiten (30 Treffer je Seite)
  if (ids.length < wanted && !apiWorked) {
    for (let offset = 0; ids.length < wanted && offset < wanted + 120; offset += 30) {
      const path = query
        ? `/rs/s${offset}o3/${encodeURIComponent(query)}/Rezepte.html`
        : `/rs/s${offset}o3/Rezepte.html`;
      try {
        const html = await getText(`${CHEFKOCH_WEB}${path}`, { fetchImpl });
        const found = extractChefkochIdsFromHtml(html);
        if (!found.length) break;
        push(found);
        log(`Webseite: ${ids.length} Rezepte gefunden …`);
      } catch (err) {
        log(`Suchseite fehlgeschlagen: ${err.message}`);
        break;
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return ids.slice(0, wanted);
}

// ── Import-Job (Hintergrundlauf mit Fortschritt) ───────────────────────────────

// Nur ein Job gleichzeitig – der Import ist netz- und schreiblastig und wird
// von der Oberfläche per Polling verfolgt.
let currentJob = null;

export function getImportJob() {
  if (!currentJob) return null;
  const { cancelled, ...rest } = currentJob;
  return { ...rest, log: currentJob.log.slice(-40) };
}

export function cancelImportJob() {
  if (currentJob && currentJob.status === 'running') {
    currentJob.cancelled = true;
    currentJob.log.push('Abbruch angefordert …');
    return true;
  }
  return false;
}

// Startet den Massenimport. `deps` erlaubt das Einhängen der DB-Funktionen
// (und in Tests eines fetch-Ersatzes).
export function startImportJob({
  query = '',
  count = 50,
  minRating = 0,
  minVotes = 0,
  fetchImpl = fetch,
  deps,
}) {
  if (currentJob && currentJob.status === 'running') {
    throw new Error('Es läuft bereits ein Import. Bitte warten oder abbrechen.');
  }
  const job = {
    id: `import-${Date.now()}`,
    status: 'running',
    query,
    requested: Math.max(1, Math.min(1000, Number(count) || 50)),
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
  currentJob = job;
  const log = (msg) => {
    job.log.push(msg);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };

  (async () => {
    try {
      log(
        `Suche ${job.requested} Rezepte auf Chefkoch${query ? ` zu "${query}"` : ''}` +
          `${job.minRating ? `, mindestens ${job.minRating}★` : ''}` +
          `${job.minVotes ? ` bei ${job.minVotes}+ Stimmen` : ''} …`
      );
      const candidates = await discoverChefkochCandidates({
        query,
        // Bei aktivem Filter mehr Kandidaten holen, sonst bleiben zu wenige übrig.
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
      log(`${ids.length} Rezepte gefunden, hole Details …`);

      // Bekannte IDs vorab aussortieren, das spart Netzabrufe.
      const todo = ids.filter((id) => {
        if (deps.findRecipeByExternalId(`chefkoch:${id}`)) {
          job.skipped += 1;
          job.done += 1;
          return false;
        }
        return true;
      });
      if (job.skipped) log(`${job.skipped} Rezepte waren schon vorhanden.`);

      let index = 0;
      const worker = async () => {
        while (index < todo.length && !job.cancelled) {
          const id = todo[index++];
          try {
            const recipe = await fetchChefkochRecipe(id, { fetchImpl });
            if (!recipe || !recipe.name) {
              job.failed += 1;
              log(`Rezept ${id}: keine verwertbaren Daten.`);
            } else if (deps.findRecipeByName(recipe.name)) {
              job.skipped += 1;
            } else {
              deps.createRecipe({ ...recipe, source: 'chefkoch' });
              job.imported += 1;
              if (job.imported % 10 === 0) log(`${job.imported} Rezepte importiert …`);
            }
          } catch (err) {
            job.failed += 1;
            log(`Rezept ${id} fehlgeschlagen: ${err.message}`);
          }
          job.done += 1;
          await sleep(REQUEST_DELAY_MS);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker)
      );

      job.status = job.cancelled ? 'cancelled' : 'done';
      log(
        `Fertig: ${job.imported} importiert, ${job.skipped} übersprungen, ${job.failed} fehlgeschlagen.`
      );
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      log(`Fehler: ${err.message}`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return getImportJob();
}
