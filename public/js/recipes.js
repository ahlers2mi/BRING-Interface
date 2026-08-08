// Tab "Rezepte": erfassen, per KI analysieren, importieren (URL + Chefkoch),
// bewerten, in Bring schieben – plus die Karte "Das mögen wir".

import {
  apiFetch,
  closeModal,
  deDate,
  el,
  mealieActive,
  mealieRecipeLink,
  escHtml,
  flash,
  on,
  openModal,
  populateListSelects,
  PROVIDER_LABEL,
  providerOf,
  ratingBadge,
  ratingButtonsHtml,
  recipeThumb,
  refreshRecipes,
  setLoading,
  starsText,
  state,
  tagChips,
  wireRatingButtons,
} from './core.js';

let importTargetRecipeId = null;
let visibleCount = 30; // Rezeptliste wird stückweise gezeichnet
let importPollTimer = null;

// ── Formular ──────────────────────────────────────────────────────────────────

function createIngredientRow(name = '', amount = '') {
  const row = document.createElement('div');
  row.className = 'ingredient-row';
  row.innerHTML = `
    <input type="text" class="ing-name" placeholder="Zutat" value="${escHtml(name)}" />
    <input type="text" class="amount" placeholder="Menge" value="${escHtml(amount)}" />
    <button class="btn btn-danger btn-sm" title="Entfernen">✕</button>
  `;
  row.querySelector('.btn-danger').addEventListener('click', () => row.remove());
  return row;
}

export function resetRecipeForm() {
  for (const id of [
    'recipeId',
    'recipeName',
    'recipeUrl',
    'recipePrepTime',
    'recipeServings',
    'recipeTags',
    'recipeDesc',
    'recipeInstructions',
  ]) {
    if (el(id)) el(id).value = '';
  }
  el('ingredientRows').innerHTML = '';
  el('recipeFormTitle').textContent = 'Neues Rezept';
  el('cancelEditBtn').style.display = 'none';
  el('recipeFormResult').innerHTML = '';
  el('ingredientRows').appendChild(createIngredientRow());
}

function fillForm(recipe) {
  el('recipeId').value = recipe.id || '';
  el('recipeName').value = recipe.name || '';
  el('recipeUrl').value = recipe.source_url || '';
  el('recipePrepTime').value = recipe.prep_time || '';
  el('recipeServings').value = recipe.servings || '';
  el('recipeTags').value = Array.isArray(recipe.tags)
    ? recipe.tags.join(', ')
    : recipe.tags || '';
  el('recipeDesc').value = recipe.description || '';
  el('recipeInstructions').value = recipe.instructions || '';

  const rows = el('ingredientRows');
  rows.innerHTML = '';
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  for (const ing of ingredients) {
    rows.appendChild(createIngredientRow(ing.name || '', ing.amount || ''));
  }
  if (!ingredients.length) rows.appendChild(createIngredientRow());
  el('recipeFormCard').scrollIntoView({ behavior: 'smooth' });
}

function editRecipe(recipe) {
  fillForm(recipe);
  el('recipeFormTitle').textContent = 'Rezept bearbeiten';
  el('cancelEditBtn').style.display = 'inline-flex';
}

function formPayload() {
  return {
    name: el('recipeName').value.trim(),
    description: el('recipeDesc').value.trim(),
    source_url: el('recipeUrl').value.trim(),
    prep_time: el('recipePrepTime').value.trim(),
    servings: el('recipeServings').value.trim(),
    tags: el('recipeTags').value.trim(),
    instructions: el('recipeInstructions').value.trim(),
    ingredients: [...document.querySelectorAll('#ingredientRows .ingredient-row')]
      .map((row) => ({
        name: row.querySelector('.ing-name').value.trim(),
        amount: row.querySelector('.amount').value.trim(),
      }))
      .filter((i) => i.name.length > 0),
  };
}

// ── Liste ─────────────────────────────────────────────────────────────────────

// providerOf/PROVIDER_LABEL liegen in core.js – die Reste-Küche braucht sie
// genauso.
const PROVIDER_MODES = new Set(['chefkoch', 'cookidoo', 'other']);

