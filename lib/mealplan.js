// Wochenplan-Logik: Würfeln, Wochenansicht, Reste-Suche und Einkaufsliste
// für eine ganze Woche. Bindeglied zwischen Datenbank und HTTP-Routen.

import {
  getAllRecipes,
  getAllRatings,
  getPlanRange,
  getPlannedRecipeIds,
  setPlanEntry,
} from '../database.js';
import {
  buildTasteProfile,
  explainPick,
  pickWeighted,
  recipeWeight,
  tasteFactor,
} from './taste.js';
import {
  WEEKDAYS,
  daysBetween,
  formatDayLabel,
  todayIso,
  weekDates,
  weekOf,
  weekdayKey,
} from './week.js';
import { matchRecipeToFridge, normalizeName } from './normalize.js';

// Rezepte + Bewertungen + gelerntes Profil in einem Rutsch.
export function loadContext() {
  const recipes = getAllRecipes({ withIngredients: true });
  const ratings = getAllRatings();
  const profile = buildTasteProfile(recipes, ratings);
  return { recipes, ratings, profile };
}

// ── Würfeln ───────────────────────────────────────────────────────────────────

// Vier Stufen: erst mit allen Einschränkungen, dann schrittweise gelockert,
// damit auch bei wenigen Rezepten immer etwas herauskommt.
const RELAXATIONS = [
  { excludeWeek: true, recency: true, label: '' },
  { excludeWeek: false, recency: true, label: 'Woche schon voll – Rezept wiederholt' },
  { excludeWeek: false, recency: false, label: 'zuletzt erst gekocht' },
  { excludeWeek: false, recency: false, ignoreTaste: true, label: 'freie Auswahl' },
];

function weightsFor(recipes, profile, { excludeIds, today, relax }) {
  return recipes.map((recipe) => {
    if (recipe.blocked || recipe.source_missing) return 0;
    if (relax.excludeWeek && excludeIds.has(recipe.id)) return 0;
    if (relax.ignoreTaste) return 1;
    const daysSince = relax.recency
      ? recipe.last_cooked
        ? daysBetween(recipe.last_cooked, today)
        : null
      : null;
    return recipeWeight(recipe, profile, {
      excludeIds: new Set(),
      daysSinceCooked: daysSince,
    });
  });
}

// Würfelt ein Rezept für einen Tag. `excludeIds` sind Rezepte, die in derselben
// Woche schon eingeplant sind. Gibt null zurück, wenn es keine Rezepte gibt.
export function rollRecipe({
  recipes,
  profile,
  excludeIds = new Set(),
  today = todayIso(),
  random = Math.random,
}) {
  const usable = recipes.filter((r) => !r.blocked && !r.source_missing);
  if (!usable.length) return null;

  for (const relax of RELAXATIONS) {
    const weights = weightsFor(usable, profile, { excludeIds, today, relax });
    const picked = pickWeighted(usable, weights, random);
    if (picked) {
      const reason = [explainPick(picked, profile), relax.label]
        .filter(Boolean)
        .join(' · ');
      return { recipe: picked, reason };
    }
  }
  return null;
}

// Würfelt für einzelne Tage und schreibt das Ergebnis in den Plan.
// `dates` müssen gültige ISO-Tage sein.
export function rollDays(dates, { overwrite = true, random = Math.random } = {}) {
  const { recipes, profile } = loadContext();
  const results = [];
  const today = todayIso();

  for (const date of dates) {
    const week = weekOf(date);
    const weekRange = weekDates(week);
    const existing = getPlanRange(weekRange[0], weekRange[6]);
    const current = existing.find((e) => e.date === date);

    if (!overwrite && current && current.recipe_id) {
      results.push({ date, skipped: true, entry: current });
      continue;
    }
    // Gekochte Tage nie überschreiben – die sind Historie.
    if (current && current.status === 'cooked') {
      results.push({ date, skipped: true, entry: current });
      continue;
    }

    const excludeIds = new Set(
      existing
        .filter((e) => e.date !== date && e.recipe_id)
        .map((e) => e.recipe_id)
    );
    const rolled = rollRecipe({ recipes, profile, excludeIds, today, random });
    if (!rolled) {
      results.push({ date, error: 'Keine passenden Rezepte vorhanden.' });
      continue;
    }
    const entry = setPlanEntry({
      date,
      recipe_id: rolled.recipe.id,
      note: rolled.reason || null,
      status: 'planned',
    });
    results.push({ date, entry, recipe: rolled.recipe, reason: rolled.reason });
  }
  return results;
}

