import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  daysBetween,
  formatDayLabel,
  mondayOf,
  shiftWeek,
  weekDates,
  weekOf,
  weekToMonday,
  weekdayKey,
  isValidIsoDate,
} from '../lib/week.js';

test('weekOf liefert ISO-Kalenderwochen', () => {
  assert.equal(weekOf('2026-08-06'), '2026-W32'); // Donnerstag
  assert.equal(weekOf('2026-01-01'), '2026-W01'); // Do -> KW1
  assert.equal(weekOf('2027-01-01'), '2026-W53'); // Fr -> noch KW53/2026
  assert.equal(weekOf('2025-12-29'), '2026-W01'); // Mo -> schon KW1/2026
});

test('weekToMonday ist die Umkehrung von weekOf', () => {
  for (const iso of ['2026-08-06', '2026-01-01', '2025-12-29', '2026-12-31']) {
    const week = weekOf(iso);
    assert.equal(weekOf(weekToMonday(week)), week);
    assert.equal(weekToMonday(week), mondayOf(iso));
  }
});

test('weekToMonday lehnt nicht existierende Wochen ab', () => {
  assert.equal(weekToMonday('2026-W53'), '2026-12-28');
  assert.equal(weekToMonday('2025-W53'), null); // 2025 hat nur 52 Wochen
  assert.equal(weekToMonday('quatsch'), null);
});

test('weekDates liefert Montag bis Sonntag', () => {
  const dates = weekDates('2026-W32');
  assert.deepEqual(dates, [
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
    '2026-08-06',
    '2026-08-07',
    '2026-08-08',
    '2026-08-09',
  ]);
  assert.equal(weekdayKey(dates[0]), 'mon');
  assert.equal(weekdayKey(dates[6]), 'sun');
});

test('shiftWeek springt über Jahresgrenzen', () => {
  assert.equal(shiftWeek('2026-W32', 1), '2026-W33');
  assert.equal(shiftWeek('2026-W01', -1), '2025-W52');
  assert.equal(shiftWeek('2026-W53', 1), '2027-W01');
});

test('addDays und daysBetween rechnen über Monats-/DST-Grenzen', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30'); // Zeitumstellung
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-08-01', '2026-08-06'), 5);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
});

test('isValidIsoDate prüft echte Kalendertage', () => {
  assert.equal(isValidIsoDate('2026-08-06'), true);
  assert.equal(isValidIsoDate('2026-02-31'), false);
  assert.equal(isValidIsoDate('06.08.2026'), false);
  assert.equal(isValidIsoDate(undefined), false);
});

test('formatDayLabel ist kurz und deutsch', () => {
  assert.equal(formatDayLabel('2026-08-06'), 'Do, 06.08.');
});
