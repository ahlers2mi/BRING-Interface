import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { todayIso } from './lib/week.js';
import { isIncompleteRecipe, prepHint } from './lib/normalize.js';
import { courseConfig, courseOf, courseReason } from './lib/course.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, 'recipes.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    amount TEXT,
    FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Bewertungen: "gekocht und geschmeckt" (kind='cooked', stars 1–5) oder
  -- "rausgeflogen, ohne gekocht zu werden" (kind='rejected', stars NULL).
  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL,
    plan_date TEXT,
    kind TEXT NOT NULL DEFAULT 'cooked',
    stars INTEGER,
    comment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
  );

  -- Wochenplan: ein Eintrag je Kalendertag.
  CREATE TABLE IF NOT EXISTS meal_plan (
    date TEXT PRIMARY KEY,
    recipe_id INTEGER,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ingredients_recipe ON ingredients(recipe_id);
  CREATE INDEX IF NOT EXISTS idx_ratings_recipe ON ratings(recipe_id);
  CREATE INDEX IF NOT EXISTS idx_plan_recipe ON meal_plan(recipe_id);
`);

// Migration: neue Rezept-Spalten ergänzen, falls noch nicht vorhanden.
const recipeColumns = db
  .prepare('PRAGMA table_info(recipes)')
  .all()
  .map((c) => c.name);
const NEW_RECIPE_COLUMNS = {
  source_url: 'TEXT',
  instructions: 'TEXT',
  prep_time: 'TEXT',
  servings: 'TEXT',
  image_url: 'TEXT',
  tags: 'TEXT',
  source: 'TEXT',
  external_id: 'TEXT',
  blocked: 'INTEGER NOT NULL DEFAULT 0',
  // Spiegel-Verwaltung für externe Quellen (Mealie):
  source_slug: 'TEXT',
  source_updated_at: 'TEXT',
  source_missing: 'INTEGER NOT NULL DEFAULT 0',
  // Abendessen oder nur Beilage/Dip/Dessert? Leer = automatisch nach den
  // Kategorien entscheiden (siehe lib/course.js), 'main'/'side' = von Hand.
  course: 'TEXT',
};
for (const [col, type] of Object.entries(NEW_RECIPE_COLUMNS)) {
  if (!recipeColumns.includes(col)) {
    db.exec(`ALTER TABLE recipes ADD COLUMN ${col} ${type}`);
  }
}
// Woher ein Plan-Eintrag stammt: 'app' (hier gewürfelt/gesetzt) oder 'mealie'
// (aus Mealies Menüplan geholt). Nur damit lässt sich erkennen, dass ein Tag in
// Mealie gelöscht wurde und hier ebenfalls weg soll.
const planColumns = db
  .prepare('PRAGMA table_info(meal_plan)')
  .all()
  .map((c) => c.name);
if (!planColumns.includes('origin')) {
  db.exec(`ALTER TABLE meal_plan ADD COLUMN origin TEXT NOT NULL DEFAULT 'app'`);
}
// Wann die Zutaten dieses Tages nach Bring geschoben wurden. Gesetzt heißt:
// dafür ist schon eingekauft – der Würfel lässt den Tag beim Wochenwurf in
// Ruhe, sonst liegt das Essen im Kühlschrank und steht nicht mehr im Plan.
if (!planColumns.includes('shopped_at')) {
  db.exec(`ALTER TABLE meal_plan ADD COLUMN shopped_at TEXT`);
}

// Doppelte Importe verhindern (external_id z. B. "chefkoch:1234").
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_external
     ON recipes(external_id) WHERE external_id IS NOT NULL`
);

// ── Einstellungen ─────────────────────────────────────────────────────────────

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function tagsToText(tags) {
  if (!tags) return null;
  const list = Array.isArray(tags)
    ? tags
    : String(tags).split(',');
  const clean = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
  return clean.length ? clean.join(', ') : null;
}

