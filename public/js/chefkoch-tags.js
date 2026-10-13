// Kategorien für den Chefkoch-Import. Die IDs stammen aus der Chefkoch-Suche
// (search-gateway, Feld `tagGroups`); mehrere gewählte Kategorien müssen ALLE
// passen (Hauptspeise + Vegetarisch = vegetarische Hauptgerichte).
// Bewusst eine kleine Auswahl – die vollständige Liste hat über 200 Einträge.

import { escHtml } from './core.js';

export const CHEFKOCH_TAG_GROUPS = [
  ['Ernährung', [[32, 'Vegetarisch'], [57, 'Vegan'], [55, 'Kalorienarm'], [9948, 'Low Carb'], [56, 'Fettarm']]],
  ['Mahlzeit', [[21, 'Hauptspeise'], [19, 'Vorspeise'], [36, 'Beilage'], [90, 'Dessert'], [71, 'Snack'], [53, 'Frühstück']]],
  ['Eigenschaft', [[50, 'Einfach'], [49, 'Schnell'], [48, 'Preiswert']]],
  ['Art', [[30, 'Auflauf'], [81, 'Eintopf'], [40, 'Suppe'], [15, 'Salat'], [82, 'Pizza']]],
  ['Anlass', [[91, 'Für Kinder'], [63, 'Grillen'], [45, 'Party'], [27, 'Sommer'], [64, 'Winter']]],
  ['Küche', [[65, 'Deutsch'], [28, 'Italienisch'], [44, 'Griechisch'], [14, 'Asiatisch'], [13, 'Indisch'], [74, 'Mexikanisch'], [163, 'Naher Osten']]],
];

const NAMES = new Map(CHEFKOCH_TAG_GROUPS.flatMap(([, tags]) => tags));

// Zeichnet die Auswahl als An/Aus-Chips in den Container.
export function renderTagPicker(container) {
  if (!container) return;
  container.innerHTML = CHEFKOCH_TAG_GROUPS.map(
    ([group, tags]) => `<div class="tag-pick-row"><span class="hint">${escHtml(group)}:</span>
      ${tags
        .map(
          ([id, name]) =>
            `<button type="button" class="chip chip-toggle" data-tag="${id}" aria-pressed="false">${escHtml(name)}</button>`
        )
        .join('')}</div>`
  ).join('');
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-toggle');
    if (!chip) return;
    chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  });
}

export function selectedTags(container) {
  if (!container) return [];
  return [...container.querySelectorAll('.chip-toggle[aria-pressed="true"]')].map((c) =>
    Number(c.dataset.tag)
  );
}

export function tagNames(ids) {
  return ids.map((id) => NAMES.get(id) || `#${id}`).join(' + ');
}
