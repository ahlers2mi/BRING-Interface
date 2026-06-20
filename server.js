import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Bring from 'bring-shopping';
import { registerAuth, authEnabled } from './auth.js';
import {
  getAllRecipes,
  getRecipeById,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  getSetting,
  setSetting,
} from './database.js';

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
  try {
    await getBringClient();
    res.json({ loggedIn: true, mail: process.env.BRING_MAIL, authEnabled });
  } catch (err) {
    res.json({ loggedIn: false, error: err.message, authEnabled });
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

// POST /api/lists/:uuid/items  – body: { items: [{name, amount}] }
app.post('/api/lists/:uuid/items', async (req, res) => {
  try {
    const client = await getBringClient();
    const items =
      req.body.items && Array.isArray(req.body.items)
        ? req.body.items
        : parseItems(req.body.text || '');

    const results = [];
    for (const item of items) {
      await client.saveItem(req.params.uuid, item.name, item.amount || '');
      results.push(item.name);
    }
    setSetting('lastListUuid', req.params.uuid);
    res.json({ imported: results });
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
  const { name, description, source_url, instructions, prep_time, ingredients } =
    req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich.' });
  }
  const recipe = createRecipe({
    name: name.trim(),
    description,
    source_url,
    instructions,
    prep_time,
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

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`BRING-Interface läuft auf http://localhost:${PORT}`);
});