function filteredRecipes() {
  const query = (el('recipeSearch')?.value || '').trim().toLowerCase();
  const mode = el('recipeFilter')?.value || 'all';

  return state.recipes.filter((r) => {
    // Anbieter-Filter zeigt alles dieser Herkunft – auch Gesperrtes und
    // Unvollständiges, sonst sucht man sich zu Tode.
    if (PROVIDER_MODES.has(mode)) {
      if (providerOf(r) !== mode) return false;
    } else {
      if (mode === 'favourites' && !(r.rating_count > 0 && Number(r.avg_stars) >= 4)) {
        return false;
      }
      if (mode === 'unrated' && r.rating_count > 0) return false;
      if (mode === 'blocked' && !r.blocked) return false;
      if (mode === 'missing' && !r.source_missing) return false;
      if (mode === 'incomplete' && !r.incomplete) return false;
      if (mode !== 'blocked' && r.blocked && mode !== 'all') return false;
      if (mode !== 'missing' && r.source_missing && mode !== 'all') return false;
      if (mode !== 'incomplete' && r.incomplete && mode !== 'all') return false;
    }
    if (!query) return true;
    const haystack = [
      r.name,
      r.description || '',
      (r.tags || []).join(' '),
      (r.ingredients || []).map((i) => i.name).join(' '),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

export function renderRecipeList() {
  const listEl = el('recipeList');
  const emptyEl = el('recipeListEmpty');
  if (!listEl) return;

  const recipes = filteredRecipes();
  const countEl = el('recipeCount');
  if (countEl) {
    countEl.textContent = `${recipes.length} von ${state.recipes.length} Rezepten`;
  }

  listEl.innerHTML = '';
  if (!recipes.length) {
    emptyEl.style.display = 'block';
    emptyEl.textContent = state.recipes.length
      ? 'Kein Rezept passt zur Suche.'
      : 'Noch keine Rezepte gespeichert.';
    return;
  }
  emptyEl.style.display = 'none';

  for (const recipe of recipes.slice(0, visibleCount)) {
    listEl.appendChild(buildRecipeCard(recipe));
  }
  if (recipes.length > visibleCount) {
    const more = document.createElement('button');
    more.className = 'btn btn-secondary';
    more.textContent = `Weitere ${Math.min(
      30,
      recipes.length - visibleCount
    )} von ${recipes.length - visibleCount} anzeigen`;
    more.addEventListener('click', () => {
      visibleCount += 30;
      renderRecipeList();
    });
    listEl.appendChild(more);
  }
}

function buildRecipeCard(recipe) {
  const node = document.createElement('div');
  node.className = `recipe-item${
    recipe.blocked || recipe.source_missing || recipe.incomplete ? ' is-blocked' : ''
  }`;
  const mealieLink =
    recipe.source === 'mealie' ? mealieRecipeLink(recipe.source_slug) : '';

  const tags = (recipe.ingredients || [])
    .map(
      (i) =>
        `<span class="ingredient-tag">${escHtml(
          i.amount ? `${i.amount} ${i.name}` : i.name
        )}</span>`
    )
    .join('');

  const meta = [];
  if (recipe.prep_time) meta.push(`⏱ ${escHtml(recipe.prep_time)}`);
  if (recipe.servings) meta.push(`🍽 ${escHtml(recipe.servings)}`);
  if (recipe.times_cooked) {
    meta.push(
      `👨‍🍳 ${recipe.times_cooked}× gekocht${
        recipe.last_cooked ? ` (zuletzt ${escHtml(deDate(recipe.last_cooked))})` : ''
      }`
    );
  }
  if (recipe.rejected_count) meta.push(`🗑 ${recipe.rejected_count}× rausgeflogen`);
  if (recipe.source_missing) {
    meta.push('⚠️ in Mealie nicht mehr vorhanden – wird nicht mehr gewürfelt');
  }
  if (recipe.incomplete) {
    meta.push('⚠️ unvollständig (Anriss hinter der PLUS-Schranke) – wird nicht gewürfelt');
  }
  if (recipe.source_url) {
    meta.push(
      `🔗 <a href="${escHtml(recipe.source_url)}" target="_blank" rel="noopener noreferrer">${
        PROVIDER_LABEL[providerOf(recipe)] || 'Quelle'
      }</a>`
    );
  }

  const instructions = recipe.instructions
    ? `<details class="instructions">
         <summary>Zubereitung anzeigen</summary>
         <div>${escHtml(recipe.instructions)}</div>
       </details>`
    : '';

  node.innerHTML = `
    ${recipeThumb(recipe)}
    <div class="recipe-info">
      <h3>${escHtml(recipe.name)} ${ratingBadge(recipe)}</h3>
      ${meta.length ? `<div class="meta">${meta.join(' &nbsp;·&nbsp; ')}</div>` : ''}
      ${recipe.description ? `<p>${escHtml(recipe.description)}</p>` : ''}
      ${recipe.tags?.length ? `<div class="chips">${tagChips(recipe.tags)}</div>` : ''}
      <div class="ingredient-tags">${
        tags || '<em class="hint">Keine Zutaten eingetragen.</em>'
      }</div>
      ${instructions}
      <div class="rate-block">
        <span class="hint">Bewerten:</span>
        ${ratingButtonsHtml({ compact: true })}
      </div>
    </div>
    <div class="recipe-actions">
      <button class="btn btn-primary btn-sm" data-action="import">🛒 Zutaten</button>
      ${
        mealieLink
          ? `<a class="btn btn-secondary btn-sm" href="${escHtml(
              mealieLink
            )}" target="_blank" rel="noopener noreferrer">✏️ In Mealie</a>`
          : '<button class="btn btn-secondary btn-sm" data-action="edit">✏️ Bearbeiten</button>'
      }
      ${
        recipe.incomplete && mealieLink
          ? '<button class="btn btn-secondary btn-sm" data-action="repair" title="Zutaten und Zubereitung aus der Chefkoch-API nachtragen">🩹 Anreichern</button>'
          : ''
      }
      <button class="btn btn-secondary btn-sm" data-action="block">${
        recipe.blocked ? '✅ Entsperren' : '⛔ Sperren'
      }</button>
      ${
        mealieLink && !recipe.source_missing
          ? '<button class="btn btn-danger btn-sm" data-action="mealie-delete">🗑 In Mealie löschen</button>'
          : `<button class="btn btn-danger btn-sm" data-action="delete">🗑 ${
              recipe.source_missing ? 'Endgültig löschen' : 'Löschen'
            }</button>`
      }
    </div>
  `;

  node
    .querySelector('[data-action="import"]')
    .addEventListener('click', () => openImportModal(recipe.id));
  node
    .querySelector('[data-action="edit"]')
    ?.addEventListener('click', () => editRecipe(recipe));
  node.querySelector('[data-action="repair"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await apiFetch(`/api/mealie/repair/${recipe.id}`, { method: 'POST' });
      flash('mealieResult', escHtml(res.message), res.outcome === 'repaired' ? 'success' : 'info');
      await refreshAll();
    } catch (err) {
      flash('mealieResult', `Fehler: ${escHtml(err.message)}`, 'error');
      setLoading(btn, false);
    }
  });
  node.querySelector('[data-action="block"]').addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      await apiFetch(`/api/recipes/${recipe.id}/block`, {
        method: 'POST',
        body: JSON.stringify({ blocked: !recipe.blocked }),
      });
      await refreshAll();
    } catch (err) {
      alert(`Fehler: ${err.message}`);
      setLoading(e.currentTarget, false);
    }
  });
  node
    .querySelector('[data-action="delete"]')
    ?.addEventListener('click', () => deleteRecipeById(recipe.id, recipe.name));

  node
    .querySelector('[data-action="mealie-delete"]')
    ?.addEventListener('click', async (e) => {
      if (
        !confirm(
          `"${recipe.name}" in Mealie löschen?\n` +
            'Das Rezept verschwindet dort dauerhaft. Bewertungen und Plan-Einträge ' +
            'bleiben hier erhalten, falls es welche gibt.'
        )
      ) {
        return;
      }
      setLoading(e.currentTarget, true);
      try {
        const res = await apiFetch(`/api/mealie/recipe/${recipe.id}`, { method: 'DELETE' });
        await refreshAll();
        if (res.kept) alert(res.message);
      } catch (err) {
        alert(`Fehler: ${err.message}`);
        setLoading(e.currentTarget, false);
      }
    });

  wireRatingButtons(node, async (rating, btn) => {
    setLoading(btn, true);
    try {
      await apiFetch(`/api/recipes/${recipe.id}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      });
      await refreshAll();
    } catch (err) {
      alert(`Fehler: ${err.message}`);
      setLoading(btn, false);
    }
  });

  return node;
}

