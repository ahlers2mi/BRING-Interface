// Wetter und Jahreszeit im Würfel.
//
// Bei 5 °C will niemand Nudelsalat, bei 30 °C keinen Schmorbraten. Woher die
// Einschätzung kommt, hängt vom Abstand ab:
//
// * **gemessene Temperatur** (FHEM schickt sie an /api/fhem/weather) – gilt für
//   heute und morgen. Weiter voraus sagt der aktuelle Messwert nichts.
// * **Monat** – für alles Weitere. Wer sonntags die ganze Woche würfelt, soll im
//   Januar trotzdem eher Eintopf bekommen.
//
// Beides ist eine Neigung, kein Filter: ein Auflauf im Juli bleibt möglich, er
// kommt nur seltener.

import { deumlaut } from './normalize.js';

const COLD_C = Number(process.env.PLAN_COLD_C || 10);
const WARM_C = Number(process.env.PLAN_WARM_C || 24);
// Wie lange ein Messwert als aktuell gilt.
const FRESH_HOURS = Number(process.env.PLAN_WEATHER_HOURS || 6);

// Gerichte, die bei Kälte guttun, und solche für heiße Tage. Gesucht wird in
// Tags und Namen – beides kommt aus den Quellen und ist nicht gepflegt, deshalb
// großzügige Stichwörter statt einer festen Kategorie.
const WINTER = [
  'suppe', 'eintopf', 'auflauf', 'gratin', 'ofen', 'braten', 'schmor', 'gulasch',
  'curry', 'chili', 'raclette', 'fondue', 'grunkohl', 'rouladen', 'knodel',
  'kartoffelbrei', 'linsen', 'bohnensuppe', 'suppentopf', 'deftig',
];
const SOMMER = [
  'salat', 'grill', 'bowl', 'kalt', 'gazpacho', 'sommer', 'melone', 'spargel',
  'antipasti', 'wrap', 'sandwich', 'smoothie', 'erfrischend', 'leicht',
];

function matches(haystack, words) {
  return words.some((word) => haystack.includes(word));
}

// Wonach schmeckt das Rezept – nach Winter, nach Sommer, oder ist es egal?
export function dishTemperament(recipe) {
  const text = deumlaut(
    [recipe?.name || '', ...(recipe?.tags || [])].join(' ').toLowerCase()
  );
  const winter = matches(text, WINTER);
  const sommer = matches(text, SOMMER);
  if (winter && !sommer) return 'winter';
  if (sommer && !winter) return 'sommer';
  return null; // beides oder nichts – dann nicht anfassen
}

// Kalt oder warm? `null`, wenn wir es nicht wissen (dann wird nicht gewichtet).
export function climateBias(date, { temp = null, measuredAt = null, now = null } = {}) {
  const target = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return null;

  const heute = String(now || new Date().toISOString()).slice(0, 10);
  const abstand = Math.round(
    (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${heute}T00:00:00Z`)) / 86400000
  );

  // Messwert nur für heute und morgen, und nur wenn er frisch ist.
  const value = Number(temp);
  if (Number.isFinite(value) && measuredAt && abstand >= 0 && abstand <= 1) {
    const alter = (Date.parse(now || new Date().toISOString()) - Date.parse(measuredAt)) / 3600000;
    if (Number.isFinite(alter) && alter >= 0 && alter <= FRESH_HOURS) {
      if (value <= COLD_C) return 'kalt';
      if (value >= WARM_C) return 'warm';
      return null;
    }
  }

  // Sonst der Monat des geplanten Tages.
  const monat = Number(target.slice(5, 7));
  if ([12, 1, 2].includes(monat)) return 'kalt';
  if ([6, 7, 8].includes(monat)) return 'warm';
  return null;
}

// Gewicht: passendes Gericht häufiger, unpassendes seltener.
export function weatherFactor(recipe, bias) {
  if (!bias) return 1;
  const art = dishTemperament(recipe);
  if (!art) return 1;
  if (bias === 'kalt') return art === 'winter' ? 1.4 : 0.7;
  return art === 'sommer' ? 1.4 : 0.7;
}
