// Geschmacksprofil und Gewichtung für die Würfelfunktion.
//
// Alles hier ist reine Rechnerei ohne Datenbank – die Aufrufer übergeben
// Rezepte und Bewertungen als einfache Objekte (siehe `mealplan.js`).

import { ingredientKeys, isPantryItem, normalizeName } from './normalize.js';
import { DEFAULT_MAIN_TAGS, DEFAULT_SIDE_TAGS } from './course.js';

// Tags, die nichts über den Geschmack sagen. „Hauptgerichte" hängt an fast
// jedem Abendessen, „Thermomix" an allem aus Cookidoo – landen sie im Profil,
// wertet ein einziges aussortiertes Rezept gleich eine ganze Gattung ab.
// Die Gang-Kategorien stehen schon in course.js, die nehmen wir von dort.
const IGNORED_TAGS = new Set(
  [
    ...DEFAULT_MAIN_TAGS,
    ...DEFAULT_SIDE_TAGS,
    'Thermomix',
    'Cookidoo',
    'Chefkoch',
    'Rezept',
    'Rezepte',
  ].map((t) => normalizeName(t))
);

// Bewertung -> Wert (-1 … +1) und Gewicht.
// Gekocht und 5 Sterne zählt voll positiv, "rausgeflogen ohne zu kochen"
// negativ, aber schwächer: es sagt etwas über die Lust aus, nicht über den
// Geschmack.
export function ratingValue(rating) {
  if (!rating) return null;
  if (rating.kind === 'rejected') return { value: -0.8, weight: 0.6 };
  const stars = Number(rating.stars);
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) return null;
  return { value: (stars - 3) / 2, weight: 1 };
}

function accumulate(map, key, label, value, weight) {
  let entry = map.get(key);
  if (!entry) {
    entry = { key, label, sum: 0, weight: 0, count: 0 };
    map.set(key, entry);
  }
  entry.sum += value * weight;
  entry.weight += weight;
  entry.count += 1;
}

function finalize(map, { minCount = 2 } = {}) {
  return [...map.values()]
    .map((e) => ({
      key: e.key,
      label: e.label,
      count: e.count,
      score: e.weight === 0 ? 0 : e.sum / e.weight, // -1 … +1
      confidence: e.count / (e.count + 2), // 1 Bewertung zählt wenig
    }))
    .filter((e) => e.count >= minCount)
    .sort((a, b) => b.score * b.confidence - a.score * a.confidence);
}