async function deleteRecipeById(id, name) {
  if (!confirm(`Rezept "${name}" wirklich löschen?`)) return;
  try {
    await apiFetch(`/api/recipes/${id}`, { method: 'DELETE' });
    await refreshAll();
  } catch (err) {
    alert(`Fehler: ${err.message}`);
  }
}

// Rezepte, Geschmacksprofil und – falls sichtbar – der Wochenplan neu laden.
async function refreshAll() {
  await refreshRecipes();
  await loadTaste();
}

// ── Import in eine Bring-Liste ────────────────────────────────────────────────

function openImportModal(recipeId) {
  importTargetRecipeId = recipeId;
  el('modalResult').innerHTML = '';
  openModal('importModal');
}

// ── Geschmacksprofil ──────────────────────────────────────────────────────────

function chipList(entries, cls) {
  if (!entries.length) return '<em class="hint">noch keine Daten</em>';
  return entries
    .map(
      (e) =>
        `<span class="chip ${cls}" title="${e.count} Bewertung(en), Wert ${e.score}">${escHtml(
          e.name
        )}</span>`
    )
    .join('');
}

export async function loadTaste() {
  const target = el('tasteCard');
  if (!target) return;
  try {
    const t = await apiFetch('/api/taste');
    target.innerHTML = `
      <div class="stat-row">
        <div class="stat"><b>${t.recipe_count}</b><span>Rezepte</span></div>
        <div class="stat"><b>${t.rated_count}</b><span>bewertet</span></div>
        <div class="stat"><b>${
          t.avg_stars === null ? '–' : t.avg_stars.toFixed(1)
        }</b><span>⌀ Sterne</span></div>
        <div class="stat"><b>${t.rejected_count}</b><span>rausgeflogen</span></div>
        <div class="stat"><b>${t.blocked_count}</b><span>gesperrt</span></div>
      </div>
      <div class="taste-grid">
        <div>
          <label>😋 Mögen wir</label>
          <div class="chips">${chipList(t.liked_ingredients, 'chip-good')}</div>
          <div class="chips">${chipList(t.liked_tags, 'chip-good')}</div>
        </div>
        <div>
          <label>👎 Mögen wir nicht</label>
          <div class="chips">${chipList(t.disliked_ingredients, 'chip-bad')}</div>
          <div class="chips">${chipList(t.disliked_tags, 'chip-bad')}</div>
        </div>
      </div>
      <div class="taste-grid">
        <div>
          <label>🏆 Favoriten</label>
          ${
            t.favourites.length
              ? `<ul class="plain">${t.favourites
                  .map(
                    (f) =>
                      `<li>${escHtml(f.name)} <span class="hint">${starsText(
                        f.avg_stars
                      )} (${f.rating_count})</span></li>`
                  )
                  .join('')}</ul>`
              : '<em class="hint">noch keine Bewertungen</em>'
          }
        </div>
        <div>
          <label>🥴 Flops</label>
          ${
            t.flops.length
              ? `<ul class="plain">${t.flops
                  .map(
                    (f) =>
                      `<li>${escHtml(f.name)} <span class="hint">${starsText(
                        f.avg_stars
                      )} (${f.rating_count})</span></li>`
                  )
                  .join('')}</ul>`
              : '<em class="hint">nichts durchgefallen</em>'
          }
        </div>
      </div>
      <p class="hint">
        Der Würfel bevorzugt gut bewertete Rezepte und Zutaten, die hier links
        stehen. Gesperrte Rezepte („nie wieder") kommen nicht mehr vor.
      </p>`;
  } catch (err) {
    target.innerHTML = `<div class="alert alert-error">Geschmacksprofil nicht ladbar: ${escHtml(
      err.message
    )}</div>`;
  }
}

