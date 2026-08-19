// Zwei Umrechnungen, die im Alltag zählen:
//
// 1. **Wie lange dauert das?** – Die Zeitangabe kommt als Text herein
//    ("1 Stunde", "45 Min.", "15 Min. aktiv · 45 Min."). Für den Würfel muss
//    daraus eine Zahl werden, damit dienstags um halb sieben kein
//    90-Minuten-Schmorbraten vorgeschlagen wird.
// 2. **Für wie viele?** – Rezepte stehen meist auf 4 Portionen. Wer zu zweit
//    plus Kind isst, will die Mengen entsprechend kleiner auf dem Einkaufszettel.

import { formatAmountNumber, splitAmount } from './normalize.js';

// ── Zeit ──────────────────────────────────────────────────────────────────────

const HOURS = /(\d+(?:[.,]\d+)?)\s*(?:std|stunden?|h\b)/gi;
const MINUTES = /(\d+(?:[.,]\d+)?)\s*(?:min|minuten?|m\b)/gi;
const ISO = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i;

const num = (value) => Number(String(value).replace(',', '.'));

// Minuten aus einer Textangabe. Mehrere Angaben ("20 Min. + 1 Std.") werden
// addiert – das ist die Gesamtzeit, und genau die interessiert abends.
// Rückgabe `null`, wenn nichts Verwertbares dasteht: dann darf ein Rezept nicht
// aussortiert werden, nur weil die Quelle die Zeit nicht mitliefert.
export function parseMinutes(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const iso = ISO.exec(raw);
  if (iso) {
    const total = Number(iso[1] || 0) * 60 + Number(iso[2] || 0);
    return total > 0 ? total : null;
  }

  let total = 0;
  for (const m of raw.matchAll(HOURS)) total += num(m[1]) * 60;
  for (const m of raw.matchAll(MINUTES)) total += num(m[1]);

  // Reine Zahl ("30") als Minuten lesen – so schreiben es manche Quellen.
  if (!total && /^\d+$/.test(raw)) total = Number(raw);
  return total > 0 ? Math.round(total) : null;
}

// ── Portionen ─────────────────────────────────────────────────────────────────

// "4 Portionen", "für 2 Personen", "4" -> 4
export function parseServings(text) {
  const match = /(\d+(?:[.,]\d+)?)/.exec(String(text || ''));
  if (!match) return null;
  const value = num(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Wie stark müssen die Mengen umgerechnet werden? `null` = gar nicht (Rezept
// ohne Portionsangabe – dann lieber nichts anfassen als falsch rechnen).
export function scaleFactor(recipeServings, householdServings) {
  const from = parseServings(recipeServings);
  const to = Number(householdServings);
  if (!from || !Number.isFinite(to) || to <= 0) return null;
  const factor = to / from;
  // Winzige Abweichungen lohnen den Umbau der Mengen nicht.
  return Math.abs(factor - 1) < 0.05 ? null : factor;
}

// Auf sinnvolle Schritte runden: bei Gramm/Millilitern in Fünfern, bei Stück
// und Löffeln in halben Einheiten. "133,3 g Mehl" liest niemand gern.
function roundAmount(value, unit) {
  const u = String(unit || '').toLowerCase();
  if (/^(g|gramm|ml|milliliter)$/.test(u)) {
    if (value >= 100) return Math.round(value / 10) * 10;
    if (value >= 20) return Math.round(value / 5) * 5;
    return Math.round(value);
  }
  if (/^(kg|kilo|kilogramm|l|liter)$/.test(u)) return Math.round(value * 20) / 20;
  // Stück, EL, TL, Bund, Zehen …
  return Math.round(value * 2) / 2;
}

// "600 g" × 0.625 -> "375 g". Ohne erkennbare Zahl bleibt der Text stehen –
// "etwas Salz" lässt sich nicht halbieren.
export function scaleAmountText(amount, factor) {
  const text = String(amount || '').trim();
  if (!text || !factor) return text;

  // Von Hand eingetippte Doppelangabe ("1 Dose oder 400 g"): beide umrechnen,
  // sonst fällt die zweite still weg.
  if (/\s+oder\s+/i.test(text)) {
    return text
      .split(/\s+oder\s+/i)
      .map((teil) => scaleAmountText(teil, factor))
      .join(' oder ');
  }

  // Reine Mengenangaben ("600 g") gibt splitAmount als Namen zurück – dann
  // rechnen wir direkt auf dem Text.
  const { amount: numberPart } = splitAmount(text);
  const source = numberPart || text;
  const match = /^(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+))?\s*(.*)$/.exec(source);
  if (!match) return text;

  let value = num(match[1]);
  if (match[2]) value = value / Number(match[2]); // "1/2"
  if (!Number.isFinite(value) || value <= 0) return text;

  const unit = (match[3] || '').trim();
  const scaled = roundAmount(value * factor, unit);
  if (!scaled) return text; // unter der Rundungsschwelle: lieber Original

  return [formatAmountNumber(scaled), unit].filter(Boolean).join(' ').trim();
}

// Ganze Zutatenliste umrechnen.
export function scaleIngredients(ingredients, factor) {
  if (!factor) return ingredients || [];
  return (ingredients || []).map((ing) => ({
    ...ing,
    amount: scaleAmountText(ing.amount, factor),
  }));
}
