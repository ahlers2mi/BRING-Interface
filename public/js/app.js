// ── State ─────────────────────────────────────────────────────────────────────
let bringLists = [];
let importTargetRecipeId = null;

// ── Utility ───────────────────────────────────────────────────────────────────

function flash(el, html, type = 'success') {
  el.innerHTML = `<div class="alert alert-${type}">${html}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

function setLoading(btn, loading) {
  if (loading) {
    btn.dataset.originalText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
    btn.disabled = false;
  }
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Status badge ───────────────────────────────────────────────────────────────

async function loadStatus() {
  const badge = document.getElementById('statusBadge');
  try {
    const status = await apiFetch('/api/status');
    if (status.loggedIn) {
      badge.textContent = `✓ ${status.mail}`;
      badge.className = 'status-badge ok';
    } else {
      badge.textContent = '✗ Nicht verbunden';
      badge.className = 'status-badge err';
    }
  } catch {
    badge.textContent = '✗ Fehler';
    badge.className = 'status-badge err';
  }
}

// ── Bring Lists ────────────────────────────────────────────────────────────────

async function loadBringLists() {
  try {
    bringLists = await apiFetch('/api/lists');
    populateListSelects();
  } catch (err) {
    console.error('Listen konnten nicht geladen werden:', err.message);
  }
}

function populateListSelects() {
  const selects = ['listSelect', 'importListSelect'];
  for (const id of selects) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    // keep first placeholder option
    while (sel.options.length > 1) sel.remove(1);
    for (const list of bringLists) {
      const opt = new Option(list.name, list.listUuid);
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
  }
}

// ── Tab navigation ─────────────────────────────────────────────────────────────

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Shopping List ──────────────────────────────────────────────────────────────

document.getElementById('importBtn').addEventListener('click', async () => {
  const btn = document.getElementById('importBtn');
  const resultEl = document.getElementById('importResult');
  const listUuid = document.getElementById('listSelect').value;
  const text = document.getElementById('itemsText').value.trim();

  if (!listUuid) return flash(resultEl, 'Bitte zuerst eine Bring-Liste auswählen.', 'error');
  if (!text) return flash(resultEl, 'Bitte mindestens einen Artikel eingeben.', 'error');

  setLoading(btn, true);
  try {
    const result = await apiFetch(`/api/lists/${listUuid}/items`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    flash(resultEl, `✓ ${result.imported.length} Artikel importiert: ${result.imported.join(', ')}`);
    await loadCurrentItems(listUuid);
  } catch (err) {
    flash(resultEl, `Fehler: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false);
  }
});

document.getElementById('clearBtn').addEventListener('click', () => {
  document.getElementById('itemsText').value = '';
  document.getElementById('importResult').innerHTML = '';
});

document.getElementById('listSelect').addEventListener('change', async (e) => {
  if (e.target.value) await loadCurrentItems(e.target.value);
  else document.getElementById('currentItems').innerHTML =
    'Wähle eine Liste aus, um die aktuellen Artikel anzuzeigen.';
});

async function loadCurrentItems(listUuid) {
  const el = document.getElementById('currentItems');
  el.innerHTML = '<span class="spinner"></span>';
  try {
    const data = await apiFetch(`/api/lists/${listUuid}/items`);
    const items = data.purchase ?? [];
    if (items.length === 0) {
      el.innerHTML = '<em style="color:var(--text-muted)">Liste ist leer.</em>';
      return;
    }
    el.innerHTML = items
      .map(
        (i) =>
          `<span class="ingredient-tag">${i.name}${i.specification ? ' – ' + i.specification : ''}</span>`
      )
      .join('');
  } catch (err) {
    el.innerHTML = `<span style="color:var(--danger)">Fehler: ${err.message}</span>`;
  }
}

// ── Recipe Form ────────────────────────────────────────────────────────────────

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

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.getElementById('addIngredientBtn').addEventListener('click', () => {
  document.getElementById('ingredientRows').appendChild(createIngredientRow());
});

