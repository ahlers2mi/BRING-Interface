// Tab "Reste-Küche": Reste aus dem Kühlschrank eingeben, passende Rezepte
// finden, Fehlendes nach Bring schieben oder das Rezept gleich einplanen.
// Absichtlich ohne Gedächtnis – der Kühlschrankinhalt wird nicht gespeichert.

import {
  apiFetch,
  el,
  escHtml,
  flash,
  on,
  ratingBadge,
  setLoading,
} from './core.js';
import { loadPlan } from './plan.js';

function coverageBar(coverage) {
  const percent = Math.round(coverage * 100);
  const cls = percent >= 80 ? 'good' : percent >= 50 ? 'mid' : 'low';
  return `<div class="coverage" title="${percent} % der Zutaten sind da">
            <div class="coverage-bar ${cls}" style="width:${percent}%"></div>
            <span>${percent} %</span>
          </div>`;
}

function buildResultCard(item) {
  const node = document.createElement('div');
  node.className = 'recipe-item';
  const r = item.recipe;

  node.innerHTML = `
    <div class="recipe-info">
      <h3>${escHtml(r.name)} ${ratingBadge(r)}</h3>
      ${coverageBar(item.coverage)}
      <div class="ingredient-tags">
        ${item.matched
          .map(
            (m) =>
              `<span class="ingredient-tag tag-have" title="passt zu „${escHtml(
                m.matchedWith
              )}"">✓ ${escHtml(m.name)}</span>`
          )
          .join('')}
        ${item.missing
          .map(
            (m) =>
              `<span class="ingredient-tag tag-missing">+ ${escHtml(
                m.amount ? `${m.amount} ${m.name}` : m.name
              )}</span>`
          )
          .join('')}
      </div>
      ${
        item.missing.length === 0
          ? '<div class="hint">🎉 Alles da – kann direkt losgehen.</div>'
          : `<div class="hint">${item.missing.length} Zutat(en) fehlen noch.</div>`
      }
      ${
        r.prep_time
          ? `<div class="meta">⏱ ${escHtml(r.prep_time)}</div>`
          : ''
      }
    </div>
    <div class="recipe-actions">
      ${
        item.missing.length
          ? '<button class="btn btn-primary btn-sm" data-act="missing">🛒 Fehlendes</button>'
          : ''
      }
      <button class="btn btn-secondary btn-sm" data-act="today">📅 Heute kochen</button>
      ${
        r.source_url
          ? `<a class="btn btn-secondary btn-sm" href="${escHtml(
              r.source_url
            )}" target="_blank" rel="noopener noreferrer">🔗 Quelle</a>`
          : ''
      }
    </div>
  `;

  node.querySelector('[data-act="missing"]')?.addEventListener('click', async (e) => {
    const listUuid = el('fridgeListSelect')?.value || el('listSelect')?.value;
    if (!listUuid) {
      return flash('fridgeResult', 'Bitte oben eine Bring-Liste wählen.', 'error');
    }
    setLoading(e.currentTarget, true);
    try {
      const res = await apiFetch(`/api/lists/${listUuid}/items`, {
        method: 'POST',
        body: JSON.stringify({ items: item.missing }),
      });
      flash('fridgeResult', `✓ ${res.imported.length} fehlende Zutaten in Bring.`);
    } catch (err) {
      flash('fridgeResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(e.currentTarget, false);
    }
  });

  node.querySelector('[data-act="today"]').addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      await apiFetch('/api/plan/today', {
        method: 'PUT',
        body: JSON.stringify({ recipe_id: r.id, note: 'Reste-Küche' }),
      });
      flash('fridgeResult', `✓ "${escHtml(r.name)}" für heute eingeplant.`);
      await loadPlan();
    } catch (err) {
      flash('fridgeResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(e.currentTarget, false);
    }
  });

  return node;
}

export function initFridge() {
  on('fridgeSearchBtn', 'click', async (e) => {
    const btn = e.currentTarget;
    const listEl = el('fridgeResults');
    const items = el('fridgeItems')
      .value.split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!items.length) {
      return flash('fridgeResult', 'Bitte mindestens eine Zutat eingeben.', 'error');
    }

    setLoading(btn, true);
    listEl.innerHTML = '<span class="spinner"></span>';
    try {
      const res = await apiFetch('/api/fridge/search', {
        method: 'POST',
        body: JSON.stringify({
          items,
          assumePantry: el('fridgePantry').checked,
        }),
      });
      listEl.innerHTML = '';
      if (!res.results.length) {
        listEl.innerHTML =
          '<div class="alert alert-info">Kein Rezept enthält diese Zutaten. ' +
          'Mehr Rezepte importieren oder andere Begriffe versuchen.</div>';
      }
      for (const item of res.results) listEl.appendChild(buildResultCard(item));
    } catch (err) {
      listEl.innerHTML = `<div class="alert alert-error">Fehler: ${escHtml(
        err.message
      )}</div>`;
    } finally {
      setLoading(btn, false);
    }
  });

  on('fridgeClearBtn', 'click', () => {
    el('fridgeItems').value = '';
    el('fridgeResults').innerHTML = '';
    el('fridgeResult').innerHTML = '';
  });
}