function tagsToArray(text) {
  if (!text) return [];
  return String(text)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// Zusammengefasste Bewertungs-Kennzahlen je Rezept.
function ratingStats() {
  const rows = db
    .prepare(
      `SELECT recipe_id,
              COUNT(*) AS rating_count,
              AVG(stars) AS avg_stars
         FROM ratings
        WHERE kind = 'cooked' AND stars IS NOT NULL
        GROUP BY recipe_id`
    )
    .all();
  const rejected = db
    .prepare(
      `SELECT recipe_id, COUNT(*) AS rejected_count
         FROM ratings WHERE kind = 'rejected' GROUP BY recipe_id`
    )
    .all();
  // Gekocht-Termine aus Plan und Bewertungen zusammenführen (UNION entdoppelt
  // gleiche Tage, wenn beides eingetragen wurde).
  const cooked = db
    .prepare(
      `SELECT recipe_id, MAX(d) AS last_cooked, COUNT(*) AS times_cooked FROM (
         SELECT recipe_id, date AS d FROM meal_plan
          WHERE status = 'cooked' AND recipe_id IS NOT NULL
         UNION
         SELECT recipe_id, plan_date AS d FROM ratings
          WHERE kind = 'cooked' AND plan_date IS NOT NULL
       ) GROUP BY recipe_id`
    )
    .all();

  const map = new Map();
  const get = (id) => {
    let e = map.get(id);
    if (!e) {
      e = {
        rating_count: 0,
        avg_stars: null,
        rejected_count: 0,
        last_cooked: null,
        times_cooked: 0,
      };
      map.set(id, e);
    }
    return e;
  };
  for (const r of rows) {
    const e = get(r.recipe_id);
    e.rating_count = r.rating_count;
    e.avg_stars = r.avg_stars;
  }
  for (const r of rejected) get(r.recipe_id).rejected_count = r.rejected_count;
  for (const r of cooked) {
    const e = get(r.recipe_id);
    e.last_cooked = r.last_cooked;
    e.times_cooked = r.times_cooked;
  }
  return map;
}

// Die Listen stehen in den Einstellungen; einmal je Abfrage lesen reicht.
export function currentCourseConfig() {
  return courseConfig({
    sideTags: getSetting('courseSideTags'),
    mainTags: getSetting('courseMainTags'),
  });
}

function decorate(recipe, stats, courses = currentCourseConfig()) {
  const s = stats?.get(recipe.id) || {};
  const tags = tagsToArray(recipe.tags);
  const withTags = { ...recipe, tags };
  return {
    ...recipe,
    blocked: Boolean(recipe.blocked),
    source_missing: Boolean(recipe.source_missing),
    tags,
    // Abendessen oder Beilage/Dip/Dessert? Entscheidet mit, ob gewürfelt wird.
    course: courseOf(withTags, courses),
    course_manual: recipe.course || null,
    course_reason: courseReason(withTags, courses),
    // Braucht das Gericht Vorlauf (auftauen, einweichen)? Steht nirgends als
    // Feld, aber fast immer im Text.
    prep_hint: prepHint({ ...recipe, tags }),
    rating_count: s.rating_count || 0,
    avg_stars: s.avg_stars ?? null,
    rejected_count: s.rejected_count || 0,
    last_cooked: s.last_cooked || null,
    times_cooked: s.times_cooked || 0,
  };
}

// ── Rezepte ───────────────────────────────────────────────────────────────────

// Alle Rezepte inkl. Zutaten und Bewertungs-Kennzahlen – eine Abfrage je
// Tabelle, damit auch 200+ Rezepte in einem Rutsch geladen werden können.
export function getAllRecipes({ withIngredients = true } = {}) {
  const stats = ratingStats();
  const courses = currentCourseConfig(); // einmal lesen, nicht je Rezept
  const recipes = db
    .prepare('SELECT * FROM recipes ORDER BY name COLLATE NOCASE')
    .all()
    .map((r) => decorate(r, stats, courses));

  if (withIngredients) {
    const byId = new Map(recipes.map((r) => [r.id, r]));
    for (const r of recipes) r.ingredients = [];
    const ings = db
      .prepare('SELECT id, recipe_id, name, amount FROM ingredients ORDER BY id')
      .all();
    for (const ing of ings) byId.get(ing.recipe_id)?.ingredients.push(ing);
    // Angerissene Chefkoch-PLUS-Rezepte kenntlich machen (siehe normalize.js).
    for (const r of recipes) r.incomplete = isIncompleteRecipe(r);
  }
  return recipes;
}

export function getRecipeById(id) {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!recipe) return null;
  const full = decorate(recipe, ratingStats());
  full.ingredients = db
    .prepare('SELECT * FROM ingredients WHERE recipe_id = ? ORDER BY id')
    .all(id);
  full.incomplete = isIncompleteRecipe(full);
  full.ratings = db
    .prepare('SELECT * FROM ratings WHERE recipe_id = ? ORDER BY created_at DESC')
    .all(id);
  return full;
}

