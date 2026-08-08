// Tab "Wochenplan": würfeln (Tag oder ganze Woche), Rezepte per Hand setzen,
// bewerten und die Zutaten der Woche nach Bring schieben.

import {
  apiFetch,
  closeModal,
  deDate,
  el,
  escHtml,
  flash,
  mealieActive,
  on,
  openModal,
  ratingButtonsHtml,
  refreshRecipes,
  setLoading,
  starsText,
  state,
  wireRatingButtons,
} from './core.js';
import { loadTaste } from './recipes.js';

let currentWeek = 'current'; // wird nach dem ersten Laden zur echten KW
let pickerDate = null; // Tag, für den das Auswahl-Modal offen ist

const STATUS_LABEL = {
  planned: '',
  cooked: '✓ gekocht',
  skipped: '🗑 nicht gekocht',
  leftovers: '🍲 Reste',
  empty: '',
};

export async function loadPlan(week = currentWeek) {
  const grid = el('planGrid');
  if (!grid) return;
  grid.innerHTML = '<span class="spinner"></span>';
  try {
    const plan = await apiFetch(`/api/plan?week=${encodeURIComponent(week)}`);
    currentWeek = plan.week;
    renderPlan(plan);
  } catch (err) {
    grid.innerHTML = `<div class="alert alert-error">Wochenplan nicht ladbar: ${escHtml(
      err.message
    )}</div>`;
  }
}

function renderPlan(plan) {
  el('planWeekLabel').textContent =
    `KW ${plan.week.slice(-2)} (${deDate(plan.from)} – ${deDate(plan.to)})`;
  el('planWeekLabel').dataset.from = plan.from;
  el('planSummary').textContent = `${plan.planned} von 7 Tagen geplant`;
  // Der Abgleich läuft beim Würfeln und alle paar Minuten automatisch – der
  // Knopf holt ihn sofort, wenn jemand gerade in Mealie geplant hat.
  el('planMealieBtn').hidden = !mealieActive();

  const grid = el('planGrid');
  grid.innerHTML = '';
  for (const day of plan.days) {
    grid.appendChild(buildDayCard(day));
  }
}