// ── Mealie als Rezeptquelle ───────────────────────────────────────────────────

// Ist Mealie die Quelle, verschwinden die lokalen Pflege- und Importkarten:
// Änderungen dort würde der nächste Abgleich ohnehin überschreiben.
export function applyMealieMode() {
  const active = mealieActive();
  el('mealieCard').style.display = active ? '' : 'none';
  for (const id of ['recipeFormCard', 'importCard', 'aiRecipeCard']) {
    if (el(id)) el(id).style.display = active ? 'none' : '';
  }
  if (!active) return;
  renderOrphans();
  const link = el('mealieOpenLink');
  const mealie = state.status.mealie;
  if (link) link.href = mealie.publicUrl || mealie.url;
  renderMealieStatus();
}

async function renderMealieStatus() {
  const target = el('mealieStatus');
  if (!target) return;
  try {
    const s = await apiFetch('/api/mealie/status');
    const when = s.finishedAt
      ? new Date(s.finishedAt).toLocaleString('de-DE')
      : 'noch nicht';
    const counts =
      s.status === 'idle'
        ? ''
        : `${s.added} neu · ${s.updated} geändert · ${s.unchanged} unverändert${
            s.missing ? ` · ${s.missing} in Mealie gelöscht` : ''
          }`;
    target.innerHTML = `
      <p class="hint">
        Rezepte werden in <a href="${escHtml(s.publicUrl || s.url)}" target="_blank" rel="noopener noreferrer">Mealie</a>
        gepflegt${s.version ? ` (${escHtml(s.version)})` : ''}. Diese App hält einen Spiegel,
        damit Wochenplan, Bewertungen und Reste-Suche auch dann funktionieren,
        wenn Mealie gerade nicht läuft. Abgeglichen wird beim Start und alle paar
        Minuten automatisch.
      </p>
      ${
        s.reachable === false
          ? `<div class="alert alert-error">Mealie nicht erreichbar: ${escHtml(
              s.error || 'unbekannter Fehler'
            )}</div>`
          : ''
      }
      <div class="hint">Letzter Abgleich: ${escHtml(when)}${counts ? ` — ${counts}` : ''}</div>
      ${
        s.status === 'error' && s.error
          ? `<div class="alert alert-error">${escHtml(s.error)}</div>`
          : ''
      }`;
  } catch (err) {
    target.innerHTML = `<div class="alert alert-error">Mealie-Status nicht ladbar: ${escHtml(
      err.message
    )}</div>`;
  }
}