export function findRecipeByExternalId(externalId) {
  if (!externalId) return null;
  return (
    db.prepare('SELECT * FROM recipes WHERE external_id = ?').get(externalId) || null
  );
}

export function findRecipeByName(name) {
  if (!name) return null;
  return (
    db
      .prepare('SELECT * FROM recipes WHERE name = ? COLLATE NOCASE')
      .get(String(name).trim()) || null
  );
}

const insertRecipeStmt = db.prepare(
  `INSERT INTO recipes
     (name, description, source_url, instructions, prep_time, servings,
      image_url, tags, source, external_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertIngredientStmt = db.prepare(
  'INSERT INTO ingredients (recipe_id, name, amount) VALUES (?, ?, ?)'
);

export function createRecipe({
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
  ingredients = [],
}) {
  const insert = db.transaction(() => {
    const info = insertRecipeStmt.run(
      name,
      description || null,
      source_url || null,
      instructions || null,
      prep_time || null,
      servings || null,
      image_url || null,
      tagsToText(tags),
      source || 'manuell',
      external_id || null
    );
    const recipeId = info.lastInsertRowid;
    for (const ing of ingredients) {
      if (!ing || !String(ing.name || '').trim()) continue;
      insertIngredientStmt.run(recipeId, String(ing.name).trim(), ing.amount || null);
    }
    return recipeId;
  });
  return getRecipeById(insert());
}

export function updateRecipe(id, fields) {
  const current = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!current) return null;
  const value = (key, fallbackNull = true) =>
    Object.prototype.hasOwnProperty.call(fields, key)
      ? fields[key] || (fallbackNull ? null : '')
      : current[key];

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE recipes
          SET name = ?, description = ?, source_url = ?, instructions = ?,
              prep_time = ?, servings = ?, image_url = ?, tags = ?, blocked = ?
        WHERE id = ?`
    ).run(
      Object.prototype.hasOwnProperty.call(fields, 'name') && fields.name
        ? String(fields.name).trim()
        : current.name,
      value('description'),
      value('source_url'),
      value('instructions'),
      value('prep_time'),
      value('servings'),
      value('image_url'),
      Object.prototype.hasOwnProperty.call(fields, 'tags')
        ? tagsToText(fields.tags)
        : current.tags,
      Object.prototype.hasOwnProperty.call(fields, 'blocked')
        ? fields.blocked
          ? 1
          : 0
        : current.blocked,
      id
    );
    if (Array.isArray(fields.ingredients)) {
      db.prepare('DELETE FROM ingredients WHERE recipe_id = ?').run(id);
      for (const ing of fields.ingredients) {
        if (!ing || !String(ing.name || '').trim()) continue;
        insertIngredientStmt.run(id, String(ing.name).trim(), ing.amount || null);
      }
    }
  });
  run();
  return getRecipeById(id);
}

export function deleteRecipe(id) {
  db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
}

// ── Spiegel einer externen Quelle (Mealie) ────────────────────────────────────

// external_id -> { id, source_updated_at } für alle Rezepte einer Quelle.
export function getSourceIndex(prefix) {
  const rows = db
    .prepare(
      `SELECT id, external_id, source_updated_at FROM recipes
        WHERE external_id LIKE ? || '%'`
    )
    .all(prefix);
  return new Map(rows.map((r) => [r.external_id, r]));
}

// Rezept aus der Quelle einfügen oder aktualisieren (Schlüssel: external_id).
// Bewertungen und Plan-Einträge bleiben erhalten, weil die id stehen bleibt.
export function upsertRecipeFromSource(recipe) {
  const existing = recipe.external_id ? findRecipeByExternalId(recipe.external_id) : null;
  if (!existing) {
    const created = createRecipe(recipe);
    db.prepare(
      `UPDATE recipes SET source_slug = ?, source_updated_at = ?, source_missing = 0
        WHERE id = ?`
    ).run(recipe.source_slug || null, recipe.source_updated_at || null, created.id);
    return getRecipeById(created.id);
  }
  const updated = updateRecipe(existing.id, {
    ...recipe,
    // `blocked` gehört uns, nicht der Quelle – nicht überschreiben.
    blocked: existing.blocked,
  });
  db.prepare(
    `UPDATE recipes SET source_slug = ?, source_updated_at = ?, source_missing = 0
      WHERE id = ?`
  ).run(recipe.source_slug || null, recipe.source_updated_at || null, existing.id);
  return updated ? getRecipeById(existing.id) : null;
}

