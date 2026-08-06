import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Bring from 'bring-shopping';
import { registerAuth, authEnabled, apiTokenEnabled } from './auth.js';
import {
  getAllRecipes,
  getRecipeById,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  setRecipeBlocked,
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
} from './database.js';
import {
  buildWeekView,
  fridgeSearch,
  rollDays,
  rollWeek,
  tasteSummary,
  weekShoppingItems,
} from './lib/mealplan.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
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

app.get('/api/preferences', (_req, res) => {
  res.json({ lastListUuid: getSetting('lastListUuid') });
});

app.put('/api/preferences', (req, res) => {
  if (typeof req.body.lastListUuid === 'string') {
    setSetting('lastListUuid', req.body.lastListUuid);
  }
  res.json({ lastListUuid: getSetting('lastListUuid') });
});

app.get('/api/status', async (_req, res) => {
  const base = {
    authEnabled,
    apiTokenEnabled,
    aiEnabled: Boolean(process.env.OPENROUTER_API_KEY),
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

app.post('/api/recipes', (req, res) => {
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

app.get('/api/recipes/:id', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  res.json(recipe);
});

app.put('/api/recipes/:id', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
  const updated = updateRecipe(Number(req.params.id), req.body);
  res.json(updated);
});

app.delete('/api/recipes/:id', (req, res) => {
  const recipe = getRecipeById(Number(req.params.id));
  if (!recipe) return res.status(404).json({ error: 'Rezept nicht gefunden.' });
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

    const client = await getBringClient();
    const imported = [];
    for (const ing of recipe.ingredients) {
      await client.saveItem(listUuid, ing.name, ing.amount || '');
      imported.push(ing.name);
    }
    setSetting('lastListUuid', listUuid);
    res.json({ imported });
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

app.get('/api/plan', (req, res) => {
  const week = resolveWeek(req.query.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  res.json(buildWeekView(week));
});

// POST /api/plan/roll – body: { week?, date?, dates?, onlyEmpty? }
// Würfelt einen Tag, mehrere Tage oder die ganze Woche.
app.post('/api/plan/roll', (req, res) => {
  const { date, dates, onlyEmpty } = req.body || {};

  if (date || Array.isArray(dates)) {
    const list = (Array.isArray(dates) ? dates : [date]).map(resolveDate);
    if (list.some((d) => !d)) {
      return res.status(400).json({ error: 'Ungültiges Datum.' });
    }
    const results = rollDays(list, { overwrite: !onlyEmpty });
    return res.json({ results, plan: buildWeekView(weekOf(list[0])) });
  }

  const week = resolveWeek(req.body?.week);
  if (!week) return res.status(400).json({ error: 'Ungültige Woche.' });
  const results = rollWeek(week, { onlyEmpty: Boolean(onlyEmpty) });
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
  res.json({ entry, plan: buildWeekView(weekOf(date)) });
});

app.delete('/api/plan/:date', (req, res) => {
  const date = resolveDate(req.params.date);
  if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });
  deletePlanEntry(date);
  res.json({ success: true, plan: buildWeekView(weekOf(date)) });
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
    res.json({ imported, recipes });
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

// POST /api/recipes/import/url – body: { url, save?, ai? }
// Holt ein Rezept von einer Webseite (schema.org-Daten, bei Chefkoch die API).
app.post('/api/recipes/import/url', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Bitte eine vollständige http(s)-URL angeben.' });
  }
  try {
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
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recipes/import/chefkoch – body: { query?, count? }
// Startet den Massenimport im Hintergrund (Fortschritt via /status).
app.post('/api/recipes/import/chefkoch', (req, res) => {
  try {
    const job = startImportJob({
      query: String(req.body?.query || '').trim(),
      count: Number(req.body?.count) || 50,
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

function fhemPlanPayload() {
  const week = weekOf(todayIso());
  const view = buildWeekView(week);
  const today = view.days.find((d) => d.isToday) || null;
  const tomorrowDate = addDays(todayIso(), 1);
  const tomorrow = view.days.find((d) => d.date === tomorrowDate) || null;
  const taste = tasteSummary();

  const payload = {
    week: view.week,
    from: view.from,
    to: view.to,
    planned: view.planned,
    empty: view.empty,
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
    recipe_count: taste.recipe_count,
    rated_count: taste.rated_count,
    updated: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  for (const day of view.days) {
    payload[day.key] = day.recipe?.name || '';
    payload[`${day.key}_status`] = day.status;
    payload[`${day.key}_stars`] = day.rating?.stars || 0;
  }
  payload.state = payload.today ? `Heute: ${payload.today}` : 'Heute: nichts geplant';
  for (const [key, value] of Object.entries(payload)) payload[key] = fhemValue(value);
  return payload;
}

app.get('/api/fhem/plan', (_req, res) => {
  res.json(fhemPlanPayload());
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
    } else {
      const date = resolveDate(params.date);
      if (!date) return res.status(400).json({ error: 'Ungültiges Datum.' });
      rollDays([date], { overwrite: !onlyEmpty });
    }
    res.json(fhemPlanPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/fhem/roll', handleFhemRoll);
app.post('/api/fhem/roll', handleFhemRoll);

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
  res.json(fhemPlanPayload());
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
}

export { app };