function buildDayCard(day) {
  const node = document.createElement('div');
  node.className = [
    'plan-day',
    day.isToday ? 'is-today' : '',
    day.isPast ? 'is-past' : '',
    day.status === 'cooked' ? 'is-cooked' : '',
    day.status === 'skipped' ? 'is-skipped' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const recipe = day.recipe;
  const ratingText = day.rating
    ? day.rating.kind === 'rejected'
      ? '🗑 rausgeflogen'
      : `bewertet: ${starsText(day.rating.stars)}`
    : '';

  const meta = [];
  if (recipe?.prep_time) meta.push(`⏱ ${escHtml(recipe.prep_time)}`);
  if (recipe?.rating_count) {
    meta.push(`${starsText(recipe.avg_stars)} ${Number(recipe.avg_stars).toFixed(1)}`);
  } else if (recipe) {
    meta.push('noch nicht bewertet');
  }
  if (recipe?.last_cooked) meta.push(`zuletzt ${escHtml(deDate(recipe.last_cooked))}`);

  node.innerHTML = `
    <div class="plan-day-head">
      <b>${escHtml(day.label)}</b>
      <span class="hint">${escHtml(day.dateLabel)}</span>
      ${day.isToday ? '<span class="badge badge-today">heute</span>' : ''}
      ${
        STATUS_LABEL[day.status]
          ? `<span class="badge">${STATUS_LABEL[day.status]}</span>`
          : ''
      }
    </div>
    <div class="plan-day-body">
      ${
        recipe
          ? `<div class="plan-recipe">
               ${
                 recipe.link
                   ? `<a href="${escHtml(
                       recipe.link
                     )}" target="_blank" rel="noopener noreferrer">${escHtml(recipe.name)}</a>`
                   : escHtml(recipe.name)
               }
             </div>
             <div class="meta">${meta.join(' &nbsp;·&nbsp; ')}</div>
             ${day.note ? `<div class="hint">🎲 ${escHtml(day.note)}</div>` : ''}
             ${ratingText ? `<div class="hint">${ratingText}</div>` : ''}`
          : '<div class="plan-empty">– nichts geplant –</div>'
      }
    </div>
    <div class="plan-day-actions">
      <button class="btn btn-primary btn-sm" data-act="roll" title="Für diesen Tag würfeln">🎲</button>
      <button class="btn btn-secondary btn-sm" data-act="pick" title="Rezept auswählen">📋</button>
      ${
        recipe
          ? `<button class="btn btn-secondary btn-sm" data-act="cart" title="Zutaten in Bring">🛒</button>
             <button class="btn btn-secondary btn-sm" data-act="move" title="Auf morgen verschieben">→</button>
             <button class="btn btn-danger btn-sm" data-act="clear" title="Tag leeren">✕</button>`
          : ''
      }
      <button class="btn btn-secondary btn-sm" data-act="leftovers"
        title="Reste vom Vortag – der Würfel lässt den Tag in Ruhe">🍲</button>
    </div>
    ${
      recipe
        ? `<div class="plan-day-rate">${ratingButtonsHtml({ compact: true })}</div>`
        : ''
    }
  `;

  node.querySelector('[data-act="roll"]').addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      const res = await apiFetch('/api/plan/roll', {
        method: 'POST',
        body: JSON.stringify({ date: day.date }),
      });
      renderPlan(res.plan);
      const first = res.results?.[0];
      if (first?.error) flash('planResult', first.error, 'error');
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
      setLoading(e.currentTarget, false);
    }
  });

  node
    .querySelector('[data-act="pick"]')
    .addEventListener('click', () => openPicker(day.date));

  node.querySelector('[data-act="clear"]')?.addEventListener('click', async () => {
    try {
      const res = await apiFetch(`/api/plan/${day.date}`, { method: 'DELETE' });
      renderPlan(res.plan);
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
    }
  });

  // Heute wird es doch nichts: einen Tag weiterschieben, statt neu zu würfeln.
  node.querySelector('[data-act="move"]')?.addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      const morgen = new Date(`${day.date}T12:00:00Z`);
      morgen.setUTCDate(morgen.getUTCDate() + 1);
      const res = await apiFetch(`/api/plan/${day.date}/move`, {
        method: 'POST',
        body: JSON.stringify({ to: morgen.toISOString().slice(0, 10) }),
      });
      renderPlan(res.plan);
      flash('planResult', `✓ auf ${escHtml(deDate(res.to))} verschoben.`);
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
      setLoading(e.currentTarget, false);
    }
  });

  node.querySelector('[data-act="leftovers"]').addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      const res = await apiFetch(`/api/plan/${day.date}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: day.status === 'leftovers' ? 'planned' : 'leftovers' }),
      });
      renderPlan(res.plan);
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
      setLoading(e.currentTarget, false);
    }
  });

  node.querySelector('[data-act="cart"]')?.addEventListener('click', async (e) => {
    const listUuid = el('planListSelect').value;
    if (!listUuid) return flash('planResult', 'Bitte oben eine Bring-Liste wählen.', 'error');
    setLoading(e.currentTarget, true);
    try {
      const res = await apiFetch(`/api/recipes/${recipe.id}/import`, {
        method: 'POST',
        body: JSON.stringify({ listUuid }),
      });
      flash('planResult', `✓ ${res.imported.length} Zutaten in Bring übertragen.`);
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(e.currentTarget, false);
    }
  });

  wireRatingButtons(node, async (rating, btn) => {
    setLoading(btn, true);
    try {
      const res = await apiFetch(`/api/plan/${day.date}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      });
      renderPlan(res.plan);
      await refreshRecipes();
      await loadTaste();
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
      setLoading(btn, false);
    }
  });

  return node;
}

// ── Rezeptauswahl für einen Tag ───────────────────────────────────────────────

function openPicker(date) {
  pickerDate = date;
  el('pickerDate').textContent = deDate(date);
  el('pickerSearch').value = '';
  renderPicker();
  openModal('pickerModal');
}