// Alles, was die Quelle nicht mehr kennt, als fehlend markieren (nicht löschen –
// daran hängen Bewertungen und die Plan-Historie). Rückgabe: Anzahl.
export function markRecipesMissing(prefix, keepExternalIds) {
  const keep = new Set(keepExternalIds);
  const rows = db
    .prepare(`SELECT id, external_id FROM recipes WHERE external_id LIKE ? || '%'`)
    .all(prefix);
  const setMissing = db.prepare('UPDATE recipes SET source_missing = ? WHERE id = ?');
  let missing = 0;
  for (const row of rows) {
    const gone = !keep.has(row.external_id);
    setMissing.run(gone ? 1 : 0, row.id);
    if (gone) missing += 1;
  }
  return missing;
}

// Gibt es schon ein Rezept, dessen Quell-URL diesen Teil enthält?
// (Für den Chefkoch-Weg: "/rezepte/<id>/" ist eindeutig.)
export function findRecipeBySourceUrlPart(part) {
  if (!part) return null;
  const row = db
    .prepare(`SELECT id FROM recipes WHERE source_url LIKE '%' || ? || '%' LIMIT 1`)
    .get(part);
  return row ? getRecipeById(row.id) : null;
}

// Hängen an dem Rezept Bewertungen oder Plan-Einträge? Dann ist es Historie und
// wird beim Löschen in der Quelle nur markiert, nicht entfernt.
export function recipeHasHistory(id) {
  const ratings = db
    .prepare('SELECT COUNT(*) AS n FROM ratings WHERE recipe_id = ?')
    .get(id).n;
  const planned = db
    .prepare('SELECT COUNT(*) AS n FROM meal_plan WHERE recipe_id = ?')
    .get(id).n;
  return ratings + planned > 0;
}

// Alle Rezepte, die die Quelle nicht mehr kennt – mit dem Hinweis, ob Historie
// dranhängt (Bewertungen oder Plan-Einträge).
export function getMissingRecipes() {
  const stats = ratingStats();
  return db
    .prepare('SELECT * FROM recipes WHERE source_missing = 1 ORDER BY name COLLATE NOCASE')
    .all()
    .map((r) => {
      const full = decorate(r, stats);
      return { ...full, has_history: recipeHasHistory(r.id) };
    });
}

// Löscht mehrere Rezepte in einer Transaktion. Rückgabe: Anzahl.
export function deleteRecipes(ids) {
  const stmt = db.prepare('DELETE FROM recipes WHERE id = ?');
  const run = db.transaction((list) => {
    let n = 0;
    for (const id of list) {
      if (stmt.run(id).changes) n += 1;
    }
    return n;
  });
  return run(ids);
}

// Bild-Adressen aus früheren Abgleichen geradeziehen: absolute Adressen auf die
// Mealie-Instanz (oft die interne Docker-Adresse) lädt kein Browser.
export function normalizeMealieImageUrls() {
  const info = db
    .prepare(
      `UPDATE recipes
          SET image_url = '/api/mealie/image/' || substr(external_id, 8)
        WHERE external_id LIKE 'mealie:%'
          AND image_url IS NOT NULL
          AND image_url LIKE 'http%'`
    )
    .run();
  return info.changes;
}

export function getRecipeBySlug(slug) {
  const row = db.prepare('SELECT id FROM recipes WHERE source_slug = ?').get(slug);
  return row ? getRecipeById(row.id) : null;
}

export function setRecipeBlocked(id, blocked) {
  db.prepare('UPDATE recipes SET blocked = ? WHERE id = ?').run(blocked ? 1 : 0, id);
  return getRecipeById(id);
}

// 'main' | 'side' | null (null = wieder automatisch nach den Kategorien)
export function setRecipeCourse(id, course) {
  const value = course === 'main' || course === 'side' ? course : null;
  db.prepare('UPDATE recipes SET course = ? WHERE id = ?').run(value, id);
  return getRecipeById(id);
}

