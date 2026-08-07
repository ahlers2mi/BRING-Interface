// Karte "Cookidoo (Thermomix)" im Rezepte-Tab: Zustand zeigen, abgleichen und
// die Cookidoo-Einkaufsliste nach Bring schieben.

import { apiFetch, el, escHtml, flash, on, refreshRecipes, setLoading, state } from './core.js';

export function cookidooActive() {
  return Boolean(state.status?.cookidoo?.enabled);
}

export function applyCookidooMode() {
  const card = el('cookidooCard');
  if (!card) return;
  card.style.display = cookidooActive() ? '' : 'none';
  if (cookidooActive()) renderCookidooStatus();
}

async function renderCookidooStatus() {
  const target = el('cookidooStatus');
  if (!target) return;
  try {
    const s = await apiFetch('/api/cookidoo/status');
    const when = s.finishedAt ? new Date(s.finishedAt).toLocaleString('de-DE') : 'noch nicht';
    const counts =
      s.status === 'idle'
        ? ''
        : `${s.added} neu · ${s.updated} aktualisiert${
            s.missing ? ` · ${s.missing} verschwunden` : ''
          }${s.failed ? ` · ${s.failed} Fehler` : ''}`;

    target.innerHTML = `
      ${
        s.reachable === false
          ? `<div class="alert alert-error">Cookidoo-Brücke antwortet nicht: ${escHtml(
              s.error || 'unbekannter Fehler'
            )}</div>`
          : `<p class="hint">
               Angemeldet als <b>${escHtml(s.user || 'unbekannt')}</b>${
                 s.subscription
                   ? ` · Abo ${escHtml(s.subscription)}${
                       s.subscriptionActive ? '' : ' <b>(nicht aktiv)</b>'
                     }`
                   : ''
               } · Sammlungen: ${escHtml(s.kind || 'custom')}${
                 (s.only || []).length ? ` (nur ${escHtml(s.only.join(', '))})` : ''
               }
             </p>`
      }
      <p class="hint">Letzter Abgleich: ${escHtml(when)}${counts ? ` – ${counts}` : ''}</p>
      ${
        (s.collections || []).length
          ? `<p class="hint">${s.collections
              .map((c) => `${escHtml(c.name)} (${c.recipes})`)
              .join(' · ')}</p>`
          : ''
      }`;
  } catch (err) {
    target.innerHTML = `<div class="alert alert-error">Zustand nicht ladbar: ${escHtml(
      err.message
    )}</div>`;
  }
}

export function initCookidoo() {
  on('cookidooSyncBtn', 'click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    flash('cookidooResult', 'Frage bei Cookidoo nach – das kann dauern …', 'info');
    try {
      const s = await apiFetch('/api/cookidoo/sync', { method: 'POST' });
      flash(
        'cookidooResult',
        `✓ ${s.added} neu, ${s.updated} aktualisiert, ${s.total} Rezepte in den Sammlungen` +
          (s.failed ? ` – ${s.failed} konnten nicht geladen werden.` : '.')
      );
      await refreshRecipes();
      renderCookidooStatus();
    } catch (err) {
      flash('cookidooResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('cookidooShoppingPreviewBtn', 'click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await apiFetch('/api/cookidoo/shopping');
      el('cookidooResult').innerHTML = res.items.length
        ? `<div class="alert alert-info">
             <b>${res.items.length} offene Einträge</b>${
               res.recipes.length ? ` (aus: ${escHtml(res.recipes.join(', '))})` : ''
             }:<br />
             ${res.items
               .map(
                 (i) =>
                   `<span class="ingredient-tag">${escHtml(
                     i.amount ? `${i.amount} ${i.name}` : i.name
                   )}</span>`
               )
               .join('')}
           </div>`
        : '<div class="alert alert-info">Die Cookidoo-Einkaufsliste ist leer.</div>';
    } catch (err) {
      flash('cookidooResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('cookidooShoppingBtn', 'click', async (e) => {
    const listUuid = el('cookidooListSelect').value;
    if (!listUuid) return flash('cookidooResult', 'Bitte eine Bring-Liste wählen.', 'error');
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await apiFetch('/api/cookidoo/shopping', {
        method: 'POST',
        body: JSON.stringify({ listUuid }),
      });
      flash('cookidooResult', `✓ ${res.imported.length} Einträge nach Bring übertragen.`);
    } catch (err) {
      flash('cookidooResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });
}