// Ganze Woche würfeln. `onlyEmpty` lässt belegte Tage stehen.
export function rollWeek(week, { onlyEmpty = false, random = Math.random } = {}) {
  const dates = weekDates(week);
  if (!dates) return null;
  return rollDays(dates, { overwrite: !onlyEmpty, random });
}

// ── Wochenansicht ─────────────────────────────────────────────────────────────

export function buildWeekView(week) {
  const dates = weekDates(week);
  if (!dates) return null;

  const { recipes, ratings, profile } = loadContext();
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const entries = new Map(getPlanRange(dates[0], dates[6]).map((e) => [e.date, e]));
  const ratingByDay = new Map();
  for (const rating of ratings) {
    if (rating.plan_date) ratingByDay.set(`${rating.plan_date}|${rating.recipe_id}`, rating);
  }

  const today = todayIso();
  const days = dates.map((date, i) => {
    const entry = entries.get(date) || null;
    const recipe = entry?.recipe_id ? byId.get(entry.recipe_id) || null : null;
    const rating = entry?.recipe_id
      ? ratingByDay.get(`${date}|${entry.recipe_id}`) || null
      : null;
    return {
      date,
      key: WEEKDAYS[i].key,
      label: WEEKDAYS[i].long,
      short: WEEKDAYS[i].short,
      dateLabel: formatDayLabel(date),
      isToday: date === today,
      isPast: date < today,
      status: entry?.status || 'empty',
      note: entry?.note || null,
      recipe: recipe
        ? {
            id: recipe.id,
            name: recipe.name,
            prep_time: recipe.prep_time,
            source_url: recipe.source_url,
            tags: recipe.tags,
            avg_stars: recipe.avg_stars,
            rating_count: recipe.rating_count,
            times_cooked: recipe.times_cooked,
            last_cooked: recipe.last_cooked,
            blocked: recipe.blocked,
            ingredient_count: (recipe.ingredients || []).length,
            taste_factor: Number(tasteFactor(recipe, profile).toFixed(2)),
          }
        : null,
      rating: rating
        ? { id: rating.id, kind: rating.kind, stars: rating.stars, comment: rating.comment }
        : null,
    };
  });

  return {
    week,
    from: dates[0],
    to: dates[6],
    today,
    todayKey: weekdayKey(today),
    days,
    planned: days.filter((d) => d.recipe).length,
    empty: days.filter((d) => !d.recipe).length,
  };
}

// ── Einkaufsliste für die Woche ───────────────────────────────────────────────

// Fasst die Zutaten aller eingeplanten Rezepte zusammen. Gleiche Zutaten
// werden zusammengelegt, die Mengen dahinter aufgelistet ("500 g + 2 EL"),
// weil sich Einheiten nicht verlässlich addieren lassen.
export function weekShoppingItems(week, { skipCooked = true } = {}) {
  const view = buildWeekView(week);
  if (!view) return null;
  const recipes = new Map(
    getAllRecipes({ withIngredients: true }).map((r) => [r.id, r])
  );

  const merged = new Map();
  const usedRecipes = [];
  for (const day of view.days) {
    if (!day.recipe) continue;
    if (skipCooked && day.status === 'cooked') continue;
    const recipe = recipes.get(day.recipe.id);
    if (!recipe) continue;
    usedRecipes.push({ date: day.date, name: recipe.name });
    for (const ing of recipe.ingredients || []) {
      const key = normalizeName(ing.name);
      const entry = merged.get(key);
      if (entry) {
        if (ing.amount) entry.amounts.push(ing.amount);
      } else {
        merged.set(key, {
          name: ing.name,
          amounts: ing.amount ? [ing.amount] : [],
        });
      }
    }
  }

  const items = [...merged.values()].map((e) => ({
    name: e.name,
    amount: e.amounts.join(' + '),
  }));
  return { week, items, recipes: usedRecipes };
}