function resetRecipeForm() {
  document.getElementById('recipeId').value = '';
  document.getElementById('recipeName').value = '';
  document.getElementById('recipeDesc').value = '';
  document.getElementById('ingredientRows').innerHTML = '';
  document.getElementById('recipeFormTitle').textContent = 'Neues Rezept';
  document.getElementById('cancelEditBtn').style.display = 'none';
  document.getElementById('recipeFormResult').innerHTML = '';
  // Add one empty ingredient row by default
  document.getElementById('ingredientRows').appendChild(createIngredientRow());
}

document.getElementById('cancelEditBtn').addEventListener('click', resetRecipeForm);

document.getElementById('saveRecipeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveRecipeBtn');
  const resultEl = document.getElementById('recipeFormResult');
  const name = document.getElementById('recipeName').value.trim();
  const description = document.getElementById('recipeDesc').value.trim();
  const id = document.getElementById('recipeId').value;

  if (!name) return flash(resultEl, 'Bitte einen Rezeptnamen eingeben.', 'error');

  const ingredients = [...document.querySelectorAll('.ingredient-row')]
    .map((row) => ({
      name: row.querySelector('.ing-name').value.trim(),
      amount: row.querySelector('.amount').value.trim(),
    }))
    .filter((i) => i.name.length > 0);

  setLoading(btn, true);
  try {
    if (id) {
      await apiFetch(`/api/recipes/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, ingredients }),
      });
      flash(resultEl, '✓ Rezept aktualisiert.');
    } else {
      await apiFetch('/api/recipes', {
        method: 'POST',
        body: JSON.stringify({ name, description, ingredients }),
      });
      flash(resultEl, '✓ Rezept gespeichert.');
    }
    resetRecipeForm();
    await loadRecipes();
  } catch (err) {
    flash(resultEl, `Fehler: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false);
  }
});

// ── KI-Rezeptanalyse ─────────────────────────────────────────────────────────

