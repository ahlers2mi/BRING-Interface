import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Bring from 'bring-shopping';
import { registerAuth, authEnabled, apiTokenEnabled } from './auth.js';
import {
  getAllRecipes,
  getRecipeById,
  getSourceIndex,
  upsertRecipeFromSource,
  markRecipesMissing,
  findRecipeBySourceUrlPart,
  recipeHasHistory,
  getMissingRecipes,
  deleteRecipes,
  normalizeMealieImageUrls,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  setRecipeBlocked,
  setRecipeCourse,
  setPlanShopped,
  findRecipeByExternalId,
  findRecipeByName,
  addRating,
  deleteRating,
  getRatingHistory,
  getPlanEntry,
  setPlanEntry,
  deletePlanEntry,
  updatePlanStatus,
  getSetting,
  setSetting,
  currentCourseConfig,
} from './database.js';
import {
  buildWeekView,
  currentWeather,
  fridgeSearch,
  householdServings,
  planSettings,
  rollDays,
  rollWeek,
  tasteSummary,
  weekShoppingItems,
} from './lib/mealplan.js';
import { scaleFactor, scaleIngredients } from './lib/scale.js';
import { DEFAULT_MAIN_TAGS, DEFAULT_SIDE_TAGS } from './lib/course.js';
import { cancelSiteJob, getSiteJob, startSiteImportJob } from './lib/site-job.js';
import { fetchOrExplain } from './lib/neterror.js';
import { climateBias } from './lib/climate.js';
import {
  isValidIsoDate,
  todayIso,
  addDays,
  weekDates,
  weekOf,
  shiftWeek,
} from './lib/week.js';
import {
  cancelImportJob,
  fetchRecipeFromUrl,
  getImportJob,
  startImportJob,
  stripHtml,
} from './lib/recipe-import.js';
import { realIngredients } from './lib/normalize.js';
import { renderPlanSvg } from './lib/plan-svg.js';
import {
  fetchVideoSource,
  isVideoUrl,
  recipeFromText,
  videoRecipeBase,
} from './lib/video-import.js';
import {
  cancelChefkochJob,
  createRecipeInMealie,
  deleteRecipeInMealie,
  fetchMealieImage,
  fetchRecipeDetail,
  getChefkochJob,
  importUrlToMealie,
  mapMealieRecipe,
  repairThinMealieRecipe,
  getSyncState,
  mealieAbout,
  mealieEnabled,
  mealieConfig,
  mealieIdOf,
  mealieRecipeUrl,
  pullPlanFromMealie,
  pushPlanDatesToMealie,
  pushPlanEntryToMealie,
  pushRatingToMealie,
  startChefkochToMealieJob,
  syncFromMealie,
} from './lib/mealie.js';
import {
  cookidooCheck,
  cookidooConfig,
  cookidooEnabled,
  cookidooShoppingItems,
  getCookidooState,
  syncFromCookidoo,
} from './lib/cookidoo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Version / Stand ───────────────────────────────────────────────────────────
//
// Zwei Angaben, weil beide für sich lügen können: die Version aus package.json
// sagt, welcher Funktionsstand gemeint ist, der Zeitstempel von server.js sagt,
// wann der Code wirklich in das Image gekommen ist. Genau das ist die Frage,
// wenn im Container noch ein alter Stand läuft.
const BUILD = (() => {
  let version = 'unbekannt';
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
    ).version;
  } catch {
    /* ohne package.json bleibt es bei "unbekannt" */
  }
  let builtAt = '';
  try {
    builtAt = fs.statSync(path.join(__dirname, 'server.js')).mtime.toISOString();
  } catch {
    /* egal */
  }
  return { version, builtAt };
})();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true); // korrekte HTTPS-Erkennung hinter Reverse Proxy

// Versehentliche HTTP-Subressourcen automatisch auf HTTPS hochstufen (kein Mixed Content).
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests');
  next();
});

app.use(express.json({ limit: '12mb' })); // großzügig wegen Foto-Uploads (Base64)
app.use(express.urlencoded({ extended: false })); // Login-Formular

// Passwortschutz (greift nur, wenn APP_PASSWORD gesetzt ist) – vor allen Routen.
registerAuth(app);

app.use(express.static(path.join(__dirname, 'public')));

// Bequeme Adresse für die Wandtablet-Ansicht (kann in FHEM als Rahmen hängen).
app.get('/plan', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'plan.html'));
});

// ── Bring singleton ──────────────────────────────────────────────────────────

let bringClient = null;

async function getBringClient() {
  if (bringClient) return bringClient;
  if (!process.env.BRING_MAIL || !process.env.BRING_PASSWORD) {
    throw new Error(
      'Bring-Zugangsdaten fehlen. Bitte BRING_MAIL und BRING_PASSWORD in der .env-Datei setzen.'
    );
  }
  const client = new Bring({
    mail: process.env.BRING_MAIL,
    password: process.env.BRING_PASSWORD,
  });
  await client.login();
  bringClient = client;
  return client;
}

// ── OpenRouter (KI-Analyse) ─────────────────────────────────────────────────────

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Modell überschreibbar via OPENROUTER_MODEL. Der Standard unterstützt
// strukturierte JSON-Ausgaben (json_schema) und Bilder (Vision).
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

const RECIPE_SYSTEM_PROMPT =
  'Du extrahierst aus einem freien Rezepttext strukturierte Daten. ' +
  'Gib den Gerichtnamen, eine kurze Beschreibung, die Zutatenliste, die ' +
  'Zubereitungsschritte, die voraussichtliche Zeit und – falls im Text ' +
  'vorhanden – eine Quell-URL zurück. ' +
  'Trenne bei jeder Zutat die Mengenangabe (inkl. Einheit) sauber vom Zutatennamen. ' +
  'Die Zubereitung als gut lesbaren Text, gerne mit nummerierten Schritten (je Schritt eine Zeile). ' +
  'Die Zeit als kurze Angabe, z. B. "ca. 30 Min." oder "45 Minuten". ' +
  'Behalte die Sprache des Originaltextes bei und erfinde keine Inhalte. ' +
  'Lass ein Feld leer, wenn die Information nicht vorhanden ist.';

const ITEMS_SYSTEM_PROMPT =
  'Du extrahierst eine Einkaufsliste aus dem Text oder Bild des Nutzers. ' +
  'Gib eine Liste von Artikeln zurück, jeweils mit Name und Menge. ' +
  'Trenne die Mengenangabe (inkl. Einheit, z. B. "500 g", "2 Packungen") sauber vom Artikelnamen. ' +
  'Wenn keine Menge angegeben ist, lass das Mengenfeld leer. ' +
  'Behalte die Sprache des Originals bei und erfinde keine Artikel.';

// Extrahiert das JSON aus der Modellantwort (entfernt evtl. ```-Codeblöcke).
function parseJsonContent(content) {
  let txt = String(content).trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = fence[1].trim();
  return JSON.parse(txt);
}

// Generischer OpenRouter-Aufruf mit erzwungenem JSON-Schema.
// `content` ist entweder ein String oder ein Array von Content-Blöcken (für Bilder).
async function callOpenRouter({ system, content, schemaName, schema }) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY fehlt. Bitte den OpenRouter-API-Schlüssel als Umgebungsvariable setzen.'
    );
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'BRING-Interface',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenRouter-Fehler (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const answer = data.choices?.[0]?.message?.content;
  if (!answer) throw new Error('Keine Antwort von der KI erhalten.');
  return parseJsonContent(answer);
}

function analyzeRecipeText(text) {
  return callOpenRouter({
    system: RECIPE_SYSTEM_PROMPT,
    content: text,
    schemaName: 'recipe',
    schema: RECIPE_SCHEMA,
  });
}

// Analysiert Text und/oder ein Bild (Data-URL) zu einer Artikelliste.
function analyzeItems({ text, image }) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  if (image) blocks.push({ type: 'image_url', image_url: { url: image } });
  return callOpenRouter({
    system: ITEMS_SYSTEM_PROMPT,
    content: blocks.length ? blocks : String(text || ''),
    schemaName: 'shopping_items',
    schema: ITEMS_SCHEMA,
  });
}

// JSON-Schema für die strukturierte Rezeptausgabe
const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Der Name des Gerichts/Rezepts.',
    },
    description: {
      type: 'string',
      description:
        'Kurze Beschreibung (1–2 Sätze) oder leerer String, falls keine vorhanden.',
    },
    source_url: {
      type: 'string',
      description:
        'Quell-URL des Rezepts, falls im Text vorhanden, sonst leerer String.',
    },
    instructions: {
      type: 'string',
      description:
        'Zubereitungsschritte als lesbarer Text (gern nummeriert, je Schritt eine Zeile). Leer, falls nicht vorhanden.',
    },
    prep_time: {
      type: 'string',
      description:
        'Voraussichtliche Zeit, z. B. "ca. 30 Min.". Leerer String, falls nicht angegeben.',
    },
    ingredients: {
      type: 'array',
      description: 'Die Zutatenliste.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name der Zutat ohne Mengenangabe, z. B. "Mehl".',
          },
          amount: {
            type: 'string',
            description:
              'Menge inkl. Einheit, z. B. "500 g" oder "2 EL". Leerer String, wenn keine Menge angegeben ist.',
          },
        },
        required: ['name', 'amount'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'name',
    'description',
    'source_url',
    'instructions',
    'prep_time',
    'ingredients',
  ],
  additionalProperties: false,
};

// JSON-Schema für die strukturierte Artikelliste (Einkaufsliste)
const ITEMS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'Die erkannten Einkaufsartikel.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name des Artikels ohne Menge, z. B. "Milch".',
          },
          amount: {
            type: 'string',
            description:
              'Menge inkl. Einheit, z. B. "2 Packungen". Leerer String, wenn keine Menge angegeben ist.',
          },
        },
        required: ['name', 'amount'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseItems(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      // If line starts with a digit, treat the first whitespace-separated
      // token as the amount (e.g. "500g Mehl" → amount "500g", name "Mehl").
      if (trimmed.charCodeAt(0) >= 48 && trimmed.charCodeAt(0) <= 57) {
        const spaceIdx = trimmed.search(/\s/);
        if (spaceIdx > 0) {
          return {
            name: trimmed.slice(spaceIdx).trim(),
            amount: trimmed.slice(0, spaceIdx),
          };
        }
      }
      return { name: trimmed, amount: '' };
    })
    .filter((item) => item !== null && item.name.length > 0);
}