// Verwaiste Spiegel-Einträge: in Mealie gelöscht, hier noch vorhanden.
async function renderOrphans() {
  const box = el('mealieOrphans');
  if (!box) return;
  try {
    const o = await apiFetch('/api/mealie/orphans');
    if (!o.count) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `
      <div class="alert alert-info">
        <b>${o.count} Rezept(e) sind in Mealie gelöscht</b>, liegen hier aber noch:
        ${o.without_history} ohne Historie${
          o.with_history
            ? `, ${o.with_history} mit Bewertungen oder Plan-Einträgen`
            : ''
        }.
        Sie werden nicht mehr gewürfelt. Im Filter „In Mealie gelöscht" siehst du sie einzeln.
        <div class="btn-group">
          <button class="btn btn-secondary btn-sm" id="orphanCleanBtn">🧹 ${
            o.without_history
          } ohne Historie löschen</button>
          ${
            o.with_history
              ? `<button class="btn btn-danger btn-sm" id="orphanCleanAllBtn">🗑 Alle ${o.count} löschen (auch die Historie)</button>`
              : ''
          }
        </div>
      </div>`;

    const clean = async (withHistory, btn) => {
      if (
        withHistory &&
        !confirm(
          `Alle ${o.count} verwaisten Rezepte löschen – samt Bewertungen und ` +
            'Plan-Einträgen?\nDamit geht auch der gelernte Geschmack dieser Rezepte verloren.'
        )
      ) {
        return;
      }
      setLoading(btn, true);
      try {
        const res = await apiFetch(
          `/api/mealie/orphans${withHistory ? '?withHistory=1' : ''}`,
          { method: 'DELETE' }
        );
        flash(
          'mealieResult',
          `✓ ${res.deleted} Rezept(e) gelöscht${
            res.kept ? `, ${res.kept} mit Historie behalten` : ''
          }.`
        );
        await refreshAll();
        renderOrphans();
      } catch (err) {
        flash('mealieResult', `Fehler: ${escHtml(err.message)}`, 'error');
        setLoading(btn, false);
      }
    };

    el('orphanCleanBtn')?.addEventListener('click', (e) => clean(false, e.currentTarget));
    el('orphanCleanAllBtn')?.addEventListener('click', (e) => clean(true, e.currentTarget));
  } catch {
    box.innerHTML = '';
  }
}

// Chefkoch -> Mealie (nur im Mealie-Modus sichtbar). Fortschritt wie beim
// lokalen Massenimport, nur landen die Rezepte in Mealie.
let ckPollTimer = null;