document.getElementById('clearRawBtn').addEventListener('click', () => {
  document.getElementById('recipeRawText').value = '';
  document.getElementById('analyzeResult').innerHTML = '';
});

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('analyzeBtn');
  const resultEl = document.getElementById('analyzeResult');
  const text = document.getElementById('recipeRawText').value.trim();

  if (!text) return flash(resultEl, 'Bitte zuerst einen Rezepttext einfügen.', 'error');

  setLoading(btn, true);
  try {
    const recipe = await apiFetch('/api/recipes/analyze', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });

    // Ergebnis ins Formular übernehmen – Nutzer prüft und speichert selbst
    resetRecipeForm();
    document.getElementById('recipeName').value = recipe.name || '';
    document.getElementById('recipeDesc').value = recipe.description || '';
    const rows = document.getElementById('ingredientRows');
    rows.innerHTML = '';
    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    for (const ing of ingredients) {
      rows.appendChild(createIngredientRow(ing.name || '', ing.amount || ''));
    }
    if (ingredients.length === 0) rows.appendChild(createIngredientRow());

    flash(
      resultEl,
      `✓ ${ingredients.length} Zutaten erkannt. Bitte unten prüfen und speichern.`
    );
    document.getElementById('recipeFormCard').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    flash(resultEl, `Fehler bei der Analyse: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false);
  }
});

// ── Recipe List ────────────────────────────────────────────────────────────────

async function loadRecipes() {
  const listEl = document.getElementById('recipeList');
  const emptyEl = document.getElementById('recipeListEmpty');
  try {
    const recipes = await apiFetch('/api/recipes');
    listEl.innerHTML = '';
    if (recipes.length === 0) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    for (const r of recipes) {
      const full = await apiFetch(`/api/recipes/${r.id}`);
      listEl.appendChild(buildRecipeCard(full));
    }
  } catch (err) {
    listEl.innerHTML = `<div class="alert alert-error">Fehler beim Laden der Rezepte: ${err.message}</div>`;
  }
}

function buildRecipeCard(recipe) {
  const el = document.createElement('div');
  el.className = 'recipe-item';
  const tags = recipe.ingredients
    .map((i) => `<span class="ingredient-tag">${escHtml(i.amount ? i.amount + ' ' + i.name : i.name)}</span>`)
    .join('');
  el.innerHTML = `
    <div class="recipe-info">
      <h3>${escHtml(recipe.name)}</h3>
      ${recipe.description ? `<p>${escHtml(recipe.description)}</p>` : ''}
      <div style="margin-top:0.5rem;">${tags || '<em style="color:var(--text-muted);font-size:0.85rem;">Keine Zutaten eingetragen.</em>'}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:0.4rem;flex-shrink:0;">
      <button class="btn btn-primary btn-sm" data-action="import">🛒 Importieren</button>
      <button class="btn btn-secondary btn-sm" data-action="edit">✏️ Bearbeiten</button>
      <button class="btn btn-danger btn-sm" data-action="delete">🗑 Löschen</button>
    </div>
  `;

  el.querySelector('[data-action="import"]').addEventListener('click', () => openImportModal(recipe.id));
  el.querySelector('[data-action="edit"]').addEventListener('click', () => editRecipe(recipe));
  el.querySelector('[data-action="delete"]').addEventListener('click', () => deleteRecipeById(recipe.id));

  return el;
}

async function deleteRecipeById(id) {
  if (!confirm('Rezept wirklich löschen?')) return;
  try {
    await apiFetch(`/api/recipes/${id}`, { method: 'DELETE' });
    await loadRecipes();
  } catch (err) {
    alert(`Fehler: ${err.message}`);
  }
}

function editRecipe(recipe) {
  document.getElementById('recipeId').value = recipe.id;
  document.getElementById('recipeName').value = recipe.name;
  document.getElementById('recipeDesc').value = recipe.description || '';
  document.getElementById('recipeFormTitle').textContent = 'Rezept bearbeiten';
  document.getElementById('cancelEditBtn').style.display = 'inline-flex';
  const rows = document.getElementById('ingredientRows');
  rows.innerHTML = '';
  for (const ing of recipe.ingredients) {
    rows.appendChild(createIngredientRow(ing.name, ing.amount || ''));
  }
  if (recipe.ingredients.length === 0) rows.appendChild(createIngredientRow());
  document.getElementById('recipeFormCard').scrollIntoView({ behavior: 'smooth' });
}

// ── Import Modal ───────────────────────────────────────────────────────────────

function openImportModal(recipeId) {
  importTargetRecipeId = recipeId;
  document.getElementById('modalResult').innerHTML = '';
  document.getElementById('importModal').style.display = 'flex';
}

document.getElementById('cancelImportBtn').addEventListener('click', () => {
  document.getElementById('importModal').style.display = 'none';
});

document.getElementById('importModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('importModal')) {
    document.getElementById('importModal').style.display = 'none';
  }
});

document.getElementById('confirmImportBtn').addEventListener('click', async () => {
  const btn = document.getElementById('confirmImportBtn');
  const resultEl = document.getElementById('modalResult');
  const listUuid = document.getElementById('importListSelect').value;

  if (!listUuid) return flash(resultEl, 'Bitte eine Bring-Liste auswählen.', 'error');

  setLoading(btn, true);
  try {
    const result = await apiFetch(`/api/recipes/${importTargetRecipeId}/import`, {
      method: 'POST',
      body: JSON.stringify({ listUuid }),
    });
    flash(resultEl, `✓ ${result.imported.length} Zutaten importiert.`);
    setTimeout(() => {
      document.getElementById('importModal').style.display = 'none';
    }, 1800);
  } catch (err) {
    flash(resultEl, `Fehler: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false);
  }
});

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  await loadStatus();
  await loadBringLists();
  resetRecipeForm();
  await loadRecipes();
}

init();