// ── Bewertungen ───────────────────────────────────────────────────────────────

// kind: 'cooked' (mit stars 1–5) oder 'rejected' (aussortiert, ohne Kochen).
export function addRating({ recipe_id, plan_date, kind = 'cooked', stars, comment }) {
  const date = plan_date || todayIso();
  const info = db
    .prepare(
      `INSERT INTO ratings (recipe_id, plan_date, kind, stars, comment)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      recipe_id,
      date,
      kind,
      kind === 'cooked' && Number.isFinite(Number(stars)) ? Number(stars) : null,
      comment || null
    );
  return db.prepare('SELECT * FROM ratings WHERE id = ?').get(info.lastInsertRowid);
}

export function deleteRating(id) {
  db.prepare('DELETE FROM ratings WHERE id = ?').run(id);
}

export function getAllRatings() {
  return db.prepare('SELECT * FROM ratings ORDER BY created_at').all();
}

export function getRatingHistory(limit = 50) {
  return db
    .prepare(
      `SELECT ra.*, r.name AS recipe_name
         FROM ratings ra
         LEFT JOIN recipes r ON r.id = ra.recipe_id
        ORDER BY ra.created_at DESC, ra.id DESC
        LIMIT ?`
    )
    .all(limit);
}

// ── Wochenplan ────────────────────────────────────────────────────────────────

export function getPlanRange(fromDate, toDate) {
  return db
    .prepare(
      `SELECT mp.*, r.name AS recipe_name, r.prep_time, r.source_url, r.image_url,
              r.blocked AS recipe_blocked
         FROM meal_plan mp
         LEFT JOIN recipes r ON r.id = mp.recipe_id
        WHERE mp.date BETWEEN ? AND ?
        ORDER BY mp.date`
    )
    .all(fromDate, toDate)
    .map((row) => ({ ...row, recipe_blocked: Boolean(row.recipe_blocked) }));
}

export function getPlanEntry(date) {
  const row = db
    .prepare(
      `SELECT mp.*, r.name AS recipe_name
         FROM meal_plan mp
         LEFT JOIN recipes r ON r.id = mp.recipe_id
        WHERE mp.date = ?`
    )
    .get(date);
  return row || null;
}

export function setPlanEntry({ date, recipe_id, note, status = 'planned', origin = 'app' }) {
  db.prepare(
    `INSERT INTO meal_plan (date, recipe_id, note, status, origin, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       recipe_id = excluded.recipe_id,
       note = excluded.note,
       status = excluded.status,
       origin = excluded.origin,
       -- Eingekauft gilt für ein bestimmtes Gericht: bleibt das Rezept, bleibt
       -- die Markierung; kommt ein anderes, ist der Einkauf hinfällig.
       -- (IS statt = , sonst greift der Vergleich bei NULL nicht.)
       shopped_at = CASE
         WHEN meal_plan.recipe_id IS excluded.recipe_id THEN meal_plan.shopped_at
         ELSE NULL
       END,
       updated_at = datetime('now')`
  ).run(date, recipe_id ?? null, note || null, status, origin);
  return getPlanEntry(date);
}

/** Tag als eingekauft markieren (oder die Markierung nehmen). */
export function setPlanShopped(date, shopped = true) {
  db.prepare(
    `UPDATE meal_plan
        SET shopped_at = ${shopped ? "datetime('now')" : 'NULL'},
            updated_at = datetime('now')
      WHERE date = ?`
  ).run(date);
  return getPlanEntry(date);
}

export function updatePlanStatus(date, status) {
  db.prepare(
    `UPDATE meal_plan SET status = ?, updated_at = datetime('now') WHERE date = ?`
  ).run(status, date);
  return getPlanEntry(date);
}

export function deletePlanEntry(date) {
  db.prepare('DELETE FROM meal_plan WHERE date = ?').run(date);
}

// Rezept-IDs, die in einem Zeitraum schon eingeplant sind (für "nicht zweimal
// in derselben Woche").
export function getPlannedRecipeIds(fromDate, toDate) {
  return db
    .prepare(
      `SELECT DISTINCT recipe_id FROM meal_plan
        WHERE recipe_id IS NOT NULL AND date BETWEEN ? AND ?`
    )
    .all(fromDate, toDate)
    .map((r) => r.recipe_id);
}

export default db;
