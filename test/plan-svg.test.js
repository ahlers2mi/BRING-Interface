// Der Wochenplan als Bild: reine Renderfunktion, ohne Netz und Datenbank.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPlanSvg, wrapText, escapeXml } from '../lib/plan-svg.js';

const view = {
  week: '2026-W32',
  from: '2026-08-03',
  to: '2026-08-09',
  days: [
    {
      date: '2026-08-03',
      label: 'Montag',
      isToday: false,
      status: 'cooked',
      recipe: { id: 1, name: 'Chili con Carne', prep_time: '1 Std.', avg_stars: 4.5, rating_count: 2 },
    },
    {
      date: '2026-08-04',
      label: 'Dienstag',
      isToday: true,
      status: 'planned',
      recipe: {
        id: 2,
        name: 'Gefüllte Auberginen auf türkische Art mit Hackfleisch & Feta',
        prep_time: '1 Std.',
        servings: '4 Portionen',
        avg_stars: null,
        rating_count: 0,
      },
    },
    { date: '2026-08-05', label: 'Mittwoch', isToday: false, status: 'empty', recipe: null },
    { date: '2026-08-06', label: 'Donnerstag', isToday: false, status: 'planned', recipe: { id: 4, name: 'Lachs', avg_stars: 5, rating_count: 1 } },
    { date: '2026-08-07', label: 'Freitag', isToday: false, status: 'planned', recipe: { id: 5, name: 'Pizza', rating_count: 0 } },
    { date: '2026-08-08', label: 'Samstag', isToday: false, status: 'planned', recipe: { id: 6, name: 'Suppe', rating_count: 0 } },
    { date: '2026-08-09', label: 'Sonntag', isToday: false, status: 'planned', recipe: { id: 7, name: 'Braten', rating_count: 0 } },
  ],
};

test('wrapText bricht um und kürzt mit Auslassung', () => {
  assert.deepEqual(wrapText('kurz', { fontSize: 20, maxWidth: 400 }), ['kurz']);
  const lines = wrapText('Gefüllte Auberginen auf türkische Art mit Hackfleisch und Feta', {
    fontSize: 34,
    maxWidth: 520,
    maxLines: 2,
  });
  assert.equal(lines.length, 2);
  assert.ok(lines.at(-1).endsWith('…'), `erwartet Auslassung, war: ${lines.at(-1)}`);
  assert.deepEqual(wrapText('', { fontSize: 15, maxWidth: 100 }), ['–']);
});

test('escapeXml entschärft Sonderzeichen', () => {
  assert.equal(escapeXml('Omas "beste" Suppe & Co <b>'), 'Omas &quot;beste&quot; Suppe &amp; Co &lt;b&gt;');
});

test('renderPlanSvg baut ein gültiges, in sich geschlossenes SVG', () => {
  const svg = renderPlanSvg(view);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.endsWith('</svg>'));
  // Tag von heute ist der Held der Ansicht
  assert.ok(svg.includes('>HEUTE<'));
  assert.ok(svg.includes('Auberginen'));
  // alle anderen sechs Tage kommen vor
  for (const label of ['Montag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']) {
    assert.ok(svg.includes(`>${label}<`), `${label} fehlt`);
  }
  assert.ok(svg.includes('✓ gekocht'), 'gekochter Tag markiert');
  assert.ok(svg.includes('nichts geplant'), 'leerer Tag benannt');
  // Ohne Bilder Platzhalter, keine leeren <image>-Elemente
  assert.equal(svg.includes('<image'), false);
  // Kein unmaskiertes & (sonst ist das SVG kaputt)
  assert.equal(/&(?!(amp|lt|gt|quot|apos|#)\w*;)/.test(svg), false, 'unmaskiertes &');
});

test('renderPlanSvg bettet übergebene Bilder ein', () => {
  const svg = renderPlanSvg(view, new Map([[2, 'data:image/webp;base64,AAAA']]));
  assert.ok(svg.includes('<image href="data:image/webp;base64,AAAA"'));
  assert.ok(svg.includes('clip-path="url(#heroClip)"'));
});