function renderCkJob(job) {
  const box = el('ckStatus');
  if (!box) return;
  if (!job || job.status === 'idle') {
    box.innerHTML = '';
    return;
  }
  const total = job.total || job.requested || 0;
  const percent = total ? Math.min(100, Math.round((job.done / total) * 100)) : 0;
  const statusText =
    { running: '⏳ läuft', done: '✓ fertig', error: '✗ Fehler', cancelled: '■ abgebrochen' }[
      job.status
    ] || job.status;
  box.innerHTML = `
    <div class="progress"><div class="progress-bar" style="width:${percent}%"></div></div>
    <div class="hint">
      ${statusText} · ${job.done}/${total || '?'} · ${job.imported} in Mealie ·
      ${job.skipped} übersprungen · ${job.failed} fehlgeschlagen${
        job.minRating ? ` · Filter ab ${job.minRating}★` : ''
      }${job.minVotes ? ` / ${job.minVotes} Stimmen` : ''}
    </div>
    ${job.error ? `<div class="alert alert-error">${escHtml(job.error)}</div>` : ''}
    <details class="log"><summary>Protokoll</summary><pre>${escHtml(
      (job.log || []).join('\n')
    )}</pre></details>`;
  el('ckCancelBtn').style.display = job.status === 'running' ? 'inline-flex' : 'none';
}

async function pollCkJob() {
  try {
    const job = await apiFetch('/api/mealie/import-status');
    renderCkJob(job);
    if (job.status === 'running' || job.status === 'idle') return job;
    clearInterval(ckPollTimer);
    ckPollTimer = null;
    el('ckImportBtn').disabled = false;
    await refreshAll();
    renderMealieStatus();
    return job;
  } catch (err) {
    clearInterval(ckPollTimer);
    ckPollTimer = null;
    el('ckImportBtn').disabled = false;
    flash('ckResult', `Fehler: ${escHtml(err.message)}`, 'error');
    return null;
  }
}

// ── Massenimport (Chefkoch) ───────────────────────────────────────────────────

function renderImportJob(job) {
  const box = el('bulkImportStatus');
  if (!box) return;
  if (!job || job.status === 'idle') {
    box.innerHTML = '';
    return;
  }
  const total = job.total || job.requested || 0;
  const percent = total ? Math.min(100, Math.round((job.done / total) * 100)) : 0;
  const statusText = {
    running: '⏳ läuft',
    done: '✓ fertig',
    error: '✗ Fehler',
    cancelled: '■ abgebrochen',
  }[job.status] || job.status;

  box.innerHTML = `
    <div class="progress"><div class="progress-bar" style="width:${percent}%"></div></div>
    <div class="hint">
      ${statusText} · ${job.done}/${total || '?'} · ${job.imported} importiert ·
      ${job.skipped} übersprungen · ${job.failed} fehlgeschlagen
    </div>
    ${job.error ? `<div class="alert alert-error">${escHtml(job.error)}</div>` : ''}
    <details class="log"><summary>Protokoll</summary><pre>${escHtml(
      (job.log || []).join('\n')
    )}</pre></details>`;

  el('bulkCancelBtn').style.display = job.status === 'running' ? 'inline-flex' : 'none';
}

async function pollImportJob() {
  try {
    const job = await apiFetch('/api/recipes/import/status');
    renderImportJob(job);
    if (job.status === 'running' || job.status === 'idle') return job;
    // Lauf beendet: Timer stoppen und die neuen Rezepte anzeigen.
    clearInterval(importPollTimer);
    importPollTimer = null;
    el('bulkImportBtn').disabled = false;
    await refreshAll();
    return job;
  } catch (err) {
    clearInterval(importPollTimer);
    importPollTimer = null;
    flash('bulkImportResult', `Fehler: ${escHtml(err.message)}`, 'error');
    el('bulkImportBtn').disabled = false;
    return null;
  }
}