// Baut aus den Bewertungen ein Profil über Zutaten und Tags.
// `recipes`: [{ id, ingredients: [{name}], tags: [] }]
// `ratings`: [{ recipe_id, kind, stars }]
export function buildTasteProfile(recipes, ratings) {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const ingMap = new Map();
  const tagMap = new Map();

  for (const rating of ratings) {
    const recipe = byId.get(rating.recipe_id);
    if (!recipe) continue;
    const val = ratingValue(rating);
    if (!val) continue;

    // Zutaten einmal je Rezept zählen (Dubletten innerhalb eines Rezepts
    // sollen das Profil nicht verzerren).
    const seen = new Set();
    for (const ing of recipe.ingredients || []) {
      if (isPantryItem(ing.name)) continue;
      const key = normalizeName(ing.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      accumulate(ingMap, key, ing.name, val.value, val.weight);
    }

    const seenTags = new Set();
    for (const tag of recipe.tags || []) {
      const key = normalizeName(tag);
      if (!key || seenTags.has(key) || IGNORED_TAGS.has(key)) continue;
      seenTags.add(key);
      accumulate(tagMap, key, tag, val.value, val.weight);
    }
  }

  const ingredients = finalize(ingMap);
  const tags = finalize(tagMap);
  return {
    ingredients,
    tags,
    ingredientIndex: new Map(ingredients.map((e) => [e.key, e])),
    tagIndex: new Map(tags.map((e) => [e.key, e])),
    liked: ingredients.filter((e) => e.score >= 0.25).slice(0, 12),
    disliked: [...ingredients].reverse().filter((e) => e.score <= -0.25).slice(0, 12),
    likedTags: tags.filter((e) => e.score >= 0.25).slice(0, 8),
    dislikedTags: [...tags].reverse().filter((e) => e.score <= -0.25).slice(0, 8),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Wie gut passt ein (auch noch unbewertetes) Rezept zum gelernten Geschmack?
// 1.0 = neutral, >1 beliebte Zutaten/Tags, <1 unbeliebte.
export function tasteFactor(recipe, profile) {
  if (!profile) return 1;
  const pick = (values) =>
    values.length === 0
      ? 0
      : values.reduce((a, b) => a + b, 0) / values.length;

  const ingScores = [];
  const seen = new Set();
  for (const ing of recipe.ingredients || []) {
    if (isPantryItem(ing.name)) continue;
    const key = normalizeName(ing.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = profile.ingredientIndex?.get(key);
    if (entry) ingScores.push(entry.score * entry.confidence);
  }

  const tagScores = [];
  for (const tag of recipe.tags || []) {
    const entry = profile.tagIndex?.get(normalizeName(tag));
    if (entry) tagScores.push(entry.score * entry.confidence);
  }

  return clamp(1 + 0.6 * pick(ingScores) + 0.4 * pick(tagScores), 0.35, 2.2);
}

// Eigene Bewertung des Rezepts -> Faktor. 3 Sterne = neutral.
function ownRatingFactor(recipe) {
  const count = Number(recipe.rating_count || 0);
  if (!count) return 1.3; // noch nie bewertet: leichter Neugier-Bonus
  const avg = clamp(Number(recipe.avg_stars) || 3, 1, 5);
  const table = { 1: 0.15, 2: 0.45, 3: 1.0, 4: 2.0, 5: 3.0 };
  const low = Math.floor(avg);
  const high = Math.min(5, low + 1);
  const frac = avg - low;
  const factor = table[low] + (table[high] - table[low]) * frac;
  // Jedes "rausgeflogen" dämpft zusätzlich.
  const rejected = Number(recipe.rejected_count || 0);
  return factor * (rejected > 0 ? Math.max(0.1, 0.25 ** rejected) : 1);
}

// Kürzlich gekocht -> unwahrscheinlicher.
function recencyFactor(recipe, daysSinceCooked) {
  if (daysSinceCooked === null || daysSinceCooked === undefined) return 1;
  if (daysSinceCooked < 7) return 0.05;
  if (daysSinceCooked < 14) return 0.25;
  if (daysSinceCooked < 28) return 0.6;
  if (daysSinceCooked < 60) return 0.9;
  return 1;
}

// Gesamtgewicht eines Rezepts für die Würfelfunktion. 0 = kommt nicht in Frage.
export function recipeWeight(recipe, profile, { excludeIds = new Set(), daysSinceCooked } = {}) {
  // `source_missing`: in Mealie gelöscht – bleibt wegen der Bewertungshistorie
  // gespeichert, wird aber nicht mehr vorgeschlagen.
  if (recipe.blocked || recipe.source_missing) return 0;
  if (excludeIds.has(recipe.id)) return 0;
  const weight =
    ownRatingFactor(recipe) *
    tasteFactor(recipe, profile) *
    recencyFactor(recipe, daysSinceCooked);
  return weight > 0 ? weight : 0;
}

// Gewichtete Zufallsauswahl. `random` ist injizierbar (Tests).
export function pickWeighted(items, weights, random = Math.random) {
  const total = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (total <= 0) return null;
  let threshold = random() * total;
  for (let i = 0; i < items.length; i += 1) {
    const w = weights[i] > 0 ? weights[i] : 0;
    threshold -= w;
    if (threshold < 0) return items[i];
  }
  return items[items.length - 1] ?? null;
}

// Beschreibt in einem Satz, warum ein Rezept vorgeschlagen wurde – landet als
// Notiz im Plan und macht die Würfelfunktion nachvollziehbar.
export function explainPick(recipe, profile) {
  const bits = [];
  if (Number(recipe.rating_count || 0) === 0) bits.push('mal was Neues');
  else bits.push(`bisher ⌀ ${Number(recipe.avg_stars).toFixed(1)}★`);
  const factor = tasteFactor(recipe, profile);
  if (factor >= 1.15) bits.push('passt zum Geschmack');
  else if (factor <= 0.85) bits.push('eher untypisch für uns');
  return bits.join(', ');
}

export { ingredientKeys };
