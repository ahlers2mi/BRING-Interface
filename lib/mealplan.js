// Wochenplan-Logik: Würfeln, Wochenansicht, Reste-Suche und Einkaufsliste
// für eine ganze Woche. Bindeglied zwischen Datenbank und HTTP-Routen.

import {
  getAllRecipes,
  getAllRatings,
  getPlanRange,
  getPlannedRecipeIds,
  getSetting,
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
import { matchRecipeToFridge, normalizeName, realIngredients } from './normalize.js';
import { parseMinutes, scaleFactor, scaleIngredients } from './scale.js';
import {
  climateBias,
  DEFAULT_COLD_C,
  DEFAULT_WARM_C,
  weatherFactor,
} from './climate.js';
import { mealieRecipeUrl } from './mealie.js';

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

// Wie viele Portionen der Haushalt braucht. Steckt in den Einstellungen, damit
// es geräteübergreifend gilt und nicht in der Umgebung des Containers klebt.
export function householdServings() {
  const stored = Number(getSetting('householdServings'));
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
}

// Unter der Woche zählt, dass es schnell geht – am Wochenende darf es dauern.
// Ohne Zeitangabe wird nicht bestraft: dann weiß die Quelle es eben nicht, und
// das Rezept deswegen auszusortieren wäre die schlechtere Wette.
const QUICK_MINUTES = Math.max(10, Number(process.env.PLAN_QUICK_MINUTES || 40));

// Dauerhafte Vorgaben für den Würfel. Liegen in den Einstellungen, damit sie
// ohne Neubau des Containers änderbar sind; die Umgebung ist nur noch der
// Anfangswert.
export function planSettings() {
  const zahl = (key, fallback, min, max) => {
    // Achtung: Number(null) und Number('') sind 0 – bei den Temperaturen läge
    // das im erlaubten Bereich, und der Standardwert käme nie zum Zug.
    const roh = getSetting(key);
    if (roh === null || roh === undefined || String(roh).trim() === '') return fallback;
    const wert = Number(roh);
    return Number.isFinite(wert) && wert >= min && wert <= max ? wert : fallback;
  };
  return {
    quickMinutes: zahl('planQuickMinutes', QUICK_MINUTES, 10, 240),
    coldC: zahl('planColdC', DEFAULT_COLD_C, -30, 40),
    warmC: zahl('planWarmC', DEFAULT_WARM_C, -30, 50),
  };
}

export function effortFactor(recipe, date, { quickMinutes = QUICK_MINUTES } = {}) {
  const minutes = parseMinutes(recipe.prep_time);
  if (!minutes || !date) return 1;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sonntag
  const weekend = day === 0 || day === 6;

  if (weekend) return minutes > quickMinutes ? 1.3 : 1;
  if (minutes <= quickMinutes) return 1;
  if (minutes <= quickMinutes * 2) return 0.4;
  return 0.15;
}

// Zuletzt gemeldete Außentemperatur (FHEM schickt sie an /api/fhem/weather).
export function currentWeather() {
  const temp = Number(getSetting('weatherTemp'));
  return {
    temp: Number.isFinite(temp) ? temp : null,
    measuredAt: getSetting('weatherAt') || null,
  };
}

/**
 * Vorgabe „höchstens X Minuten". Anders als der Aufwands-Faktor ist das eine
 * Ansage, kein Wunsch: was länger dauert, fällt raus. Rezepte **ohne**
 * Zeitangabe bleiben drin, werden aber gedämpft – sie ganz auszuschließen
 * würde bei Quellen ohne Zeitangabe die halbe Sammlung schlucken.
 */
function timeLimitFactor(recipe, maxMinutes) {
  if (!maxMinutes) return 1;
  const minutes = parseMinutes(recipe.prep_time);
  if (!minutes) return 0.3;
  return minutes <= maxMinutes ? 1 : 0;
}

function weightsFor(
  recipes,
  profile,
  { excludeIds, today, relax, date, bias, quickMinutes, maxMinutes }
) {
  return recipes.map((recipe) => {
    // Angerissene Rezepte (Chefkoch PLUS) kann man nicht kochen – nicht würfeln.
    if (recipe.blocked || recipe.source_missing || recipe.incomplete) return 0;
    // Dips, Beilagen, Kuchen sind kein Abendessen – auch nicht in der letzten
    // Lockerungsstufe, sonst landen sie am Ende doch auf dem Teller.
    if (recipe.course === 'side') return 0;
    if (relax.excludeWeek && excludeIds.has(recipe.id)) return 0;
    // Die Zeitgrenze gilt auch in der letzten Stufe – wer „30 Minuten" sagt,
    // meint es.
    const zeit = timeLimitFactor(recipe, maxMinutes);
    if (!zeit) return 0;
    if (relax.ignoreTaste) return zeit;
    const daysSince = relax.recency
      ? recipe.last_cooked
        ? daysBetween(recipe.last_cooked, today)
        : null
      : null;
    const base = recipeWeight(recipe, profile, {
      excludeIds: new Set(),
      daysSinceCooked: daysSince,
    });
    return (
      base * effortFactor(recipe, date, { quickMinutes }) * weatherFactor(recipe, bias) * zeit
    );
  });
}

// Würfelt ein Rezept für einen Tag. `excludeIds` sind Rezepte, die in derselben
// Woche schon eingeplant sind. Gibt null zurück, wenn es keine Rezepte gibt.
export function rollRecipe({
  recipes,
  profile,
  excludeIds = new Set(),
  today = todayIso(),
  date = null, // für welchen Tag – entscheidet über Aufwand und Wetter
  weather = undefined, // 'kalt' | 'warm' | null; undefined = selbst ermitteln
  maxMinutes = 0, // 0 = keine Grenze
  settings = null, // dauerhafte Vorgaben; null = aus den Einstellungen lesen
  random = Math.random,
}) {
  const usable = recipes.filter(
    (r) => !r.blocked && !r.source_missing && r.course !== 'side'
  );
  if (!usable.length) return null;

  const cfg = settings || planSettings();
  // Wetter für genau diesen Tag: gemessen (heute/morgen) oder nach Monat.
  const bias =
    weather === undefined
      ? climateBias(date, { ...currentWeather(), coldC: cfg.coldC, warmC: cfg.warmC })
      : weather;

  for (const relax of RELAXATIONS) {
    const weights = weightsFor(usable, profile, {
      excludeIds,
      today,
      relax,
      date,
      bias,
      quickMinutes: cfg.quickMinutes,
      maxMinutes,
    });
    const picked = pickWeighted(usable, weights, random);
    if (picked) {
      const grund = [
        explainPick(picked, profile),
        maxMinutes ? `höchstens ${maxMinutes} Min.` : '',
        weather !== undefined && weather ? `Wetter: ${weather}` : '',
        relax.label,
      ]
        .filter(Boolean)
        .join(' · ');
      return { recipe: picked, reason: grund };
    }
  }
  return null;
}

// Würfelt für einzelne Tage und schreibt das Ergebnis in den Plan.
// `dates` müssen gültige ISO-Tage sein.
export function rollDays(
  dates,
  {
    overwrite = true,
    random = Math.random,
    maxMinutes = 0,
    weather = undefined,
    // Tage, für die schon eingekauft wurde, beim Wochenwurf in Ruhe lassen.
    // Beim ausdrücklichen Wurf für EINEN Tag hebt der Aufrufer das auf – wer
    // dort auf den Würfel drückt, meint genau diesen Tag.
    protectShopped = true,
  } = {}
) {
  const { recipes, profile } = loadContext();
  const results = [];
  const today = todayIso();
  // Einmal lesen, nicht je Tag – sieben Tage würfeln sonst siebenmal die DB an.
  const settings = planSettings();

  for (const date of dates) {
    const week = weekOf(date);
    const weekRange = weekDates(week);
    const existing = getPlanRange(weekRange[0], weekRange[6]);
    const current = existing.find((e) => e.date === date);

    if (!overwrite && current && current.recipe_id) {
      results.push({ date, skipped: true, entry: current });
      continue;
    }
    // Gekochte Tage und Reste-Tage nie überschreiben: das eine ist Historie,
    // das andere eine Ansage („da ist noch was da").
    if (current && (current.status === 'cooked' || current.status === 'leftovers')) {
      results.push({ date, skipped: true, entry: current });
      continue;
    }
    // Dafür liegen die Zutaten schon im Haus – sonst kauft man ein und das
    // Gericht verschwindet beim nächsten Wurf aus dem Plan.
    if (protectShopped && current?.shopped_at && current.recipe_id) {
      results.push({ date, skipped: true, shopped: true, entry: current });
      continue;
    }

    const excludeIds = new Set(
      existing
        .filter((e) => e.date !== date && e.recipe_id)
        .map((e) => e.recipe_id)
    );
    const rolled = rollRecipe({
      recipes,
      profile,
      excludeIds,
      today,
      date,
      random,
      maxMinutes,
      weather,
      settings,
    });
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
export function rollWeek(
  week,
  { onlyEmpty = false, random = Math.random, maxMinutes = 0, weather = undefined } = {}
) {
  const dates = weekDates(week);
  if (!dates) return null;
  return rollDays(dates, { overwrite: !onlyEmpty, random, maxMinutes, weather });
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
      // Zutaten schon nach Bring geschoben?
      shopped: Boolean(entry?.shopped_at),
      note: entry?.note || null,
      recipe: recipe
        ? {
            id: recipe.id,
            name: recipe.name,
            prep_time: recipe.prep_time,
            source_url: recipe.source_url,
            // Wohin der Absprung zeigt: bei Mealie-Rezepten dorthin, denn die
            // Quell-Seite (z. B. Chefkoch PLUS) ist oft gesperrt.
            link:
              (recipe.source === 'mealie' ? mealieRecipeUrl(recipe.source_slug) : '') ||
              recipe.source_url ||
              '',
            image_url: recipe.image_url, // für die Wandtablet-Ansicht
            servings: recipe.servings,
            tags: recipe.tags,
            avg_stars: recipe.avg_stars,
            rating_count: recipe.rating_count,
            times_cooked: recipe.times_cooked,
            last_cooked: recipe.last_cooked,
            blocked: recipe.blocked,
            prep_hint: recipe.prep_hint || '',
            ingredient_count: realIngredients(recipe.ingredients).length,
            incomplete: Boolean(recipe.incomplete),
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
export function weekShoppingItems(week, { skipCooked = true, servings = null } = {}) {
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
    // Mengen auf die Haushaltsgröße bringen – Rezepte stehen meist auf 4.
    const factor = scaleFactor(recipe.servings, servings ?? householdServings());
    for (const ing of scaleIngredients(realIngredients(recipe.ingredients), factor)) {
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
      // Dieselben Felder wie in der Rezeptliste – die Karte der Reste-Küche
      // zeigt Bild, Anbieter und Mealie-Link genau wie dort.
      recipe: {
        id: recipe.id,
        name: recipe.name,
        description: recipe.description,
        instructions: recipe.instructions,
        prep_time: recipe.prep_time,
        servings: recipe.servings,
        image_url: recipe.image_url,
        source: recipe.source,
        source_slug: recipe.source_slug,
        source_url: recipe.source_url,
        tags: recipe.tags,
        avg_stars: recipe.avg_stars,
        rating_count: recipe.rating_count,
        times_cooked: recipe.times_cooked,
        last_cooked: recipe.last_cooked,
        blocked: recipe.blocked,
        incomplete: recipe.incomplete,
        prep_hint: recipe.prep_hint,
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
