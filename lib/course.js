// Ist ein Rezept ein Abendessen – oder nur ein Dip, eine Beilage, ein Kuchen?
//
// Der Würfel hat bisher jedes Rezept genommen. In Mealie stehen die Kategorien
// aber schon dran (Mealies `recipeCategory` landet zusammen mit den Tags in
// unserem `tags`-Feld), und die reichen für die Einordnung fast immer aus.
//
// Reihenfolge der Entscheidung:
//   1. `course` am Rezept – von Hand gesetzt, schlägt alles
//   2. ein Tag aus der Haupt-Liste ("Hauptgericht") -> Abendessen
//   3. ein Tag aus der Beilagen-Liste ("Dip", "Dessert") -> keins
//   4. der Name spricht dafür ("Kräuterdip", "Vanillesauce") -> keins
//   5. sonst Abendessen – im Zweifel lieber vorschlagen als verschlucken

import { normalizeName } from './normalize.js';

// Mealies deutsche Standardkategorien und das, was in Rezeptsammlungen sonst
// üblich ist. Änderbar über die Einstellungen, das hier ist nur der Anfang.
export const DEFAULT_SIDE_TAGS = [
  'Beilage',
  'Beilagen',
  'Dip',
  'Dips',
  'Sauce',
  'Saucen',
  'Soße',
  'Soßen',
  'Dressing',
  'Aufstrich',
  'Brotaufstrich',
  'Vorspeise',
  'Vorspeisen',
  'Dessert',
  'Desserts',
  'Nachtisch',
  'Nachspeise',
  'Süßspeise',
  'Kuchen',
  'Torte',
  'Gebäck',
  'Backen',
  'Brot',
  'Brötchen',
  'Frühstück',
  'Snack',
  'Snacks',
  'Fingerfood',
  'Getränk',
  'Getränke',
  'Cocktail',
  'Smoothie',
  'Marmelade',
  'Konfitüre',
  'Gewürzmischung',
  'Grundrezept',
];

export const DEFAULT_MAIN_TAGS = [
  'Hauptgericht',
  'Hauptgerichte',
  'Hauptspeise',
  'Abendessen',
  'Mittagessen',
];

// Notnagel für Rezepte ohne Kategorie – die kommen bei Chefkoch-Importen vor.
// Bewusst knapp: nur Wörter, die praktisch nie ein Abendessen benennen.
// "Kuchen" steht ausdrücklich NICHT drin (Zwiebelkuchen, Flammkuchen), "Eis"
// auch nicht (Eisbein, Reis).
const NAME_ENDINGS = [
  'dip',
  'dips',
  'dressing',
  'aufstrich',
  'pesto',
  'sauce',
  'soße',
  'sosse',
  'torte',
  'muffins',
  'plätzchen',
  'kekse',
  'smoothie',
  'marmelade',
  'konfitüre',
  'likör',
  'sirup',
];

// "Nudeln mit Pesto" ist ein Abendessen, "Basilikumpesto" nicht. Steht vor dem
// letzten Wort eine solche Verbindung, beschreibt das Wort nur die Zutat.
const CONNECTORS = new Set([
  'mit',
  'und',
  'dazu',
  'an',
  'auf',
  'in',
  'im',
  'zu',
  'ohne',
  'nach',
]);

function splitList(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value)
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Aus den Einstellungen gelesene Listen – leerer Wert = Standard. */
export function courseConfig({ sideTags, mainTags } = {}) {
  return {
    sideTags: splitList(sideTags, DEFAULT_SIDE_TAGS),
    mainTags: splitList(mainTags, DEFAULT_MAIN_TAGS),
  };
}

function nameLooksLikeSide(name) {
  const words = String(name || '')
    .toLowerCase()
    .split(/[\s,()–]+/)
    .filter(Boolean);
  const last = words[words.length - 1];
  if (!last) return false;
  // "… mit Pesto" beschreibt eine Beilage zum Hauptgericht, nicht das Gericht.
  if (words.slice(0, -1).some((w) => CONNECTORS.has(w))) return false;
  // Endung zählt, damit auch Zusammensetzungen greifen: Kräuterdip, Joghurt-Dip.
  const tail = last.split('-').pop() || last;
  return NAME_ENDINGS.some((end) => tail === end || tail.endsWith(end));
}

/**
 * 'main' = kann als Abendessen gewürfelt werden, 'side' = nicht.
 * `config` kommt aus courseConfig().
 */
export function courseOf(recipe, config = courseConfig()) {
  if (!recipe) return 'main';
  const manual = String(recipe.course || '').trim();
  if (manual === 'main' || manual === 'side') return manual;

  const tags = new Set((recipe.tags || []).map((t) => normalizeName(t)).filter(Boolean));
  const has = (list) => list.some((t) => tags.has(normalizeName(t)));

  if (has(config.mainTags)) return 'main';
  if (has(config.sideTags)) return 'side';
  if (nameLooksLikeSide(recipe.name)) return 'side';
  return 'main';
}

export function isMainDish(recipe, config) {
  return courseOf(recipe, config) === 'main';
}

/** Warum wurde so entschieden? Für die Anzeige in der Rezeptliste. */
export function courseReason(recipe, config = courseConfig()) {
  const manual = String(recipe?.course || '').trim();
  if (manual === 'main') return 'von Hand als Abendessen gesetzt';
  if (manual === 'side') return 'von Hand ausgenommen';

  const tags = (recipe?.tags || []).filter(Boolean);
  const hit = (list) =>
    tags.find((t) => list.some((l) => normalizeName(l) === normalizeName(t)));

  const main = hit(config.mainTags);
  if (main) return `Kategorie „${main}"`;
  const side = hit(config.sideTags);
  if (side) return `Kategorie „${side}"`;
  if (nameLooksLikeSide(recipe?.name)) return 'nach dem Namen';
  return 'keine Kategorie – gilt als Abendessen';
}
