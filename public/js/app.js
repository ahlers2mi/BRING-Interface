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
import { applyMealieMode, initRecipes, loadTaste, renderRecipeList } from './recipes.js';
import { initPlan, loadPlan } from './plan.js';
import { initFridge } from './fridge.js';
import { applyCookidooMode, initCookidoo } from './cookidoo.js';

// ── Status ────────────────────────────────────────────────────────────────────

// „v1.4.0 · Stand 08.08. 11:07" – daran erkennt man, ob im Container wirklich
// der neue Stand läuft. Genau das war beim Bauen schon mehrfach die Frage.
function renderVersion(status) {
  const badge = el('versionBadge');
  if (!badge) return;
  const stand = status.builtAt
    ? new Date(status.builtAt).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  badge.textContent = `v${status.version || '?'}${stand ? ` · ${stand}` : ''}`;
}

async function loadStatus() {
  const badge = el('statusBadge');
  try {
    const status = await apiFetch('/api/status');
    state.status = status;
    renderVersion(status);
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

// Einstellungen getrennt von den Bring-Listen laden: hakt Bring (kein Konto,
// Dienst gerade weg), soll die Haushaltsgröße trotzdem im Feld stehen.
async function loadPreferences() {
  try {
    state.preferences = await apiFetch('/api/preferences');
    if (el('householdServings')) {
      el('householdServings').value = state.preferences.householdServings || '';
    }
    if (el('courseSideTags')) {
      el('courseSideTags').value = state.preferences.courseSideTags || '';
      el('courseMainTags').value = state.preferences.courseMainTags || '';
    }
    if (el('planQuickMinutes')) {
      el('planQuickMinutes').value = state.preferences.quickMinutes ?? '';
      el('planColdC').value = state.preferences.coldC ?? '';
      el('planWarmC').value = state.preferences.warmC ?? '';
    }
  } catch (err) {
    console.error('Einstellungen nicht ladbar:', err.message);
  }
}

// Zuletzt benutzte Bring-Liste überall vorwählen (geräteübergreifend, aus der DB).
async function applyLastList() {
  try {
    const { lastListUuid } = state.preferences || (await apiFetch('/api/preferences'));
    // Noch nie eine Liste benutzt? Dann die erste vorwählen – sonst steht die
    // Bearbeitungsansicht leer da und man weiß nicht, dass sie eine braucht.
    if (!lastListUuid) {
      const first = state.bringLists[0]?.listUuid;
      if (first) {
        selectListEverywhere(first);
        await loadCurrentItems(first);
      }
      return;
    }
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
      // Beim Öffnen des Quellen-Tabs den Zustand von Mealie und Cookidoo frisch
      // holen – dort steht, wann zuletzt abgeglichen wurde.
      if (btn.dataset.tab === 'import') {
        applyMealieMode();
        applyCookidooMode();
      }
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
  initCookidoo();
  wireModalDismiss('importModal');
  wireModalDismiss('pickerModal');
  wireModalDismiss('dayPickModal');

  // Rezeptliste hängt am gemeinsamen Zwischenspeicher.
  onRecipesChanged(renderRecipeList);

  await loadStatus();
  applyMealieMode(); // Rezeptpflege ausblenden, wenn Mealie die Quelle ist
  applyCookidooMode();
  await loadPreferences();
  await loadBringLists();
  await initRecipes();
  await refreshRecipes();
  await Promise.all([loadPlan('current'), loadTaste()]);
}

init();