// ── Bring API routes ──────────────────────────────────────────────────────────

// ── Einstellungen (zuletzt benutzte Liste merken) ──────────────────────────────

function preferences() {
  const courses = currentCourseConfig();
  return {
    lastListUuid: getSetting('lastListUuid'),
    // Für wie viele Portionen eingekauft wird. 0/leer = Mengen unverändert
    // übernehmen, wie es vorher war.
    householdServings: householdServings(),
    // Welche Kategorien kein Abendessen sind (Dip, Beilage, Kuchen …) und
    // welche eines erzwingen. Leer gespeichert = die Standardlisten unten.
    courseSideTags: courses.sideTags.join(', '),
    courseMainTags: courses.mainTags.join(', '),
    courseDefaults: {
      sideTags: DEFAULT_SIDE_TAGS.join(', '),
      mainTags: DEFAULT_MAIN_TAGS.join(', '),
    },
    // Würfel-Schwellen: ab wann ein Rezept werktags als "dauert lange" gilt
    // und ab welcher Temperatur Eintopf bzw. Salat bevorzugt wird.
    ...planSettings(),
  };
}

app.get('/api/preferences', (_req, res) => {
  res.json(preferences());
});

app.put('/api/preferences', (req, res) => {
  if (typeof req.body.lastListUuid === 'string') {
    setSetting('lastListUuid', req.body.lastListUuid);
  }
  if (req.body.householdServings !== undefined) {
    const value = Number(req.body.householdServings);
    if (!Number.isFinite(value) || value < 0 || value > 20) {
      return res.status(400).json({ error: 'Portionen müssen zwischen 0 und 20 liegen.' });
    }
    setSetting('householdServings', String(value));
  }
  // Leerer Text = zurück auf die Standardliste.
  for (const key of ['courseSideTags', 'courseMainTags']) {
    if (typeof req.body[key] === 'string') {
      setSetting(key, req.body[key].trim());
    }
  }
  // Würfel-Schwellen. Leer = zurück auf den Wert aus der Umgebung.
  const grenzen = {
    quickMinutes: ['planQuickMinutes', 10, 240],
    coldC: ['planColdC', -30, 40],
    warmC: ['planWarmC', -30, 50],
  };
  for (const [feld, [key, min, max]] of Object.entries(grenzen)) {
    if (req.body[feld] === undefined) continue;
    if (req.body[feld] === '' || req.body[feld] === null) {
      setSetting(key, '');
      continue;
    }
    const wert = Number(req.body[feld]);
    if (!Number.isFinite(wert) || wert < min || wert > max) {
      return res.status(400).json({ error: `${feld} muss zwischen ${min} und ${max} liegen.` });
    }
    setSetting(key, String(wert));
  }
  // Gegen die WIRKSAMEN Werte prüfen: ist nur eine der beiden Schwellen
  // gesetzt, gilt für die andere weiter der Wert aus der Umgebung.
  const wirksam = planSettings();
  if (wirksam.coldC >= wirksam.warmC) {
    return res.status(400).json({
      error: `Die Kalt-Schwelle (${wirksam.coldC} °C) muss unter der Warm-Schwelle (${wirksam.warmC} °C) liegen.`,
    });
  }
  res.json(preferences());
});

app.get('/api/status', async (_req, res) => {
  const base = {
    version: BUILD.version,
    builtAt: BUILD.builtAt,
    authEnabled,
    apiTokenEnabled,
    aiEnabled: Boolean(process.env.OPENROUTER_API_KEY),
    mealie: { ...getSyncState(), recipeUrlPattern: mealieConfig().recipeUrlPattern },
    cookidoo: getCookidooState(),
  };
  try {
    await getBringClient();
    res.json({ ...base, loggedIn: true, mail: process.env.BRING_MAIL });
  } catch (err) {
    res.json({ ...base, loggedIn: false, error: err.message });
  }
});