// ── Reste-Suche ───────────────────────────────────────────────────────────────

// Sucht Rezepte, die zu den eingegebenen Resten passen.
// `have`: Liste von Zutaten aus dem Kühlschrank (Freitext, eine je Eintrag).
export function fridgeSearch(
  have,
  { assumePantry = true, limit = 20, includeBlocked = false } = {}
) {
  const haveList = have
    .map((h) => String(h || '').trim())
    .filter((h) => h.length >= 2);
  if (!haveList.length) return { have: [], results: [] };

  const { recipes, profile } = loadContext();
  const results = [];

  for (const recipe of recipes) {
    if ((recipe.blocked || recipe.source_missing) && !includeBlocked) continue;
    const ingredients = recipe.ingredients || [];
    if (!ingredients.length) continue;
    const match = matchRecipeToFridge(ingredients, haveList, { assumePantry });
    if (!match.matched.length) continue;

    // Ranking: Abdeckung zuerst, dann Anzahl Treffer, dann Geschmack –
    // "kaum was fehlt" ist beim Restekochen das wichtigste Kriterium.
    const taste = tasteFactor(recipe, profile);
    const stars = recipe.rating_count ? Number(recipe.avg_stars) : null;
    const score =
      match.coverage * 100 +
      match.matched.length * 6 -
      match.missing.length * 2 +
      (taste - 1) * 8 +
      (stars ? (stars - 3) * 3 : 0);

    results.push({
      recipe: {
        id: recipe.id,
        name: recipe.name,
        prep_time: recipe.prep_time,
        source_url: recipe.source_url,
        tags: recipe.tags,
        avg_stars: recipe.avg_stars,
        rating_count: recipe.rating_count,
        blocked: recipe.blocked,
      },
      coverage: Number(match.coverage.toFixed(2)),
      matched: match.matched.map((m) => ({
        name: m.name,
        amount: m.amount,
        matchedWith: m.matchedWith,
      })),
      missing: match.missing.map((m) => ({ name: m.name, amount: m.amount })),
      score: Number(score.toFixed(1)),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return { have: haveList, results: results.slice(0, limit) };
}

// ── Geschmacksprofil für die Oberfläche ───────────────────────────────────────

export function tasteSummary() {
  const { recipes, ratings, profile } = loadContext();
  const cooked = ratings.filter((r) => r.kind === 'cooked' && r.stars);
  const avg =
    cooked.length === 0
      ? null
      : cooked.reduce((sum, r) => sum + Number(r.stars), 0) / cooked.length;

  const scored = recipes
    .filter((r) => r.rating_count > 0)
    .sort((a, b) => Number(b.avg_stars) - Number(a.avg_stars));

  return {
    recipe_count: recipes.length,
    rated_count: scored.length,
    rating_count: ratings.length,
    rejected_count: ratings.filter((r) => r.kind === 'rejected').length,
    blocked_count: recipes.filter((r) => r.blocked).length,
    avg_stars: avg === null ? null : Number(avg.toFixed(2)),
    favourites: scored.slice(0, 8).map((r) => ({
      id: r.id,
      name: r.name,
      avg_stars: Number(Number(r.avg_stars).toFixed(1)),
      rating_count: r.rating_count,
    })),
    flops: scored
      .slice(-8)
      .reverse()
      .filter((r) => Number(r.avg_stars) < 3)
      .map((r) => ({
        id: r.id,
        name: r.name,
        avg_stars: Number(Number(r.avg_stars).toFixed(1)),
        rating_count: r.rating_count,
      })),
    liked_ingredients: profile.liked.map((e) => ({
      name: e.label,
      score: Number(e.score.toFixed(2)),
      count: e.count,
    })),
    disliked_ingredients: profile.disliked.map((e) => ({
      name: e.label,
      score: Number(e.score.toFixed(2)),
      count: e.count,
    })),
    liked_tags: profile.likedTags.map((e) => ({
      name: e.label,
      score: Number(e.score.toFixed(2)),
      count: e.count,
    })),
    disliked_tags: profile.dislikedTags.map((e) => ({
      name: e.label,
      score: Number(e.score.toFixed(2)),
      count: e.count,
    })),
  };
}

export { getPlannedRecipeIds };
