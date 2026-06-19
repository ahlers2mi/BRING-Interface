import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Bring from 'bring-shopping';
import {
  getAllRecipes,
  getRecipeById,
  createRecipe,
  updateRecipe,
  deleteRecipe,
} from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

app.get('/api/status', async (_req, res) => {
  try {
    await getBringClient();
    res.json({ loggedIn: true, mail: process.env.BRING_MAIL });
  } catch (err) {
    res.json({ loggedIn: false, error: err.message });
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

app.post('/api/recipes', (req, res) => {
  const { name, description, ingredients } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich.' });
  }
  const recipe = createRecipe({ name: name.trim(), description, ingredients });
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
    res.json({ imported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`BRING-Interface läuft auf http://localhost:${PORT}`);
});
