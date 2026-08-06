// Gemeinsame Helfer und der geteilte Zustand aller Oberflächen-Module.

export const state = {
  bringLists: [],
  recipes: [], // zuletzt geladene Rezepte (inkl. Zutaten)
  status: null,
};

// ── DOM ───────────────────────────────────────────────────────────────────────

export function el(id) {
  return document.getElementById(id);
}

export function on(id, event, handler) {
  const node = el(id);
  if (node) node.addEventListener(event, handler);
  return node;
}

export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function flash(target, html, type = 'success') {
  const node = typeof target === 'string' ? el(target) : target;
  if (!node) return;
  node.innerHTML = `<div class="alert alert-${type}">${html}</div>`;
  clearTimeout(node._flashTimer);
  node._flashTimer = setTimeout(() => {
    node.innerHTML = '';
  }, 6000);
}

export function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
    btn.disabled = false;
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

export async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (res.status === 401) {
    // Session abgelaufen / nicht angemeldet → zur Login-Seite.
    window.location.href = '/login';
    throw new Error('Nicht angemeldet.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Anzeige-Helfer ────────────────────────────────────────────────────────────

// "2026-08-06" -> "06.08.2026"
export function deDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
}

// Sterne als Text: 4.2 -> "★★★★☆"
export function starsText(value) {
  const stars = Math.round(Number(value) || 0);
  return '★★★★★'.slice(0, stars) + '☆☆☆☆☆'.slice(0, 5 - stars);
}

export function ratingBadge(recipe) {
  if (!recipe) return '';
  if (recipe.blocked) return '<span class="badge badge-blocked">⛔ gesperrt</span>';
  if (!recipe.rating_count) return '<span class="badge">neu</span>';
  const avg = Number(recipe.avg_stars);
  const cls = avg >= 4 ? 'badge-good' : avg <= 2 ? 'badge-bad' : '';
  return `<span class="badge ${cls}" title="${recipe.rating_count} Bewertung(en)">${starsText(
    avg
  )} ${avg.toFixed(1)}</span>`;
}

export function tagChips(tags) {
  if (!tags || !tags.length) return '';
  return tags.map((t) => `<span class="chip">${escHtml(t)}</span>`).join('');
}

// Adresse eines Rezepts in der Mealie-Oberfläche (Muster kommt aus /api/status).
export function mealieRecipeLink(slug) {
  const mealie = state.status?.mealie;
  if (!mealie?.enabled || !slug) return '';
  return String(mealie.recipeUrlPattern || '{base}/g/home/r/{slug}')
    .replace('{base}', mealie.url)
    .replace('{slug}', slug);
}

export function mealieActive() {
  return Boolean(state.status?.mealie?.enabled);
}

// ── Bring-Listen ──────────────────────────────────────────────────────────────

const LIST_SELECT_IDS = ['listSelect', 'importListSelect', 'planListSelect'];

export function populateListSelects() {
  for (const id of LIST_SELECT_IDS) {
    const sel = el(id);
    if (!sel) continue;
    const prev = sel.value;
    while (sel.options.length > 1) sel.remove(1); // Platzhalter behalten
    for (const list of state.bringLists) {
      sel.appendChild(new Option(list.name, list.listUuid));
    }
    if (prev) sel.value = prev;
  }
}

export function selectListEverywhere(uuid) {
  for (const id of LIST_SELECT_IDS) {
    const sel = el(id);
    if (sel && [...sel.options].some((o) => o.value === uuid)) sel.value = uuid;
  }
}

export async function saveLastList(uuid) {
  try {
    await apiFetch('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify({ lastListUuid: uuid }),
    });
  } catch {
    /* nicht kritisch */
  }
}

// Die zuletzt in irgendeinem Auswahlfeld gewählte Bring-Liste.
export function currentListUuid() {
  for (const id of LIST_SELECT_IDS) {
    const value = el(id)?.value;
    if (value) return value;
  }
  return '';
}

// ── Rezept-Zwischenspeicher ───────────────────────────────────────────────────

const recipeListeners = new Set();

export function onRecipesChanged(cb) {
  recipeListeners.add(cb);
}

// Lädt alle Rezepte (inkl. Zutaten und Bewertungs-Kennzahlen) und informiert
// die angemeldeten Module.
export async function refreshRecipes() {
  state.recipes = await apiFetch('/api/recipes');
  for (const cb of recipeListeners) {
    try {
      cb(state.recipes);
    } catch (err) {
      console.error('Rezept-Listener fehlgeschlagen:', err);
    }
  }
  return state.recipes;
}

export function recipeById(id) {
  return state.recipes.find((r) => r.id === Number(id)) || null;
}

// ── Bewertungs-Schaltflächen ──────────────────────────────────────────────────

export const RATING_BUTTONS = [
  { rating: 'lecker', icon: '😋', label: 'Lecker', title: 'Hat super geschmeckt (5)' },
  { rating: 'gut', icon: '🙂', label: 'Gut', title: 'Gut, gerne wieder (4)' },
  { rating: 'ok', icon: '😐', label: 'Ok', title: 'Ging so (3)' },
  { rating: 'schlecht', icon: '👎', label: 'Mies', title: 'Hat nicht geschmeckt (1)' },
  {
    rating: 'rausgeflogen',
    icon: '🗑',
    label: 'Rausgeflogen',
    title: 'Gar nicht gekocht – rausgeflogen',
  },
  {
    rating: 'nie_wieder',
    icon: '⛔',
    label: 'Nie wieder',
    title: 'Nie wieder vorschlagen (sperren)',
  },
];

export function ratingButtonsHtml({ compact = false } = {}) {
  return `<div class="rating-row">${RATING_BUTTONS.map(
    (b) =>
      `<button class="btn btn-rate btn-sm" data-rating="${b.rating}" title="${escHtml(
        b.title
      )}">${b.icon}${compact ? '' : ` <span>${escHtml(b.label)}</span>`}</button>`
  ).join('')}</div>`;
}

// Klick-Handler für eine mit `ratingButtonsHtml` erzeugte Leiste.
export function wireRatingButtons(container, handler) {
  container.querySelectorAll('[data-rating]').forEach((btn) => {
    btn.addEventListener('click', () => handler(btn.dataset.rating, btn));
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function openModal(id) {
  const node = el(id);
  if (node) node.style.display = 'flex';
}

export function closeModal(id) {
  const node = el(id);
  if (node) node.style.display = 'none';
}

// Klick auf den Hintergrund schließt das Modal.
export function wireModalDismiss(id) {
  const node = el(id);
  if (!node) return;
  node.addEventListener('click', (e) => {
    if (e.target === node) closeModal(id);
  });
}