app.get('/api/lists', async (_req, res) => {
  try {
    const client = await getBringClient();
    const data = await client.loadLists();
    res.json(data.lists ?? []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lists/:uuid/items', async (req, res) => {
  try {
    const client = await getBringClient();
    const data = await client.getItems(req.params.uuid);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/items/analyze – body: { text?, image? } – Text/Foto -> Artikelliste
app.post('/api/items/analyze', async (req, res) => {
  const text = (req.body.text || '').trim();
  const image = req.body.image; // Data-URL (data:image/...;base64,...)
  if (!text && !image) {
    return res.status(400).json({ error: 'Bitte Text eingeben oder ein Foto hochladen.' });
  }
  try {
    const result = await analyzeItems({ text, image });
    res.json({ items: Array.isArray(result.items) ? result.items : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Artikel in eine Bring-Liste schreiben und die Liste als "zuletzt benutzt"
// merken. Gemeinsam genutzt von Einkaufsliste, Rezept- und Wochenplan-Import.
async function importItemsToBring(listUuid, items) {
  const client = await getBringClient();
  const imported = [];
  for (const item of items) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    await client.saveItem(listUuid, name, item.amount || '');
    imported.push(name);
  }
  setSetting('lastListUuid', listUuid);
  return imported;
}

// POST /api/lists/:uuid/items  – body: { items: [{name, amount}] }
app.post('/api/lists/:uuid/items', async (req, res) => {
  try {
    const items =
      req.body.items && Array.isArray(req.body.items)
        ? req.body.items
        : parseItems(req.body.text || '');
    const imported = await importItemsToBring(req.params.uuid, items);
    res.json({ imported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Abhaken: Bring nimmt den Artikel von der Liste und legt ihn unter „zuletzt
// gekauft" ab – dasselbe wie ein Tipp in der App. Löschen wäre der falsche Weg,
// dann verlernt Bring die Gewohnheiten.
app.post('/api/lists/:uuid/items/:name/done', async (req, res) => {
  try {
    const client = await getBringClient();
    await client.moveToRecentList(req.params.uuid, decodeURIComponent(req.params.name));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lists/:uuid/items/:name', async (req, res) => {
  try {
    const client = await getBringClient();
    await client.removeItem(req.params.uuid, decodeURIComponent(req.params.name));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recipe API routes ─────────────────────────────────────────────────────────

app.get('/api/recipes', (_req, res) => {
  res.json(getAllRecipes());
});

// POST /api/recipes/analyze – body: { text } – analysiert Freitext per OpenRouter
app.post('/api/recipes/analyze', async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Kein Rezepttext übergeben.' });

  try {
    const recipe = await analyzeRecipeText(text);
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wenn Mealie die Quelle ist, werden Rezepte dort gepflegt – lokale Änderungen
// würde der nächste Abgleich ohnehin überschreiben.
function blockWhenMealie(req, res, next) {
  if (!mealieEnabled()) return next();
  return res.status(409).json({
    error:
      'Rezepte werden in Mealie gepflegt. Dort anlegen/ändern und danach ' +
      '„Aus Mealie abgleichen" drücken (oder den nächsten automatischen ' +
      'Abgleich abwarten).',
    mealie: mealieConfig().url,
  });
}

app.post('/api/recipes', blockWhenMealie, (req, res) => {
  const {
    name,
    description,
    source_url,
    instructions,
    prep_time,
    servings,
    image_url,
    tags,
    source,
    external_id,
    ingredients,
  } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich.' });
  }
  const recipe = createRecipe({
    name: name.trim(),
    description,
    source_url,
    instructions,
    prep_time,
    servings,
    image_url,
    tags,
    source,
    external_id,
    ingredients,
  });
  res.status(201).json(recipe);
});

// Muss VOR '/api/recipes/:id' stehen, sonst hält Express "add" für eine id.
// (Die Handler stehen weiter unten beim übrigen Import – Funktionsdeklarationen
// sind zu diesem Zeitpunkt schon bekannt.)
app.get('/api/recipes/add', handleAddUrl);
app.post('/api/recipes/add', handleAddUrl);

app.get('/api/recipes/:id', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  res.json(recipe);
});

app.put('/api/recipes/:id', blockWhenMealie, (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  const updated = updateRecipe(Number(req.params.id), req.body);
  res.json(updated);
});

// Löschen: im Mealie-Modus grundsätzlich dort – Ausnahme sind Rezepte, die es
// in Mealie schon nicht mehr gibt. Die liegen hier nur noch wegen ihrer
// Bewertungs- und Plan-Historie und dürfen weg, wenn man sie nicht braucht.
app.delete('/api/recipes/:id', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  if (mealieEnabled() && recipe.source === 'mealie' && !recipe.source_missing) {
    return res.status(409).json({
      error:
        'Dieses Rezept gehört zu Mealie. Nimm den Knopf „In Mealie löschen" – ' +
        'der löscht es dort und räumt hier auf. Alternativ in Mealie über ' +
        '„Manage Data" → Recipes.',
      mealie: mealieConfig().publicUrl || mealieConfig().url,
    });
  }
  deleteRecipe(Number(req.params.id));
  res.json({ success: true });
});

// POST /api/recipes/:id/import – body: { listUuid }
app.post('/api/recipes/:id/import', async (req, res) => {
  try {
    const recipe = getRecipeById(Number(req.params.id));
    if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
    const { listUuid } = req.body;
    if (!listUuid) return res.status(400).json({ error: 'listUuid fehlt.' });

    // Mengen auf die Haushaltsgröße umrechnen (Rezepte stehen meist auf 4
    // Portionen). Ohne Portionsangabe am Rezept bleibt alles, wie es ist.
    const factor = scaleFactor(recipe.servings, householdServings());
    const zutaten = scaleIngredients(realIngredients(recipe.ingredients), factor);

    const client = await getBringClient();
    const imported = [];
    for (const ing of zutaten) {
      await client.saveItem(listUuid, ing.name, ing.amount || '');
      imported.push(ing.name);
    }
    setSetting('lastListUuid', listUuid);
    // Kam der Aufruf von einem Plan-Tag, gilt der Tag als eingekauft – der
    // Würfel lässt ihn dann beim Wochenwurf in Ruhe.
    const planDate = resolveDate(req.body?.date);
    let markiert = null;
    if (planDate && getPlanEntry(planDate)?.recipe_id === recipe.id) {
      setPlanShopped(planDate, true);
      markiert = planDate;
    }
    res.json({ imported, scaled: Boolean(factor), shopped: markiert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bewertungen ───────────────────────────────────────────────────────────────

// Klartext-Bewertungen. `rausgeflogen` = aussortiert, ohne gekocht zu haben;
// `nie_wieder` sperrt das Rezept zusätzlich für die Würfelfunktion.
const RATING_WORDS = {
  lecker: { kind: 'cooked', stars: 5 },
  gut: { kind: 'cooked', stars: 4 },
  ok: { kind: 'cooked', stars: 3 },
  maessig: { kind: 'cooked', stars: 2 },
  mäßig: { kind: 'cooked', stars: 2 },
  schlecht: { kind: 'cooked', stars: 1 },
  rausgeflogen: { kind: 'rejected' },
  nie_wieder: { kind: 'rejected', block: true },
};

// Nimmt entweder { rating: "lecker" }, { stars: 4 } oder { kind, stars } an.
function resolveRating(body = {}) {
  if (body.rating !== undefined && body.rating !== null && body.rating !== '') {
    const word = String(body.rating).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (RATING_WORDS[word]) return { ...RATING_WORDS[word] };
    const numeric = Number(word);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 5) {
      return { kind: 'cooked', stars: Math.round(numeric) };
    }
    return null;
  }
  if (body.kind === 'rejected') return { kind: 'rejected', block: Boolean(body.block) };
  const stars = Number(body.stars);
  if (Number.isFinite(stars) && stars >= 1 && stars <= 5) {
    return { kind: 'cooked', stars: Math.round(stars) };
  }
  return null;
}

// Bewertung speichern und – wenn für diesen Tag genau dieses Rezept eingeplant
// ist – den Tag als gekocht bzw. übersprungen markieren. Ohne Datumsangabe gilt
// heute; so wirkt eine Bewertung aus der Rezeptliste auch auf den Wochenplan,
// solange dort dasselbe Gericht steht.
function applyRating({ recipeId, planDate, resolved, comment }) {
  const date = planDate || todayIso();
  const rating = addRating({
    recipe_id: recipeId,
    plan_date: date,
    kind: resolved.kind,
    stars: resolved.stars,
    comment,
  });
  if (resolved.block) setRecipeBlocked(recipeId, true);
  const entry = getPlanEntry(date);
  if (entry && entry.recipe_id === recipeId) {
    updatePlanStatus(date, resolved.kind === 'cooked' ? 'cooked' : 'skipped');
  }

  // Nach Mealie zurückschreiben, damit dort derselbe Stand steht. Absichtlich
  // ohne await und mit gefangenem Fehler: die Bewertung hier ist schon sicher.
  const recipe = getRecipeById(recipeId);
  if (mealieEnabled() && recipe?.source_slug && resolved.kind === 'cooked') {
    pushRatingToMealie({
      slug: recipe.source_slug,
      rating: resolved.stars,
      lastMade: date,
    }).catch(() => {});
  }
  return rating;
}

// POST /api/recipes/:id/rate – body: { rating } oder { kind, stars, comment, plan_date }
app.post('/api/recipes/:id/rate', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  const resolved = resolveRating(req.body);
  if (!resolved) {
    return res.status(400).json({
      error:
        'Bewertung fehlt oder ist unbekannt. Erlaubt: lecker, gut, ok, maessig, ' +
        'schlecht, rausgeflogen, nie_wieder oder stars 1–5.',
    });
  }
  const planDate =
    req.body.plan_date && isValidIsoDate(req.body.plan_date) ? req.body.plan_date : null;
  applyRating({
    recipeId: recipe.id,
    planDate,
    resolved,
    comment: req.body.comment,
  });
  res.json(getRecipeById(recipe.id));
});

app.delete('/api/recipes/:id/ratings/:ratingId', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  deleteRating(Number(req.params.ratingId));
  res.json(getRecipeById(recipe.id));
});

// POST /api/recipes/:id/block – body: { blocked: true|false }
app.post('/api/recipes/:id/block', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  res.json(setRecipeBlocked(recipe.id, Boolean(req.body.blocked)));
});

// POST /api/recipes/:id/course – body: { course: 'main'|'side'|null }
// Übersteuert die automatische Einordnung (Kategorien) für dieses eine Rezept.
app.post('/api/recipes/:id/course', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  const raw = req.body?.course;
  const course = raw === null || raw === '' || raw === 'auto' ? null : String(raw);
  if (course !== null && course !== 'main' && course !== 'side') {
    return res.status(400).json({ error: 'course muss main, side oder leer sein.' });
  }
  res.json(setRecipeCourse(recipe.id, course));
});

app.get('/api/ratings', (req, res) => {
  res.json(getRatingHistory(Number(req.query.limit) || 50));
});

// Gelernter Geschmack: Lieblings- und Flop-Zutaten, Favoriten, Kennzahlen.
app.get('/api/taste', (_req, res) => {
  res.json(tasteSummary());
});

// ── Wochenplan ────────────────────────────────────────────────────────────────

function resolveWeek(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'current' || raw === 'aktuell') return weekOf(todayIso());
  if (raw === 'next' || raw === 'naechste') return shiftWeek(weekOf(todayIso()), 1);
  if (raw === 'prev' || raw === 'letzte') return shiftWeek(weekOf(todayIso()), -1);
  if (isValidIsoDate(raw)) return weekOf(raw);
  return weekDates(raw) ? raw : null;
}

// Tagesangaben aus der Anfrage: 'today', 'tomorrow' oder YYYY-MM-DD.
function resolveDate(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'today' || raw === 'heute') return todayIso();
  if (raw === 'tomorrow' || raw === 'morgen') return addDays(todayIso(), 1);
  if (raw === 'yesterday' || raw === 'gestern') return addDays(todayIso(), -1);
  return isValidIsoDate(value) ? value : null;
}

// Einen Tag so beschreiben, wie Mealie ihn braucht.
function planPushPayload(date) {
  const entry = getPlanEntry(date);
  const recipe = entry?.recipe_id ? getRecipeById(entry.recipe_id) : null;
  return {
    date,
    mealieId: mealieIdOf(recipe),
    title: recipe ? recipe.name : '',
    note: entry?.note || '',
  };
}

// Änderungen am Plan nach Mealie schieben. Wie beim Bewerten absichtlich ohne
// await: der Plan steht hier schon, und ein langsames oder abgeschaltetes Mealie
// darf das Würfeln nicht ausbremsen.
function syncPlanToMealie(dates) {
  if (!mealieEnabled() || !mealieConfig().pushPlan) return;
  const unique = [...new Set((Array.isArray(dates) ? dates : [dates]).filter(Boolean))];
  pushPlanDatesToMealie(unique.map(planPushPayload)).catch(() => {});
}

app.get('/api/plan', (req, res) => {
  const week = resolveWeek(req.query.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  res.json(buildWeekView(week));
});

// POST /api/plan/roll – body: { week?, date?, dates?, onlyEmpty? }
// Würfelt einen Tag, mehrere Tage oder die ganze Woche.
app.post('/api/plan/roll', (req, res) => {
  const { date, dates, onlyEmpty } = req.body || {};

  // Vorgaben für genau diesen Wurf. maxMinutes 0/leer = keine Grenze,
  // weather leer = wie bisher selbst ermitteln (Messwert bzw. Monat).
  const maxMinutes = Number(req.body?.maxMinutes) || 0;
  if (maxMinutes && (maxMinutes < 5 || maxMinutes > 480)) {
    return res.status(400).json({ error: 'Zeitgrenze muss zwischen 5 und 480 Minuten liegen.' });
  }
  const rohWetter = String(req.body?.weather || '').trim();
  if (rohWetter && !['kalt', 'warm'].includes(rohWetter)) {
    return res.status(400).json({ error: 'weather muss kalt, warm oder leer sein.' });
  }
  // undefined = automatisch, '' wäre "ausdrücklich keine Neigung".
  const weather = rohWetter || undefined;
  const vorgaben = { maxMinutes, weather };

  if (date || Array.isArray(dates)) {
    const list = (Array.isArray(dates) ? dates : [date]).map(resolveDate);
    if (list.some((d) => !d)) {
      return res.status(400).json({ error: 'Ungültiges Datum.' });
    }
    // Ausdrücklicher Wurf für bestimmte Tage: da meint man genau diese Tage,
    // auch wenn dafür schon eingekauft wurde.
    const results = rollDays(list, {
      overwrite: !onlyEmpty,
      protectShopped: false,
      ...vorgaben,
    });
    syncPlanToMealie(list);
    return res.json({ results, plan: buildWeekView(weekOf(list[0])) });
  }

  const week = resolveWeek(req.body?.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  const results = rollWeek(week, { onlyEmpty: Boolean(onlyEmpty), ...vorgaben });
  syncPlanToMealie(weekDates(week));
  res.json({ results, plan: buildWeekView(week) });
});

// PUT /api/plan/:date – body: { recipe_id, note?, status? }
app.put('/api/plan/:date', (req, res) => {
  const date = resolveDate(req.params.date);
  if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });

  const recipeId =
    req.body.recipe_id === null || req.body.recipe_id === ''
      ? null
      : Number(req.body.recipe_id);
  if (recipeId !== null) {
    if (!Number.isFinite(recipeId) || !getRecipeById(recipeId)) {
      return res.status(400).json({ error: 'Rezept nicht gefunden.' });
    }
  }
  const entry = setPlanEntry({
    date,
    recipe_id: recipeId,
    note: req.body.note,
    status: req.body.status || 'planned',
  });
  syncPlanToMealie(date);
  res.json({ entry, plan: buildWeekView(weekOf(date)) });
});

app.delete('/api/plan/:date', (req, res) => {
  const date = resolveDate(req.params.date);
  if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });
  deletePlanEntry(date);
  syncPlanToMealie(date);
  res.json({ success: true, plan: buildWeekView(weekOf(date)) });
});

// Beide Richtungen für eine Woche: erst holen, dann schieben.
//
// Reihenfolge ist wichtig – **Mealie gewinnt**. Wer dort plant, hat sich etwas
// dabei gedacht; unser Würfel füllt die Lücken, und die wandern anschließend
// nach Mealie.
const planPullDeps = {
  getPlanEntry,
  setPlanEntry,
  deletePlanEntry,
  findRecipeByExternalId,
  findRecipeByName,
  upsertRecipeFromSource,
};

async function reconcilePlanWeek(week) {
  const dates = weekDates(week);
  const pulled = await pullPlanFromMealie({ dates, deps: planPullDeps });
  const pushed = mealieConfig().pushPlan
    ? await pushPlanDatesToMealie(dates.map(planPushPayload))
    : { pushed: 0, failed: 0 };
  return { week, ...pulled, ...pushed };
}

// POST /api/plan/mealie – body: { week? }
// Ganze Woche von Hand abgleichen (nach einem Ausfall oder erstmalig). Hier
// wird gewartet, damit die Oberfläche eine belastbare Zahl anzeigen kann.
app.post('/api/plan/mealie', async (req, res) => {
  const cfg = mealieConfig();
  if (!mealieEnabled()) {
    return res.status(400).json({ error: 'Mealie ist nicht konfiguriert.' });
  }
  if (!cfg.pushPlan && !cfg.pullPlan) {
    return res
      .status(400)
      .json({ error: 'Menüplan-Abgleich ist abgeschaltet (MEALIE_PUSH_PLAN/MEALIE_PULL_PLAN).' });
  }
  const week = resolveWeek(req.body?.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  try {
    const result = await reconcilePlanWeek(week);
    res.json({ ...result, plan: buildWeekView(week) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/plan/:date/move – body: { to: 'tomorrow' | 'YYYY-MM-DD' }
// Heute wird es doch nichts: das Gericht auf einen anderen Tag schieben, statt
// es neu zu würfeln und zu verlieren.
app.post('/api/plan/:date/move', (req, res) => {
  const from = resolveDate(req.params.date);
  const to = resolveDate(req.body?.to || 'tomorrow');
  if (!from || !to) return res.status(400).json({ error: 'Ungültiges Datum.' });
  if (from === to) return res.status(400).json({ error: 'Quelle und Ziel sind derselbe Tag.' });

  const entry = getPlanEntry(from);
  if (!entry?.recipe_id) {
    return res.status(400).json({ error: 'Für diesen Tag ist nichts eingeplant.' });
  }
  const target = getPlanEntry(to);
  if (target?.status === 'cooked') {
    return res.status(400).json({ error: 'Der Zieltag ist schon gekocht.' });
  }

  // Was passiert mit dem Tag, auf den geschoben wird?
  //   replace – sein Gericht fällt weg (bisheriges Verhalten)
  //   shift   – es rückt mit auf, und alles dahinter ebenso, bis zum ersten
  //             freien Tag. Es geht nichts verloren.
  //   swap    – die beiden Tage tauschen
  const mode = String(req.body?.mode || 'replace');
  if (!['replace', 'shift', 'swap'].includes(mode)) {
    return res.status(400).json({ error: 'mode muss replace, shift oder swap sein.' });
  }

  const beruehrt = [from, to];
  let verschoben = [];
  let verdraengt = null;

  if (target?.recipe_id && mode === 'swap') {
    setPlanEntry({
      date: from,
      recipe_id: target.recipe_id,
      note: target.note,
      status: target.status === 'leftovers' ? 'leftovers' : 'planned',
      origin: target.origin || 'app',
    });
  } else if (target?.recipe_id && mode === 'shift') {
    // Plätze ab dem Zieltag einsammeln, bis einer frei ist. Gekochte Tage sind
    // keine Plätze – die bleiben liegen, geschoben wird um sie herum.
    const plaetze = [];
    let tag = to;
    for (let i = 0; i < 60; i += 1) {
      const e = getPlanEntry(tag);
      if (e?.status === 'cooked') {
        tag = addDays(tag, 1);
        continue;
      }
      plaetze.push({ date: tag, entry: e });
      if (!e?.recipe_id) break; // freier Platz – hier endet die Kette
      tag = addDays(tag, 1);
    }
    // Von hinten nach vorn setzen, sonst überschreibt man sich selbst.
    for (let i = plaetze.length - 2; i >= 0; i -= 1) {
      const { date, entry: e } = plaetze[i];
      const ziel = plaetze[i + 1].date;
      setPlanEntry({
        date: ziel,
        recipe_id: e.recipe_id,
        note: e.note,
        status: e.status === 'leftovers' ? 'leftovers' : 'planned',
        origin: e.origin || 'app',
      });
      if (e.shopped_at) setPlanShopped(ziel, true);
      beruehrt.push(ziel);
      verschoben.push({ from: date, to: ziel });
    }
  } else if (target?.recipe_id) {
    verdraengt = { date: to, name: getRecipeById(target.recipe_id)?.name || '' };
  }

  setPlanEntry({
    date: to,
    recipe_id: entry.recipe_id,
    note: entry.note,
    status: entry.status === 'leftovers' ? 'leftovers' : 'planned',
    origin: entry.origin || 'app',
  });
  // Eingekauft ist eingekauft – die Markierung wandert mit dem Gericht mit.
  if (entry.shopped_at) setPlanShopped(to, true);
  if (mode !== 'swap') deletePlanEntry(from);

  syncPlanToMealie([...new Set(beruehrt)]);
  res.json({
    from,
    to,
    mode,
    verschoben,
    verdraengt,
    plan: buildWeekView(weekOf(to)),
  });
});

// POST /api/plan/:date/shopped – body: { shopped: true|false }
// Von Hand setzen oder zurücknehmen ("doch nichts gekauft").
app.post('/api/plan/:date/shopped', (req, res) => {
  const date = resolveDate(req.params.date);
  if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });
  if (!getPlanEntry(date)?.recipe_id) {
    return res.status(400).json({ error: 'Für diesen Tag ist nichts eingeplant.' });
  }
  const entry = setPlanShopped(date, req.body?.shopped !== false);
  res.json({ entry, plan: buildWeekView(weekOf(date)) });
});

// POST /api/plan/:date/status – body: { status: planned|cooked|skipped|leftovers }
// „leftovers" ist der Reste-Tag: da ist noch was da, der Würfel lässt ihn in Ruhe.
const PLAN_STATUS = new Set(['planned', 'cooked', 'skipped', 'leftovers']);

app.post('/api/plan/:date/status', (req, res) => {
  const date = resolveDate(req.params.date);
  if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });
  const status = String(req.body?.status || '');
  if (!PLAN_STATUS.has(status)) {
    return res.status(400).json({ error: `Unbekannter Status: ${status}` });
  }

  const entry = getPlanEntry(date);
  if (!entry) {
    // Reste ohne Rezept sind erlaubt – „heute gibt es den Rest von gestern".
    setPlanEntry({ date, recipe_id: null, note: 'Reste', status });
  } else {
    updatePlanStatus(date, status);
  }
  res.json({ plan: buildWeekView(weekOf(date)) });
});

// POST /api/plan/:date/rate – body: { rating } oder { kind, stars, comment }
app.post('/api/plan/:date/rate', (req, res) => {
  const date = resolveDate(req.params.date);
  if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });
  const entry = getPlanEntry(date);
  if (!entry || !entry.recipe_id) {
    return res.status(400).json({ error: 'Für diesen Tag ist kein Rezept eingeplant.' });
  }
  const resolved = resolveRating(req.body);
  if (!resolved) return res.status(400).json({ error: 'Bewertung fehlt oder ist unbekannt.' });

  applyRating({
    recipeId: entry.recipe_id,
    planDate: date,
    resolved,
    comment: req.body.comment,
  });
  res.json({ plan: buildWeekView(weekOf(date)) });
});

// Wochen-Einkaufsliste ansehen …
app.get('/api/plan/shopping', (req, res) => {
  const week = resolveWeek(req.query.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  res.json(weekShoppingItems(week, { skipCooked: req.query.all !== '1' }));
});

// … und in eine Bring-Liste schieben.
app.post('/api/plan/shopping', async (req, res) => {
  const week = resolveWeek(req.body?.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  const { listUuid } = req.body || {};
  if (!listUuid) return res.status(400).json({ error: 'listUuid fehlt.' });
  try {
    const { items, recipes } = weekShoppingItems(week, { skipCooked: !req.body.all });
    if (!items.length) {
      return res.status(400).json({ error: 'Für diese Woche ist nichts eingeplant.' });
    }
    const imported = await importItemsToBring(listUuid, items);
    // Alle Tage, deren Zutaten mitgegangen sind, als eingekauft markieren.
    const markiert = [];
    for (const eintrag of recipes || []) {
      if (!eintrag?.date) continue;
      setPlanShopped(eintrag.date, true);
      markiert.push(eintrag.date);
    }
    res.json({ imported, recipes, shopped: markiert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reste-Küche ───────────────────────────────────────────────────────────────

// POST /api/fridge/search – body: { items: ["Zucchini", "Hackfleisch"], assumePantry? }
app.post('/api/fridge/search', (req, res) => {
  const raw = req.body?.items;
  const items = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(/[\n,;]+/)
        .map((s) => s.trim());
  const list = items.filter(Boolean);
  if (!list.length) {
    return res.status(400).json({ error: 'Bitte mindestens eine Zutat eingeben.' });
  }
  res.json(
    fridgeSearch(list, {
      assumePantry: req.body?.assumePantry !== false,
      limit: Math.min(50, Number(req.body?.limit) || 20),
    })
  );
});

// ── Rezept-Import (URL + Massenimport) ────────────────────────────────────────

// Ein Kochvideo auswerten. Zwei Schritte: erst Text besorgen (Beschreibung,
// sonst Untertitel), dann strukturieren – mit der KI, wenn ein Schlüssel da ist,
// sonst mit dem Zeilen-Leser aus `video-import.js`.
async function recipeFromVideo(url, { ai = true } = {}) {
  const source = await fetchVideoSource(url);
  const base = videoRecipeBase(source);

  let parsed = null;
  let aiError = '';
  if (ai && process.env.OPENROUTER_API_KEY) {
    try {
      parsed = await analyzeRecipeText(
        [
          'Rezept aus einem Kochvideo. Zutaten und Zubereitung stehen in der',
          'Beschreibung bzw. im gesprochenen Text darunter.',
          `Titel: ${source.title}`,
          source.author ? `Kanal: ${source.author}` : '',
          '',
          source.text.slice(0, 12000),
        ]
          .filter(Boolean)
          .join('\n')
      );
    } catch (err) {
      aiError = err.message;
    }
  }

  // Ohne KI (oder wenn sie nichts gefunden hat): Zutatenliste aus den Zeilen.
  if (!parsed || !(parsed.ingredients || []).length) {
    parsed = recipeFromText(source.text, { name: base.name });
  }

  if (!parsed || !(parsed.ingredients || []).length) {
    const err = new Error(
      `Im Video „${source.title}" steht keine erkennbare Zutatenliste ` +
        `(ausgewertet: ${source.used}).` +
        (aiError ? ` KI-Analyse: ${aiError}` : '') +
        ' Der Text steht unten – hineinschauen, ergänzen und die KI-Analyse benutzen.'
    );
    err.status = 422;
    err.videoText = source.text;
    throw err;
  }

  return {
    source,
    recipe: {
      ...parsed,
      name: String(parsed.name || '').trim() || base.name,
      description:
        parsed.description ||
        `Aus dem Video „${source.title}"${source.author ? ` von ${source.author}` : ''}.`,
      source_url: base.source_url,
      image_url: base.image_url,
      tags: [...new Set([...(parsed.tags || []), ...base.tags])].slice(0, 12),
    },
  };
}

// POST /api/recipes/import/url – body: { url, save?, ai? }
// Holt ein Rezept von einer Webseite (schema.org-Daten, bei Chefkoch die API).
app.post('/api/recipes/import/url', blockWhenMealie, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Bitte eine vollständige http(s)-URL angeben.' });
  }
  try {
    // Kochvideo: eigener Weg (Beschreibung/Untertitel statt schema.org).
    if (isVideoUrl(url)) {
      const { recipe, source } = await recipeFromVideo(url, { ai: req.body?.ai !== false });
      if (req.body?.save) {
        const existing = findRecipeByName(recipe.name);
        if (existing) {
          return res.json({ recipe: getRecipeById(existing.id), saved: false, duplicate: true });
        }
        return res
          .status(201)
          .json({ recipe: createRecipe({ ...recipe, source: 'video' }), saved: true, video: source.used });
      }
      return res.json({ recipe, saved: false, video: source.used });
    }

    let recipe = await fetchRecipeFromUrl(url);

    // Fallback: Seitentext von der KI auswerten lassen (nur wenn gewünscht).
    if (!recipe && req.body?.ai) {
      const html = await fetch(url, {
        headers: { 'User-Agent': 'BRING-Interface/1.0' },
        signal: AbortSignal.timeout(20000),
      }).then((r) => r.text());
      const text = stripHtml(html).slice(0, 12000);
      recipe = await analyzeRecipeText(text);
      if (recipe) recipe.source_url = recipe.source_url || url;
    }

    if (!recipe || !recipe.name) {
      return res.status(422).json({
        error:
          'Auf der Seite wurden keine strukturierten Rezeptdaten gefunden. ' +
          'Text kopieren und die KI-Analyse benutzen – oder „KI-Fallback" aktivieren.',
      });
    }

    if (req.body?.save) {
      const existing =
        (recipe.external_id && findRecipeByExternalId(recipe.external_id)) ||
        findRecipeByName(recipe.name);
      if (existing) {
        return res.json({ recipe: getRecipeById(existing.id), saved: false, duplicate: true });
      }
      return res.status(201).json({ recipe: createRecipe(recipe), saved: true });
    }
    res.json({ recipe, saved: false });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message, ...(err.videoText ? { text: err.videoText } : {}) });
  }
});

// ── Teilen-Ziel für Android (Web Share Target) ─────────────────────────────────
//
// Android kann eine installierte Web-App ins Teilen-Menü aufnehmen; das Ziel
// steht in `public/manifest.webmanifest`. Hier landet also der Link, den jemand
// aus Chrome heraus geteilt hat – und weil man beim Teilen eine Rückmeldung
// sehen will, antwortet diese Route als Seite, nicht als JSON.
//
// Was geteilt wird, ist von der App abhängig: manche füllen `url`, viele packen
// die Adresse mitten in `text` ("Schau mal: https://…"). Deshalb suchen wir in
// allen drei Feldern nach dem ersten Link.
export function urlFromShare({ url, text, title } = {}) {
  for (const candidate of [url, text, title]) {
    const found = /https?:\/\/[^\s"'<>]+/.exec(String(candidate || ''));
    if (found) return found[0].replace(/[).,]+$/, '');
  }
  return '';
}

function sharePage({ heading, message, link }) {
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(heading)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/css/style.css" />
</head>
<body>
  <main>
    <div class="card">
      <h2>${esc(heading)}</h2>
      <p>${esc(message)}</p>
      <div class="btn-group">
        ${link ? `<a class="btn btn-secondary" href="${esc(link)}">↗ In Mealie ansehen</a>` : ''}
        <a class="btn btn-primary" href="/">Zur App</a>
      </div>
    </div>
  </main>
</body>
</html>`;
}

app.get('/share', async (req, res) => {
  const url = urlFromShare(req.query);
  if (!url) {
    return res.status(400).type('html').send(
      sharePage({
        heading: 'Kein Link dabei',
        message:
          'In dem Geteilten war keine Web-Adresse zu finden. Teile bitte die ' +
          'Rezeptseite selbst (in Chrome: Teilen → BRING-Interface).',
      })
    );
  }
  try {
    const { status, body } = await addRecipeByUrl(url);
    res.status(status === 201 ? 200 : status).type('html').send(
      sharePage({
        heading: body.error ? 'Hat nicht geklappt' : body.duplicate ? 'Kennen wir schon' : 'Gespeichert',
        message: body.error || body.message || '',
        link: body.link,
      })
    );
  } catch (err) {
    res.status(502).type('html').send(
      sharePage({ heading: 'Hat nicht geklappt', message: err.message })
    );
  }
});

// ── Ein Rezept per Link, egal woher ───────────────────────────────────────────
//
// Absichtlich **ohne** `blockWhenMealie` und mit GET-Variante: das ist der Weg
// fürs Handy (iOS-Kurzbefehl im Teilen-Menü). Läuft Mealie, übernimmt dessen
// Importer und der Spiegel wird sofort nachgezogen; sonst der eigene Importer.
async function addRecipeByUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    return { status: 400, body: { error: 'Bitte eine vollständige http(s)-Adresse angeben.' } };
  }

  // Schon da? Bei Chefkoch ist die Rezept-Nummer eindeutig, sonst die ganze URL.
  const key = /chefkoch\.de\/rezepte\/(\d+)\//.exec(url)?.[0] || url.split('?')[0];
  const known = findRecipeBySourceUrlPart(key);
  if (known) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, name: known.name, message: `Kennen wir schon: ${known.name}` },
    };
  }

  // Kochvideo: Mealies Importer kann YouTube nicht lesen (dort steckt kein
  // schema.org-Recipe), also werten wir es selbst aus. Läuft Mealie, wird das
  // Ergebnis trotzdem dort angelegt – Mealie bleibt die eine Quelle.
  if (isVideoUrl(url)) {
    const { recipe, source } = await recipeFromVideo(url);
    if (mealieEnabled()) {
      const slug = await createRecipeInMealie(recipe);
      const detail = await fetchRecipeDetail(slug);
      const mapped = mapMealieRecipe(detail, mealieConfig().url);
      const saved = mapped ? upsertRecipeFromSource(mapped) : null;
      return {
        status: 201,
        body: {
          ok: true,
          target: 'mealie',
          name: saved?.name || recipe.name,
          link: mealieRecipeUrl(slug),
          message:
            `Aus dem Video übernommen (${source.used}), ` +
            `${recipe.ingredients.length} Zutaten: ${saved?.name || recipe.name}`,
        },
      };
    }
    const created = createRecipe({ ...recipe, source: 'video' });
    return {
      status: 201,
      body: {
        ok: true,
        target: 'lokal',
        name: created.name,
        message:
          `Aus dem Video übernommen (${source.used}), ` +
          `${recipe.ingredients.length} Zutaten: ${created.name}`,
      },
    };
  }

  if (mealieEnabled()) {
    const slug = await importUrlToMealie(url);
    if (!slug) throw new Error('Mealie hat kein Rezept angelegt.');
    // Nicht auf den nächsten Abgleich warten – der läuft nur alle paar Minuten.
    const detail = await fetchRecipeDetail(slug);
    const mapped = mapMealieRecipe(detail, mealieConfig().url);
    const saved = mapped ? upsertRecipeFromSource(mapped) : null;
    return {
      status: 201,
      body: {
        ok: true,
        target: 'mealie',
        name: saved?.name || detail?.name || '',
        link: mealieRecipeUrl(slug),
        message: `In Mealie angelegt: ${saved?.name || detail?.name || slug}`,
      },
    };
  }

  const recipe = await fetchRecipeFromUrl(url);
  if (!recipe || !recipe.name) {
    return {
      status: 422,
      body: {
        error:
          'Auf der Seite wurden keine strukturierten Rezeptdaten gefunden. ' +
          'Text kopieren und die KI-Analyse benutzen.',
      },
    };
  }
  const created = createRecipe(recipe);
  return {
    status: 201,
    body: { ok: true, target: 'lokal', name: created.name, message: `Gespeichert: ${created.name}` },
  };
}

async function handleAddUrl(req, res) {
  const url = String(req.query?.url || req.body?.url || '').trim();
  try {
    const { status, body } = await addRecipeByUrl(url);
    res.status(status).json(body);
  } catch (err) {
    // Beim Video liegt der gesammelte Text am Fehler: mitschicken, damit man
    // ihn in die KI-Analyse kopieren kann statt ihn erneut zu suchen.
    res
      .status(err.status || 502)
      .json({ error: err.message, ...(err.videoText ? { text: err.videoText } : {}) });
  }
}

// POST /api/recipes/import/chefkoch – body: { query?, count? }
// Startet den Massenimport im Hintergrund (Fortschritt via /status).
app.post('/api/recipes/import/chefkoch', blockWhenMealie, (req, res) => {
  try {
    const job = startImportJob({
      query: String(req.body?.query || '').trim(),
      count: Number(req.body?.count) || 50,
      minRating: Number(req.body?.minRating) || 0,
      minVotes: Number(req.body?.minVotes) || 0,
      deps: { createRecipe, findRecipeByExternalId, findRecipeByName },
    });
    res.status(202).json(job);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.get('/api/recipes/import/status', (_req, res) => {
  res.json(getImportJob() || { status: 'idle' });
});

app.post('/api/recipes/import/cancel', (_req, res) => {
  res.json({ cancelled: cancelImportJob(), job: getImportJob() });
});

// ── Mealie als Rezeptquelle ───────────────────────────────────────────────────

const mealieDeps = {
  upsertRecipeFromSource,
  getSourceIndex,
  markRecipesMissing,
  findRecipeBySourceUrlPart,
  recipeHasHistory,
  getMissingRecipes,
  deleteRecipes,
  normalizeMealieImageUrls,
};

app.get('/api/mealie/status', async (_req, res) => {
  const state = getSyncState();
  if (!state.enabled) return res.json(state);
  try {
    const { version } = await mealieAbout();
    res.json({ ...state, reachable: true, version });
  } catch (err) {
    res.json({ ...state, reachable: false, error: err.message });
  }
});

// Abgleich anstoßen. Läuft synchron, dauert bei wenigen hundert Rezepten
// Sekunden – Details werden nur für Neues/Geändertes geholt.
app.post('/api/mealie/sync', async (_req, res) => {
  if (!mealieEnabled()) {
    return res.status(400).json({
      error: 'Mealie ist nicht konfiguriert (MEALIE_URL und MEALIE_TOKEN setzen).',
    });
  }
  try {
    const state = await syncFromMealie({ deps: mealieDeps });
    if (state.status === 'error') return res.status(502).json(state);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cookidoo (Thermomix) ──────────────────────────────────────────────────────

const cookidooDeps = {
  upsertRecipeFromSource,
  markRecipesMissing,
  findRecipeByExternalId,
};

app.get('/api/cookidoo/status', async (_req, res) => {
  const state = getCookidooState();
  if (!state.enabled) return res.json(state);
  try {
    const check = await cookidooCheck();
    res.json({
      ...state,
      reachable: true,
      user: check?.user?.username || '',
      subscription: check?.subscription?.status || '',
      subscriptionActive: Boolean(check?.subscription?.active),
    });
  } catch (err) {
    res.json({ ...state, reachable: false, error: err.message });
  }
});

// Abgleich anstoßen. Dauert länger als bei Mealie: für jedes Rezept muss die
// Brücke einmal bei Cookidoo nachfragen, und das absichtlich nacheinander.
app.post('/api/cookidoo/sync', async (_req, res) => {
  if (!cookidooEnabled()) {
    return res.status(400).json({
      error: 'Cookidoo ist nicht konfiguriert (COOKIDOO_URL auf die Brücke setzen).',
    });
  }
  try {
    const state = await syncFromCookidoo({ deps: cookidooDeps });
    if (state.status === 'error') return res.status(502).json(state);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cookidoos eigene Einkaufsliste ansehen …
app.get('/api/cookidoo/shopping', async (req, res) => {
  if (!cookidooEnabled()) {
    return res.status(400).json({ error: 'Cookidoo ist nicht konfiguriert.' });
  }
  try {
    res.json(await cookidooShoppingItems({ all: req.query.all === '1' }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// … und nach Bring schieben.
app.post('/api/cookidoo/shopping', async (req, res) => {
  if (!cookidooEnabled()) {
    return res.status(400).json({ error: 'Cookidoo ist nicht konfiguriert.' });
  }
  const { listUuid } = req.body || {};
  if (!listUuid) return res.status(400).json({ error: 'listUuid fehlt.' });
  try {
    const { items, recipes } = await cookidooShoppingItems({ all: Boolean(req.body.all) });
    if (!items.length) {
      return res.status(400).json({ error: 'Die Cookidoo-Einkaufsliste ist leer.' });
    }
    const imported = await importItemsToBring(listUuid, items);
    res.json({ imported, recipes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /plan.svg – Wochenplan als Bild, für Dashboards die keine Webseite
// einbetten können (FHEMVIZ zeigt `weblink image` bzw. `vizWidget image` an,
// einen `weblink iframe` nicht). Die Fotos müssen als data:-URI eingebettet
// werden: ein SVG in einem <img> lädt keine externen Bilder nach.
const svgCache = { at: 0, week: null, body: null };

async function collectImages(view) {
  const images = new Map();
  if (!mealieEnabled()) return images;
  const ids = new Map();
  for (const day of view.days) {
    const url = day.recipe?.image_url || '';
    const id = /^\/api\/mealie\/image\/(.+)$/.exec(url)?.[1];
    if (id) ids.set(day.recipe.id, id);
  }
  for (const [recipeId, mealieId] of ids) {
    try {
      const { body, type } = await fetchMealieImage(mealieId, { size: 'min-original' });
      images.set(recipeId, `data:${type};base64,${body.toString('base64')}`);
    } catch {
      /* ohne Bild geht es auch – dann steht ein Platzhalter im Bild */
    }
  }
  return images;
}

app.get('/plan.svg', async (req, res) => {
  const week = resolveWeek(req.query.week);
  if (!week) return res.status(400).end();
  // Eine Minute zwischenspeichern: die Kachel fragt regelmäßig nach, und jedes
  // Bild kostet sonst mehrere Abrufe bei Mealie.
  if (svgCache.body && svgCache.week === week && Date.now() - svgCache.at < 60000) {
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'max-age=60');
    return res.end(svgCache.body);
  }
  try {
    const view = buildWeekView(week);
    const svg = renderPlanSvg(view, await collectImages(view));
    Object.assign(svgCache, { at: Date.now(), week, body: svg });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'max-age=60');
    res.end(svg);
  } catch (err) {
    res.status(500).type('text/plain').end(err.message);
  }
});

// GET /api/mealie/image/:id – Rezeptbild aus Mealie durchleiten. Nötig, weil
// MEALIE_URL bei gemeinsamer Stack die interne Docker-Adresse ist und Mealies
// Medien je nach Einstellung den Token brauchen.
const imageCache = new Map(); // id|size -> {body, type, at}
const IMAGE_TTL_MS = 60 * 60 * 1000;

app.get('/api/mealie/image/:id', async (req, res) => {
  if (!mealieEnabled()) return res.status(404).end();
  const size = req.query.size === 'original' ? 'original' : 'min-original';
  const key = `${req.params.id}|${size}`;
  const hit = imageCache.get(key);
  if (hit && Date.now() - hit.at < IMAGE_TTL_MS) {
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(hit.body);
  }
  try {
    const image = await fetchMealieImage(req.params.id, { size });
    imageCache.set(key, { ...image, at: Date.now() });
    if (imageCache.size > 400) imageCache.delete(imageCache.keys().next().value);
    res.setHeader('Content-Type', image.type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(image.body);
  } catch {
    res.status(404).end();
  }
});

// POST /api/mealie/repair – schon vorhandene, unvollständig importierte
// Chefkoch-Rezepte aus der Chefkoch-API nachtragen. Betrifft nur Rezepte mit
// Chefkoch-Quelle, bei denen Zubereitung oder Zutaten fehlen.
app.post('/api/mealie/repair', async (_req, res) => {
  if (!mealieEnabled()) {
    return res.status(400).json({ error: 'Mealie ist nicht konfiguriert.' });
  }
  const candidates = getAllRecipes({ withIngredients: true }).filter(
    (r) =>
      r.source_slug &&
      !r.source_missing &&
      /chefkoch\.de\/rezepte\/\d+\//.test(r.source_url || '') &&
      // `incomplete` fängt die PLUS-Anrisse: die haben scheinbar genug Zutaten,
      // aber eine davon ist nur der Platzhalter.
      (!String(r.instructions || '').trim() ||
        r.incomplete ||
        realIngredients(r.ingredients).length <= 3)
  );

  const result = { checked: candidates.length, repaired: 0, unchanged: 0, failed: 0, names: [] };
  for (const recipe of candidates) {
    try {
      const { outcome, detail } = await repairThinMealieRecipe({
        slug: recipe.source_slug,
        sourceUrl: recipe.source_url,
      });
      if (outcome === 'repaired') {
        result.repaired += 1;
        result.names.push(recipe.name);
        // Direkt auffrischen: auf ein hochgezähltes `updatedAt` in Mealie ist
        // kein Verlass, der inkrementelle Abgleich würde das Rezept sonst
        // überspringen.
        const mapped = detail && mapMealieRecipe(detail, mealieConfig().url);
        if (mapped) upsertRecipeFromSource(mapped);
      } else {
        result.unchanged += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  res.json(result);
});

// POST /api/mealie/repair/:id – dasselbe für ein einzelnes Rezept, mit einer
// Antwort, die sagt was passiert ist. Die Sammel-Route meldet nur Zahlen; wer
// ein bestimmtes Rezept anreichern will, braucht den Grund, wenn es nicht geht.
app.post('/api/mealie/repair/:id', async (req, res) => {
  if (!mealieEnabled()) {
    return res.status(400).json({ error: 'Mealie ist nicht konfiguriert.' });
  }
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  if (!recipe.source_slug || recipe.source !== 'mealie') {
    return res.status(400).json({ error: 'Das Rezept kommt nicht aus Mealie.' });
  }
  if (!/chefkoch\.de\/rezepte\/\d+\//.test(recipe.source_url || '')) {
    return res.status(400).json({
      error:
        'Nachschlagen geht nur bei Chefkoch-Rezepten – hier fehlt eine Chefkoch-Quelle.',
    });
  }

  try {
    const { outcome, detail } = await repairThinMealieRecipe({
      slug: recipe.source_slug,
      sourceUrl: recipe.source_url,
    });
    // In beiden Fällen den Spiegel auffrischen: `updatedAt` zählt Mealie nach
    // einem PATCH nicht hoch, der inkrementelle Abgleich würde das überspringen.
    const mapped = detail && mapMealieRecipe(detail, mealieConfig().url);
    if (mapped) upsertRecipeFromSource(mapped);

    if (outcome === 'repaired') {
      return res.json({
        outcome,
        message: 'Zutaten und Zubereitung aus der Chefkoch-API nachgetragen.',
        recipe: getRecipeById(recipe.id),
      });
    }
    res.json({
      outcome,
      message:
        outcome === 'not-needed'
          ? 'Das Rezept ist in Mealie bereits vollständig – der Spiegel wurde aufgefrischt.'
          : 'Chefkoch gibt nicht mehr her als den Anriss. Solche Rezepte stehen ' +
            'hinter der PLUS-Schranke; da hilft nur, sie zu löschen oder von Hand ' +
            'in Mealie zu vervollständigen.',
      recipe: getRecipeById(recipe.id),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/mealie/orphans – was die Quelle nicht mehr kennt (Vorschau).
// Absichtlich unter /api/mealie/, damit es nicht mit /api/recipes/:id kollidiert.
app.get('/api/mealie/orphans', (_req, res) => {
  const orphans = getMissingRecipes();
  res.json({
    count: orphans.length,
    with_history: orphans.filter((r) => r.has_history).length,
    without_history: orphans.filter((r) => !r.has_history).length,
    items: orphans.map((r) => ({
      id: r.id,
      name: r.name,
      has_history: r.has_history,
      rating_count: r.rating_count,
      times_cooked: r.times_cooked,
    })),
  });
});

// DELETE /api/mealie/orphans?withHistory=1 – aufräumen.
// Ohne den Schalter bleiben Rezepte mit Bewertungen oder Plan-Einträgen stehen,
// damit man die Lern-Historie nicht versehentlich wegwirft.
app.delete('/api/mealie/orphans', (req, res) => {
  const withHistory = req.query.withHistory === '1' || req.body?.withHistory === true;
  const orphans = getMissingRecipes();
  const doomed = orphans.filter((r) => withHistory || !r.has_history);
  const deleted = deleteRecipes(doomed.map((r) => r.id));
  res.json({
    deleted,
    kept: orphans.length - deleted,
    names: doomed.map((r) => r.name),
  });
});

// DELETE /api/mealie/recipe/:id – löscht das Rezept in Mealie und räumt hier auf.
// Der Weg über die API ist verlässlich; in Mealies Oberfläche ist das Löschen
// einzelner Rezepte je nach Version schwer zu finden.
app.delete('/api/mealie/recipe/:id', async (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  if (!mealieEnabled()) {
    return res.status(400).json({ error: 'Mealie ist nicht konfiguriert.' });
  }
  if (!recipe.source_slug) {
    return res.status(400).json({ error: 'Dieses Rezept stammt nicht aus Mealie.' });
  }
  try {
    await deleteRecipeInMealie(recipe.source_slug);
    // Ohne Bewertungen und Plan-Einträge kann der Spiegel-Eintrag gleich weg,
    // sonst bleibt er als Historie stehen (markiert, nicht mehr würfelbar).
    if (recipeHasHistory(recipe.id)) {
      markRecipesMissing('mealie:', []);
      return res.json({
        deleted: true,
        kept: true,
        message:
          'In Mealie gelöscht. Hier bleibt das Rezept wegen seiner Bewertungen ' +
          'bzw. Plan-Einträge stehen – markiert und nicht mehr würfelbar. Mit ' +
          '„Endgültig löschen" verschwindet auch die Historie.',
      });
    }
    deleteRecipe(recipe.id);
    res.json({ deleted: true, kept: false });
  } catch (err) {
    res.status(502).json({ error: `Löschen in Mealie fehlgeschlagen: ${err.message}` });
  }
});

// POST /api/mealie/import-chefkoch – body: { query?, count? }
// Chefkoch-Suche liefert die URLs, Mealie importiert sie mit seinem eigenen
// Scraper, danach wird der Spiegel abgeglichen.
app.post('/api/mealie/import-chefkoch', (req, res) => {
  try {
    const job = startChefkochToMealieJob({
      query: String(req.body?.query || '').trim(),
      count: Number(req.body?.count) || 20,
      minRating: Number(req.body?.minRating) || 0,
      minVotes: Number(req.body?.minVotes) || 0,
      deps: mealieDeps,
    });
    res.status(202).json(job);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.get('/api/mealie/import-status', (_req, res) => {
  res.json(getChefkochJob() || { status: 'idle' });
});

app.post('/api/mealie/import-cancel', (_req, res) => {
  res.json({ cancelled: cancelChefkochJob(), job: getChefkochJob() });
});

// ── Rezepte von einer beliebigen Rezeptseite ──────────────────────────────────
//
// Übersichtsseite eines Koch-Blogs angeben, die App sammelt die Rezeptlinks
// ein und legt sie an (über Mealie, wenn Mealie eingerichtet ist).
// Absichtlich ohne blockWhenMealie: der Job entscheidet selbst, wohin.

// POST /api/recipes/import/site – body: { url, count?, pages?, dryRun? }
app.post('/api/recipes/import/site', (req, res) => {
  try {
    const job = startSiteImportJob({
      url: String(req.body?.url || '').trim(),
      count: Number(req.body?.count) || 20,
      pages: Number(req.body?.pages) || 3,
      dryRun: Boolean(req.body?.dryRun),
      deps: {
        ...mealieDeps,
        createRecipe,
        findRecipeByName,
        findRecipeBySourceUrlPart,
      },
    });
    res.status(202).json(job);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// GET /api/net-check?url=… – erreicht der Container diese Adresse?
// Gedacht für „fetch failed": zeigt Auflösung, Verbindung und Antwortcode
// getrennt, damit man DNS, Firewall und HTTP-Fehler unterscheiden kann.
app.get('/api/net-check', async (req, res) => {
  const ziele = req.query.url
    ? [String(req.query.url)]
    : [mealieConfig().url, 'https://www.chefkoch.de/', 'https://www.gaumenfreundin.de/'].filter(
        Boolean
      );
  const ergebnis = [];
  for (const url of ziele) {
    const started = Date.now();
    try {
      const antwort = await fetchOrExplain(
        url,
        {
          method: 'GET',
          headers: { 'User-Agent': 'BRING-Interface/net-check' },
          signal: AbortSignal.timeout(10000),
        },
        { was: url }
      );
      ergebnis.push({
        url,
        ok: true,
        status: antwort.status,
        ms: Date.now() - started,
      });
    } catch (err) {
      ergebnis.push({
        url,
        ok: false,
        code: err.code || '',
        error: err.message,
        ms: Date.now() - started,
      });
    }
  }
  res.json({ checks: ergebnis });
});

app.get('/api/recipes/import/site-status', (_req, res) => {
  res.json(getSiteJob() || { status: 'idle' });
});

app.post('/api/recipes/import/site-cancel', (_req, res) => {
  res.json({ cancelled: cancelSiteJob(), job: getSiteJob() });
});

// Adresse eines Rezepts in der Mealie-Oberfläche (für den Knopf in der Liste).
app.get('/api/mealie/recipe-url/:slug', (req, res) => {
  res.json({ url: mealieRecipeUrl(req.params.slug) });
});

// ── FHEM-Schnittstelle ────────────────────────────────────────────────────────
//
// Flache Werte für HTTPMOD (readingXXJSON) und Aktionen, die auch per GET
// gehen – so genügt in FHEM ein `GetFileFromURL(...)` bzw. ein setXXURL.

// Werte für FHEM entschärfen: Anführungszeichen, Backslashes und Zeilenumbrüche
// würden die Regex-Auswertung in HTTPMOD ("<key>":"([^"]*)") zerreißen. Die
// Regex-Variante ist nötig, weil HTTPMOD bei der JSON-Auswertung Umlaute zu
// Perl-Wide-Chars dekodiert und FHEM sie dann falsch ausgibt ("Gef?llte").
function fhemValue(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\\"]/g, "'")
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Absolute Adresse für Bilder in den Readings. FHEMVIZ läuft im Browser unter
// einer anderen Adresse als diese App – ein relativer Pfad ginge dort ins Leere.
// Ohne PUBLIC_URL nehmen wir die Adresse, unter der die Anfrage hereinkam
// (hinter dem Reverse Proxy dank `trust proxy` die öffentliche).
function publicBase(req) {
  const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (!req) return '';
  return `${req.protocol}://${req.get('host')}`;
}

function fhemImageUrl(recipe, base, token) {
  const raw = String(recipe?.image_url || '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw; // Cookidoo liefert absolute Adressen
  if (!base) return '';
  // Unser Bild-Proxy liegt hinter der Anmeldung – der Token muss mit, sonst
  // zeigt die Kachel nur einen kaputten Platzhalter.
  const sep = raw.includes('?') ? '&' : '?';
  return token ? `${base}${raw}${sep}token=${encodeURIComponent(token)}` : `${base}${raw}`;
}

function fhemPlanPayload(req = null) {
  const base = publicBase(req);
  const token = String(req?.query?.token || '');
  // Rollendes Fenster ab heute statt starr Mo–So: an einem Freitag will
  // niemand im Wandtablet noch lesen, was es am Montag gab. Die Reading-Namen
  // bleiben die Wochentage – ein schon vergangener Wochentag zeigt jetzt die
  // KOMMENDE Woche, nicht die vergangene.
  const heute = todayIso();
  const week = weekOf(heute);
  const view = buildWeekView(week);
  const naechste = buildWeekView(shiftWeek(week, 1));
  const fenster = [...view.days, ...naechste.days]
    .filter((d) => d.date >= heute)
    .slice(0, 7);

  const today = fenster[0] || null;
  const tomorrowDate = addDays(heute, 1);
  const tomorrow = fenster.find((d) => d.date === tomorrowDate) || null;
  const taste = tasteSummary();

  const payload = {
    week: view.week,
    from: fenster[0]?.date || view.from,
    to: fenster[fenster.length - 1]?.date || view.to,
    planned: fenster.filter((d) => d.recipe).length,
    empty: fenster.filter((d) => !d.recipe).length,
    today: today?.recipe?.name || '',
    today_id: today?.recipe?.id || 0,
    today_time: today?.recipe?.prep_time || '',
    today_status: today?.status || 'empty',
    today_rating: today?.rating
      ? today.rating.kind === 'rejected'
        ? 'rausgeflogen'
        : String(today.rating.stars)
      : '',
    today_stars: today?.rating?.stars || 0,
    tomorrow: tomorrow?.recipe?.name || '',
    // Vorlauf: was man heute Abend noch anfangen muss, damit es morgen klappt.
    today_prep: today?.recipe?.prep_hint || '',
    tomorrow_prep: tomorrow?.recipe?.prep_hint || '',
    today_img: fhemImageUrl(today?.recipe, base, token),
    tomorrow_img: fhemImageUrl(tomorrow?.recipe, base, token),
    recipe_count: taste.recipe_count,
    rated_count: taste.rated_count,
    updated: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  for (const [i, day] of fenster.entries()) {
    payload[day.key] = day.recipe?.name || '';
    payload[`${day.key}_status`] = day.status;
    payload[`${day.key}_stars`] = day.rating?.stars || 0;
    payload[`${day.key}_img`] = fhemImageUrl(day.recipe, base, token);
    // Datum dazu: sonst ist nicht erkennbar, ob "mo" diese oder nächste Woche
    // meint – und die Kachel kann die Tage ab heute sortieren.
    payload[`${day.key}_datum`] = day.date;
    payload[`tag${i + 1}_key`] = day.key;
  }
  payload.state = payload.today ? `Heute: ${payload.today}` : 'Heute: nichts geplant';
  for (const [key, value] of Object.entries(payload)) payload[key] = fhemValue(value);
  return payload;
}

app.get('/api/fhem/plan', (req, res) => {
  res.json(fhemPlanPayload(req));
});

// Würfeln: ?scope=week|day (day + ?date=today|tomorrow|YYYY-MM-DD), ?onlyEmpty=1
function handleFhemRoll(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const scope = String(params.scope || 'day').toLowerCase();
  const onlyEmpty = String(params.onlyEmpty || '') === '1' || params.onlyEmpty === true;
  try {
    if (scope === 'week' || scope === 'woche') {
      const week = resolveWeek(params.week);
      if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
      rollWeek(week, { onlyEmpty });
      syncPlanToMealie(weekDates(week));
    } else {
      const date = resolveDate(params.date);
      if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });
      rollDays([date], { overwrite: !onlyEmpty });
      syncPlanToMealie(date);
    }
    res.json(fhemPlanPayload(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/fhem/roll', handleFhemRoll);
app.post('/api/fhem/roll', handleFhemRoll);

// Abgleich mit Mealies Menüplan auf Knopfdruck. Nötig ist das nicht – der
// Abgleich läuft von allein alle paar Minuten –, aber wer die Ansage morgens um
// sechs macht, will nicht auf das nächste Intervall warten.
async function handleFhemSync(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const week = resolveWeek(params.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  if (!mealieEnabled()) {
    return res.status(400).json({ error: 'Mealie ist nicht konfiguriert.' });
  }
  try {
    await reconcilePlanWeek(week);
    res.json(fhemPlanPayload(req));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

app.get('/api/fhem/sync', handleFhemSync);
app.post('/api/fhem/sync', handleFhemSync);

// Außentemperatur von FHEM entgegennehmen: ?temp=8.5
// Der Würfel bevorzugt damit bei Kälte Eintopf und bei Hitze Salat – aber nur
// für heute und morgen, weiter voraus sagt ein Messwert nichts (dann zählt der
// Monat).
function handleFhemWeather(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const temp = Number(String(params.temp ?? params.temperature ?? '').replace(',', '.'));
  if (!Number.isFinite(temp) || temp < -50 || temp > 60) {
    return res.status(400).json({ error: 'temp fehlt oder ist unplausibel.' });
  }
  setSetting('weatherTemp', String(temp));
  setSetting('weatherAt', new Date().toISOString());
  res.json({ temp, bias: climateBias(todayIso(), currentWeather()) || 'neutral' });
}

app.get('/api/fhem/weather', handleFhemWeather);
app.post('/api/fhem/weather', handleFhemWeather);

// Bewerten: ?rating=lecker|gut|ok|maessig|schlecht|rausgeflogen|nie_wieder&date=today
function handleFhemRate(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const date = resolveDate(params.date);
  if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });
  const entry = getPlanEntry(date);
  if (!entry || !entry.recipe_id) {
    return res.status(400).json({ error: 'Für diesen Tag ist kein Rezept eingeplant.' });
  }
  const resolved = resolveRating(params);
  if (!resolved) return res.status(400).json({ error: 'Bewertung unbekannt.' });
  applyRating({
    recipeId: entry.recipe_id,
    planDate: date,
    resolved,
    comment: params.comment,
  });
  res.json(fhemPlanPayload(req));
}

app.get('/api/fhem/rate', handleFhemRate);
app.post('/api/fhem/rate', handleFhemRate);

// Wocheneinkauf nach Bring schieben (Liste optional, sonst die zuletzt benutzte).
async function handleFhemShopping(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const week = resolveWeek(params.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  const listUuid = params.list || params.listUuid || getSetting('lastListUuid');
  if (!listUuid) {
    return res.status(400).json({ error: 'Keine Bring-Liste angegeben oder gemerkt.' });
  }
  try {
    const { items } = weekShoppingItems(week, { skipCooked: params.all !== '1' });
    const imported = await importItemsToBring(listUuid, items);
    res.json({ imported: imported.length, items: imported, week });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/fhem/shopping', handleFhemShopping);
app.post('/api/fhem/shopping', handleFhemShopping);

// ── Start ─────────────────────────────────────────────────────────────────────

// Nur lauschen, wenn die Datei direkt gestartet wurde (`node server.js`).
// Beim Import aus den Tests bleibt der Port frei; die Tests öffnen selbst einen.
const startedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (startedDirectly) {
  app.listen(PORT, () => {
    console.log(`BRING-Interface läuft auf http://localhost:${PORT}`);
  });

  // Mealie-Spiegel beim Start und danach im Intervall abgleichen.
  if (mealieEnabled()) {
    const { url, syncMinutes } = mealieConfig();
    console.log(`Mealie als Rezeptquelle: ${url} (Abgleich alle ${syncMinutes} Min.)`);
    const run = () =>
      syncFromMealie({ deps: mealieDeps })
        .then((state) => {
          if (state.status === 'error') {
            console.warn(`Mealie-Abgleich fehlgeschlagen: ${state.error}`);
          } else {
            console.log(
              `Mealie-Abgleich: ${state.added} neu, ${state.updated} geändert, ` +
                `${state.unchanged} unverändert, ${state.missing} verschwunden`
            );
          }
        })
        .catch((err) => console.warn(`Mealie-Abgleich fehlgeschlagen: ${err.message}`))
        // Danach der Menüplan: was in Mealie geplant wurde, gilt auch hier.
        // Diese und die nächste Woche reichen – ältere Tage sind Geschichte.
        .then(async () => {
          if (!mealieConfig().pullPlan) return;
          const thisWeek = weekOf(todayIso());
          for (const week of [thisWeek, shiftWeek(thisWeek, 1)]) {
            const r = await reconcilePlanWeek(week);
            if (r.pulled || r.cleared) {
              console.log(
                `Menüplan ${week}: ${r.pulled} aus Mealie übernommen, ${r.cleared} entfernt`
              );
            }
          }
        })
        .catch((err) => console.warn(`Menüplan-Abgleich fehlgeschlagen: ${err.message}`));
    run();
    setInterval(run, syncMinutes * 60 * 1000).unref();
  }

  // Cookidoo genauso, nur seltener: für jedes Rezept fragt die Brücke einmal
  // einzeln bei Cookidoo nach, das muss nicht alle 15 Minuten passieren.
  if (cookidooEnabled()) {
    const { url, syncMinutes } = cookidooConfig();
    console.log(`Cookidoo über die Brücke ${url} (Abgleich alle ${syncMinutes} Min.)`);
    const run = () =>
      syncFromCookidoo({ deps: cookidooDeps })
        .then((state) => {
          if (state.status === 'error') {
            console.warn(`Cookidoo-Abgleich fehlgeschlagen: ${state.error}`);
          } else {
            console.log(
              `Cookidoo-Abgleich: ${state.added} neu, ${state.updated} geändert, ` +
                `${state.missing} verschwunden, ${state.failed} Fehler`
            );
          }
        })
        .catch((err) => console.warn(`Cookidoo-Abgleich fehlgeschlagen: ${err.message}`));
    run();
    setInterval(run, syncMinutes * 60 * 1000).unref();
  }
}

export { app };
