// Datums-/Wochenhilfen für den Wochenplan.
//
// Alle Datumsangaben sind Kalendertage im Format YYYY-MM-DD. Gerechnet wird
// intern in UTC-Mitternacht, damit Sommer-/Winterzeit keine Tagessprünge
// verursacht. "Heute" kommt aus der lokalen Zeit des Servers.

export const WEEKDAYS = [
  { key: 'mon', short: 'Mo', long: 'Montag' },
  { key: 'tue', short: 'Di', long: 'Dienstag' },
  { key: 'wed', short: 'Mi', long: 'Mittwoch' },
  { key: 'thu', short: 'Do', long: 'Donnerstag' },
  { key: 'fri', short: 'Fr', long: 'Freitag' },
  { key: 'sat', short: 'Sa', long: 'Samstag' },
  { key: 'sun', short: 'So', long: 'Sonntag' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

// Lokales "heute" als YYYY-MM-DD.
export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isValidIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? isoToUtc(value) !== null
    : false;
}

// YYYY-MM-DD -> Date (UTC-Mitternacht) oder null.
export function isoToUtc(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Rundreise-Prüfung fängt Werte wie 2026-02-31 ab.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

export function utcToIso(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate()
  )}`;
}

export function addDays(iso, days) {
  const date = isoToUtc(iso);
  if (!date) return null;
  return utcToIso(new Date(date.getTime() + days * DAY_MS));
}

// Differenz in Tagen (b - a); null bei ungültigen Daten.
export function daysBetween(a, b) {
  const da = isoToUtc(a);
  const db = isoToUtc(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / DAY_MS);
}

// Montag der Woche, in der `iso` liegt.
export function mondayOf(iso) {
  const date = isoToUtc(iso);
  if (!date) return null;
  const dow = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // Mo=1 … So=7
  return utcToIso(new Date(date.getTime() - (dow - 1) * DAY_MS));
}

// ISO-8601-Kalenderwoche als "YYYY-Wnn".
export function weekOf(iso) {
  const monday = mondayOf(iso);
  if (!monday) return null;
  const thursday = isoToUtc(addDays(monday, 3)); // Donnerstag bestimmt das ISO-Jahr
  const year = thursday.getUTCFullYear();
  const firstThursday = (() => {
    // Erster Donnerstag des ISO-Jahres.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
    return new Date(jan4.getTime() + (4 - dow) * DAY_MS);
  })();
  const week =
    1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${year}-W${pad(week)}`;
}

// "YYYY-Wnn" -> Montag der Woche (YYYY-MM-DD) oder null.
export function weekToMonday(week) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(String(week));
  if (!m) return null;
  const year = Number(m[1]);
  const wk = Number(m[2]);
  if (wk < 1 || wk > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4.getTime() - (dow - 1) * DAY_MS);
  const monday = new Date(week1Monday.getTime() + (wk - 1) * 7 * DAY_MS);
  // Woche 53 gibt es nicht in jedem Jahr – dann liegt der Montag schon im
  // Folgejahr und wir lehnen den Wert ab.
  if (weekOf(utcToIso(monday)) !== `${year}-W${pad(wk)}`) return null;
  return utcToIso(monday);
}

// Die sieben Kalendertage einer Woche, Montag zuerst.
export function weekDates(week) {
  const monday = weekToMonday(week);
  if (!monday) return null;
  return WEEKDAYS.map((_, i) => addDays(monday, i));
}

// Woche relativ verschieben ("2026-W32", +1 -> "2026-W33").
export function shiftWeek(week, delta) {
  const monday = weekToMonday(week);
  if (monday === null) return null;
  return weekOf(addDays(monday, delta * 7));
}

// "2026-08-06" -> "Do, 06.08."
export function formatDayLabel(iso) {
  const date = isoToUtc(iso);
  if (!date) return String(iso);
  const dow = date.getUTCDay() === 0 ? 6 : date.getUTCDay() - 1;
  return `${WEEKDAYS[dow].short}, ${pad(date.getUTCDate())}.${pad(
    date.getUTCMonth() + 1
  )}.`;
}

// Wochentagsschlüssel (mon…sun) eines Datums.
export function weekdayKey(iso) {
  const date = isoToUtc(iso);
  if (!date) return null;
  const dow = date.getUTCDay() === 0 ? 6 : date.getUTCDay() - 1;
  return WEEKDAYS[dow].key;
}
