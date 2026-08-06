// Einstiegspunkt: Status, Bring-Listen, Tab-Navigation und Start der Module.

import {
  apiFetch,
  el,
  onRecipesChanged,
  populateListSelects,
  refreshRecipes,
  selectListEverywhere,
  state,
  wireModalDismiss,
} from './core.js';
import { initShopping, loadCurrentItems } from './shopping.js';
import { initRecipes, loadTaste, renderRecipeList } from './recipes.js';
import { initPlan, loadPlan } from './plan.js';
import { initFridge } from './fridge.js';

// ── Status ────────────────────────────────────────────────────────────────────

async function loadStatus() {
  const badge = el('statusBadge');
  try {
    const status = await apiFetch('/api/status');
    state.status = status;
    if (status.authEnabled) el('logoutLink').style.display = '';
    if (status.loggedIn) {
      badge.textContent = `✓ ${status.mail}`;
      badge.className = 'status-badge ok';
    } else {
      badge.textContent = '✗ Nicht verbunden';
      badge.className = 'status-badge err';
      badge.title = status.error || '';
    }
  } catch {
    badge.textContent = '✗ Fehler';
    badge.className = 'status-badge err';
  }
}

// ── Bring-Listen ──────────────────────────────────────────────────────────────

async function loadBringLists() {
  try {
    state.bringLists = await apiFetch('/api/lists');
    populateListSelects();
    await applyLastList();
  } catch (err) {
    console.error('Listen konnten nicht geladen werden:', err.message);
  }
}

// Zuletzt benutzte Bring-Liste überall vorwählen (geräteübergreifend, aus der DB).
async function applyLastList() {
  try {
    const { lastListUuid } = await apiFetch('/api/preferences');
    if (!lastListUuid) return;
    selectListEverywhere(lastListUuid);
    if (el('listSelect')?.value === lastListUuid) await loadCurrentItems(lastListUuid);
  } catch {
    /* Einstellungen optional */
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document
        .querySelectorAll('nav button')
        .forEach((b) => b.classList.remove('active'));
      document
        .querySelectorAll('.tab-panel')
        .forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      el(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'plan') loadPlan();
      if (btn.dataset.tab === 'recipes') loadTaste();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function init() {
  initTabs();
  initShopping();
  initPlan();
  initFridge();
  wireModalDismiss('importModal');
  wireModalDismiss('pickerModal');

  // Rezeptliste hängt am gemeinsamen Zwischenspeicher.
  onRecipesChanged(renderRecipeList);

  await loadStatus();
  await loadBringLists();
  await initRecipes();
  await refreshRecipes();
  await Promise.all([loadPlan('current'), loadTaste()]);
}

init();