function renderPicker() {
  const query = el('pickerSearch').value.trim().toLowerCase();
  const list = el('pickerList');
  const matches = state.recipes
    .filter((r) => !r.blocked)
    .filter((r) => !query || r.name.toLowerCase().includes(query))
    .slice(0, 60);

  list.innerHTML = matches.length
    ? matches
        .map(
          (r) =>
            `<button class="picker-item" data-id="${r.id}">
               <span>${escHtml(r.name)}</span>
               <span class="hint">${
                 r.rating_count ? starsText(r.avg_stars) : 'neu'
               }</span>
             </button>`
        )
        .join('')
    : '<em class="hint">Kein Rezept gefunden.</em>';

  list.querySelectorAll('.picker-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/api/plan/${pickerDate}`, {
          method: 'PUT',
          body: JSON.stringify({ recipe_id: Number(btn.dataset.id), note: 'von Hand gewählt' }),
        });
        renderPlan(res.plan);
        closeModal('pickerModal');
      } catch (err) {
        flash('pickerResult', `Fehler: ${escHtml(err.message)}`, 'error');
      }
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initPlan() {
  on('planPrevBtn', 'click', () => loadPlan(shift(-1)));
  on('planNextBtn', 'click', () => loadPlan(shift(1)));
  on('planTodayBtn', 'click', () => loadPlan('current'));

  on('rollWeekBtn', 'click', async (e) => {
    if (!confirm('Ganze Woche neu würfeln? Bereits gekochte Tage bleiben stehen.')) return;
    await roll(e.currentTarget, { week: currentWeek });
  });

  on('rollEmptyBtn', 'click', async (e) => {
    await roll(e.currentTarget, { week: currentWeek, onlyEmpty: true });
  });

  on('planShoppingBtn', 'click', async (e) => {
    const listUuid = el('planListSelect').value;
    if (!listUuid) return flash('planResult', 'Bitte eine Bring-Liste wählen.', 'error');
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await apiFetch('/api/plan/shopping', {
        method: 'POST',
        body: JSON.stringify({ week: currentWeek, listUuid }),
      });
      flash(
        'planResult',
        `✓ ${res.imported.length} Zutaten aus ${res.recipes.length} Rezepten in Bring übertragen.`
      );
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('planShoppingPreviewBtn', 'click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await apiFetch(
        `/api/plan/shopping?week=${encodeURIComponent(currentWeek)}`
      );
      el('planResult').innerHTML = res.items.length
        ? `<div class="alert alert-info">
             <b>${res.items.length} Zutaten</b> aus ${res.recipes.length} Rezepten:<br />
             ${res.items
               .map(
                 (i) =>
                   `<span class="ingredient-tag">${escHtml(
                     i.amount ? `${i.amount} ${i.name}` : i.name
                   )}</span>`
               )
               .join('')}
           </div>`
        : '<div class="alert alert-info">Für diese Woche ist nichts eingeplant.</div>';
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  // Haushaltsgröße: beim Verlassen des Feldes speichern.
  on('householdServings', 'change', async (e) => {
    try {
      const res = await apiFetch('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify({ householdServings: Number(e.currentTarget.value) }),
      });
      state.preferences = { ...(state.preferences || {}), ...res };
      flash(
        'servingsResult',
        res.householdServings
          ? `✓ Mengen werden auf ${res.householdServings} Portionen umgerechnet.`
          : '✓ Mengen bleiben unverändert.'
      );
    } catch (err) {
      flash('servingsResult', `Fehler: ${escHtml(err.message)}`, 'error');
    }
  });

  on('planMealieBtn', 'click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await apiFetch('/api/plan/mealie', {
        method: 'POST',
        body: JSON.stringify({ week: currentWeek }),
      });
      if (res.plan) renderPlan(res.plan);
      const parts = [];
      if (res.pulled) parts.push(`${res.pulled} aus Mealie übernommen`);
      if (res.cleared) parts.push(`${res.cleared} entfernt (in Mealie gelöscht)`);
      parts.push(`${res.pushed} Tage nach Mealie geschrieben`);
      if (res.failed) parts.push(`${res.failed} fehlgeschlagen (siehe Container-Log)`);
      flash('planResult', `✓ ${parts.join(', ')}.`, res.failed ? 'error' : 'success');
    } catch (err) {
      flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('pickerSearch', 'input', renderPicker);
  on('pickerCloseBtn', 'click', () => closeModal('pickerModal'));
}

async function roll(btn, body) {
  setLoading(btn, true);
  try {
    const res = await apiFetch('/api/plan/roll', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    renderPlan(res.plan);
    const errors = (res.results || []).filter((r) => r.error);
    if (errors.length) flash('planResult', escHtml(errors[0].error), 'error');
    else flash('planResult', '🎲 Fertig gewürfelt.');
  } catch (err) {
    flash('planResult', `Fehler: ${escHtml(err.message)}`, 'error');
  } finally {
    setLoading(btn, false);
  }
}

// Woche relativ verschieben – die Rechnerei macht der Server, hier genügt das
// Datum des Montags plus/minus sieben Tage.
function shift(delta) {
  const from = el('planWeekLabel').dataset.from;
  if (!from) return 'current';
  const date = new Date(`${from}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta * 7);
  return date.toISOString().slice(0, 10); // Datum -> Server ermittelt die KW
}