function startPolling() {
  if (importPollTimer) return;
  importPollTimer = setInterval(pollImportJob, 1500);
  pollImportJob();
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Adresse für den iOS-Kurzbefehl – mit Token, falls die App eins verlangt.
function renderShortcutUrl() {
  const node = el('addUrlShortcut');
  if (!node) return;
  const base = `${location.origin}/api/recipes/add?url=URL_HIER`;
  node.textContent = state.status?.apiTokenEnabled ? `${base}&token=DEIN_API_TOKEN` : base;
}

export async function initRecipes() {
  renderShortcutUrl();

  on('addUrlBtn', 'click', async (e) => {
    const url = el('addUrl').value.trim();
    if (!url) return flash('addUrlResult', 'Bitte eine Adresse einfügen.', 'error');
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await apiFetch('/api/recipes/add', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      flash('addUrlResult', escHtml(res.message), res.duplicate ? 'info' : 'success');
      if (!res.duplicate) el('addUrl').value = '';
      await refreshAll();
    } catch (err) {
      flash('addUrlResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('addIngredientBtn', 'click', () => {
    el('ingredientRows').appendChild(createIngredientRow());
  });
  on('cancelEditBtn', 'click', resetRecipeForm);

  on('saveRecipeBtn', 'click', async () => {
    const btn = el('saveRecipeBtn');
    const resultEl = el('recipeFormResult');
    const payload = formPayload();
    const id = el('recipeId').value;
    if (!payload.name) return flash(resultEl, 'Bitte einen Rezeptnamen eingeben.', 'error');

    setLoading(btn, true);
    try {
      if (id) {
        await apiFetch(`/api/recipes/${id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        flash(resultEl, '✓ Rezept aktualisiert.');
      } else {
        await apiFetch('/api/recipes', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        flash(resultEl, '✓ Rezept gespeichert.');
      }
      resetRecipeForm();
      await refreshAll();
    } catch (err) {
      flash(resultEl, `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  // KI-Analyse eines eingefügten Rezepttexts
  on('clearRawBtn', 'click', () => {
    el('recipeRawText').value = '';
    el('analyzeResult').innerHTML = '';
  });

  on('analyzeBtn', 'click', async () => {
    const btn = el('analyzeBtn');
    const resultEl = el('analyzeResult');
    const text = el('recipeRawText').value.trim();
    if (!text) return flash(resultEl, 'Bitte zuerst einen Rezepttext einfügen.', 'error');

    setLoading(btn, true);
    try {
      const recipe = await apiFetch('/api/recipes/analyze', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      resetRecipeForm();
      fillForm(recipe);
      flash(
        resultEl,
        `✓ ${(recipe.ingredients || []).length} Zutaten erkannt. Bitte unten prüfen und speichern.`
      );
    } catch (err) {
      flash(resultEl, `Fehler bei der Analyse: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  // Import per URL
  on('urlImportBtn', 'click', async () => {
    const btn = el('urlImportBtn');
    const resultEl = el('urlImportResult');
    const url = el('importUrl').value.trim();
    if (!url) return flash(resultEl, 'Bitte eine Rezept-URL einfügen.', 'error');

    setLoading(btn, true);
    try {
      const { recipe } = await apiFetch('/api/recipes/import/url', {
        method: 'POST',
        body: JSON.stringify({ url, ai: el('urlImportAi').checked }),
      });
      resetRecipeForm();
      fillForm(recipe);
      flash(
        resultEl,
        `✓ "${escHtml(recipe.name)}" mit ${
          (recipe.ingredients || []).length
        } Zutaten geladen. Bitte unten prüfen und speichern.`
      );
    } catch (err) {
      flash(resultEl, `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('urlImportSaveBtn', 'click', async () => {
    const btn = el('urlImportSaveBtn');
    const resultEl = el('urlImportResult');
    const url = el('importUrl').value.trim();
    if (!url) return flash(resultEl, 'Bitte eine Rezept-URL einfügen.', 'error');

    setLoading(btn, true);
    try {
      const res = await apiFetch('/api/recipes/import/url', {
        method: 'POST',
        body: JSON.stringify({ url, save: true, ai: el('urlImportAi').checked }),
      });
      flash(
        resultEl,
        res.duplicate
          ? `ℹ "${escHtml(res.recipe.name)}" war schon gespeichert.`
          : `✓ "${escHtml(res.recipe.name)}" gespeichert.`
      );
      el('importUrl').value = '';
      await refreshAll();
    } catch (err) {
      flash(resultEl, `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  // Massenimport
  on('bulkImportBtn', 'click', async () => {
    const resultEl = el('bulkImportResult');
    const query = el('bulkQuery').value.trim();
    const count = Number(el('bulkCount').value) || 200;
    const minRating = Number(el('bulkMinRating').value) || 0;
    const minVotes = Number(el('bulkMinVotes').value) || 0;
    if (
      !confirm(
        `${count} Rezepte von chefkoch.de importieren?\n` +
          'Das dauert je nach Anzahl einige Minuten und läuft im Hintergrund weiter.'
      )
    ) {
      return;
    }
    el('bulkImportBtn').disabled = true;
    try {
      await apiFetch('/api/recipes/import/chefkoch', {
        method: 'POST',
        body: JSON.stringify({ query, count, minRating, minVotes }),
      });
      flash(resultEl, '✓ Import gestartet – Fortschritt siehe unten.', 'info');
      startPolling();
    } catch (err) {
      flash(resultEl, `Fehler: ${escHtml(err.message)}`, 'error');
      el('bulkImportBtn').disabled = false;
    }
  });

  on('bulkCancelBtn', 'click', async () => {
    try {
      await apiFetch('/api/recipes/import/cancel', { method: 'POST' });
    } catch (err) {
      flash('bulkImportResult', `Fehler: ${escHtml(err.message)}`, 'error');
    }
  });

  on('mealieRepairBtn', 'click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const r = await apiFetch('/api/mealie/repair', { method: 'POST' });
      flash(
        'mealieResult',
        r.checked === 0
          ? 'Keine unvollständigen Chefkoch-Rezepte gefunden.'
          : `✓ ${r.repaired} von ${r.checked} ergänzt` +
              `${r.unchanged ? `, ${r.unchanged} ohne neue Daten (vermutlich PLUS-Rezepte)` : ''}` +
              `${r.failed ? `, ${r.failed} fehlgeschlagen` : ''}.` +
              (r.names.length ? ` Ergänzt: ${escHtml(r.names.slice(0, 5).join(', '))}` : ''),
        r.repaired ? 'success' : 'info'
      );
      await refreshAll();
    } catch (err) {
      flash('mealieResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('mealieSyncBtn', 'click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const s = await apiFetch('/api/mealie/sync', { method: 'POST' });
      renderOrphans();
      flash(
        'mealieResult',
        `✓ Abgleich fertig: ${s.added} neu, ${s.updated} geändert, ${s.unchanged} unverändert` +
          (s.missing ? `, ${s.missing} in Mealie gelöscht` : '')
      );
      await refreshAll();
      renderMealieStatus();
    } catch (err) {
      flash('mealieResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('ckImportBtn', 'click', async () => {
    const query = el('ckQuery').value.trim();
    const count = Number(el('ckCount').value) || 20;
    const minRating = Number(el('ckMinRating').value) || 0;
    const minVotes = Number(el('ckMinVotes').value) || 0;
    if (
      !confirm(
        `${count} Rezepte von chefkoch.de über Mealie importieren?\n` +
          'Das dauert je nach Anzahl einige Minuten und läuft im Hintergrund weiter.'
      )
    ) {
      return;
    }
    el('ckImportBtn').disabled = true;
    try {
      await apiFetch('/api/mealie/import-chefkoch', {
        method: 'POST',
        body: JSON.stringify({ query, count, minRating, minVotes }),
      });
      flash('ckResult', '✓ Import gestartet – Fortschritt siehe unten.', 'info');
      if (!ckPollTimer) {
        ckPollTimer = setInterval(pollCkJob, 2000);
        pollCkJob();
      }
    } catch (err) {
      flash('ckResult', `Fehler: ${escHtml(err.message)}`, 'error');
      el('ckImportBtn').disabled = false;
    }
  });

  on('ckCancelBtn', 'click', async () => {
    try {
      await apiFetch('/api/mealie/import-cancel', { method: 'POST' });
    } catch (err) {
      flash('ckResult', `Fehler: ${escHtml(err.message)}`, 'error');
    }
  });

  // Liste filtern
  on('recipeSearch', 'input', () => {
    visibleCount = 30;
    renderRecipeList();
  });
  on('recipeFilter', 'change', () => {
    visibleCount = 30;
    renderRecipeList();
  });

  // Modal "Zutaten in Bring-Liste"
  on('cancelImportBtn', 'click', () => closeModal('importModal'));
  on('confirmImportBtn', 'click', async () => {
    const btn = el('confirmImportBtn');
    const resultEl = el('modalResult');
    const listUuid = el('importListSelect').value;
    if (!listUuid) return flash(resultEl, 'Bitte eine Bring-Liste auswählen.', 'error');

    setLoading(btn, true);
    try {
      const result = await apiFetch(`/api/recipes/${importTargetRecipeId}/import`, {
        method: 'POST',
        body: JSON.stringify({ listUuid }),
      });
      flash(resultEl, `✓ ${result.imported.length} Zutaten importiert.`);
      setTimeout(() => closeModal('importModal'), 1600);
    } catch (err) {
      flash(resultEl, `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  populateListSelects();
  resetRecipeForm();
  // Falls beim Laden der Seite noch ein Import läuft: Fortschritt weiterverfolgen.
  const job = await pollImportJob();
  if (job?.status === 'running') {
    el('bulkImportBtn').disabled = true;
    startPolling();
  }
  if (mealieActive()) {
    const ck = await pollCkJob();
    if (ck?.status === 'running') {
      el('ckImportBtn').disabled = true;
      ckPollTimer = setInterval(pollCkJob, 2000);
    }
  }
}
