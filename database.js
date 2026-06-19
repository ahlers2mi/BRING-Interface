import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'recipes.db'));

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
`);

export function getAllRecipes() {
  return db.prepare('SELECT * FROM recipes ORDER BY name').all();
}

export function getRecipeById(id) {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!recipe) return null;
  recipe.ingredients = db
    .prepare('SELECT * FROM ingredients WHERE recipe_id = ? ORDER BY id')
    .all(id);
  return recipe;
}

export function createRecipe({ name, description, ingredients = [] }) {
  const info = db
    .prepare('INSERT INTO recipes (name, description) VALUES (?, ?)')
    .run(name, description || null);
  const recipeId = info.lastInsertRowid;
  const insertIng = db.prepare(
    'INSERT INTO ingredients (recipe_id, name, amount) VALUES (?, ?, ?)'
  );
  for (const ing of ingredients) {
    insertIng.run(recipeId, ing.name, ing.amount || null);
  }
  return getRecipeById(recipeId);
}

export function updateRecipe(id, { name, description, ingredients }) {
  db.prepare('UPDATE recipes SET name = ?, description = ? WHERE id = ?').run(
    name,
    description || null,
    id
  );
  if (Array.isArray(ingredients)) {
    db.prepare('DELETE FROM ingredients WHERE recipe_id = ?').run(id);
    const insertIng = db.prepare(
      'INSERT INTO ingredients (recipe_id, name, amount) VALUES (?, ?, ?)'
    );
    for (const ing of ingredients) {
      insertIng.run(id, ing.name, ing.amount || null);
    }
  }
  return getRecipeById(id);
}

export function deleteRecipe(id) {
  db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
}
