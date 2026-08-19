// Tab "Einkaufsliste": Artikel eintippen oder per KI aus Text/Foto erkennen
// und in eine Bring-Liste schieben.

import {
  apiFetch,
  el,
  escHtml,
  fileToResizedDataUrl,
  flash,
  on,
  saveLastList,
  selectListEverywhere,
  setLoading,
} from './core.js';
import { checkPantryAgainst } from './pantry.js';

let selectedPhoto = null;

function itemsToTextarea(items) {
  const lines = items
    .map((i) => `${(i.amount || '').trim()} ${(i.name || '').trim()}`.trim())
    .filter((l) => l.length > 0);
  el('itemsText').value = lines.join('\n');
  return lines.length;
}

let currentListUuid = null;

// Eine Zeile der Liste: abhaken, Menge ändern, löschen.
function buildItemRow(item) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <button class="btn btn-secondary btn-sm" data-act="done" title="Abhaken">✓</button>
    <span class="item-name">${escHtml(item.name)}</span>
    <input type="text" class="item-amount" value="${escHtml(item.specification || '')}"
      placeholder="Menge" />
    <button class="btn btn-danger btn-sm" data-act="del" title="Von der Liste nehmen">🗑</button>
  `;

  const call = async (btn, path, options) => {
    setLoading(btn, true);
    try {
      await apiFetch(path, options);
      await loadCurrentItems(currentListUuid);
    } catch (err) {
      flash('itemsResult', `Fehler: ${escHtml(err.message)}`, 'error');
      setLoading(btn, false);
    }
  };

  const name = encodeURIComponent(item.name);
  row.querySelector('[data-act="done"]').addEventListener('click', (e) =>
    call(e.currentTarget, `/api/lists/${currentListUuid}/items/${name}/done`, { method: 'POST' })
  );
  row.querySelector('[data-act="del"]').addEventListener('click', (e) =>
    call(e.currentTarget, `/api/lists/${currentListUuid}/items/${name}`, { method: 'DELETE' })
  );

  // Menge: speichern beim Verlassen des Feldes, aber nur wenn sie sich geändert
  // hat – sonst schickt jedes Antippen eine Anfrage an Bring.
  const amount = row.querySelector('.item-amount');
  const before = amount.value;
  const save = async () => {
    if (amount.value === before) return;
    amount.disabled = true;
    try {
      await apiFetch(`/api/lists/${currentListUuid}/items`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ name: item.name, amount: amount.value.trim() }] }),
      });
      flash('itemsResult', `✓ ${escHtml(item.name)}: Menge gespeichert.`);
      await loadCurrentItems(currentListUuid);
    } catch (err) {
      flash('itemsResult', `Fehler: ${escHtml(err.message)}`, 'error');
      amount.disabled = false;
    }
  };
  amount.addEventListener('blur', save);
  amount.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') amount.blur();
  });

  return row;
}

export async function loadCurrentItems(listUuid) {
  const target = el('currentItems');
  if (!target) return;
  currentListUuid = listUuid;
  target.innerHTML = '<span class="spinner"></span>';
  try {
    const data = await apiFetch(`/api/lists/${listUuid}/items`);
    const items = data.purchase ?? [];
    target.innerHTML = '';
    if (items.length === 0) {
      target.innerHTML = '<em style="color:var(--text-muted)">Liste ist leer.</em>';
    } else {
      for (const item of items) target.appendChild(buildItemRow(item));
    }

    // Vorräte: was von der Liste verschwunden und unter „zuletzt gekauft"
    // aufgetaucht ist, ist eingekauft. Abgehakt wird in der Bring-App, deshalb
    // merkt es die App nur so. Die Listen sind hier schon geladen – mitschicken
    // statt einen zweiten Bring-Aufruf machen.
    checkPantryAgainst(data);

    // „Zuletzt gekauft": ein Tipp setzt den Artikel wieder auf die Liste.
    const recent = (data.recently ?? data.recent ?? []).slice(0, 40);
    const box = el('recentBox');
    const recentEl = el('recentItems');
    if (box && recentEl) {
      box.style.display = recent.length ? '' : 'none';
      recentEl.innerHTML = '';
      for (const item of recent) {
        const chip = document.createElement('button');
        chip.className = 'ingredient-tag is-clickable';
        chip.textContent = item.name;
        chip.addEventListener('click', async () => {
          chip.disabled = true;
          try {
            await apiFetch(`/api/lists/${listUuid}/items`, {
              method: 'POST',
              body: JSON.stringify({ items: [{ name: item.name, amount: item.specification || '' }] }),
            });
            await loadCurrentItems(listUuid);
          } catch (err) {
            flash('itemsResult', `Fehler: ${escHtml(err.message)}`, 'error');
            chip.disabled = false;
          }
        });
        recentEl.appendChild(chip);
      }
    }
  } catch (err) {
    target.innerHTML = `<span style="color:var(--danger)">Fehler: ${escHtml(
      err.message
    )}</span>`;
  }
}

export function initShopping() {
  // Alte Artikel aufräumen: bei denen steckt die Menge im Namen, weil der
  // Rezept-Import sie früher ungetrennt auf die Liste geschrieben hat. Erst
  // zeigen, dann fragen – die Liste sieht die ganze Familie.
  on('tidyItemsBtn', 'click', async (e) => {
    const btn = e.currentTarget;
    if (!currentListUuid) {
      return flash('itemsResult', 'Bitte zuerst eine Liste auswählen.', 'error');
    }
    setLoading(btn, true);
    try {
      const probe = await apiFetch(`/api/lists/${currentListUuid}/tidy`, {
        method: 'POST',
        body: JSON.stringify({ dryRun: true }),
      });
      if (!probe.changes.length) {
        flash('itemsResult', `Nichts zu tun – alle ${probe.checked} Artikel sind sauber.`, 'info');
        return;
      }
      const liste = probe.changes
        .map((c) => `• ${c.from}  →  ${c.to}${c.amount ? `  (${c.amount})` : ''}`)
        .join('\n');
      if (!confirm(`${probe.changes.length} von ${probe.checked} Artikeln ändern?\n\n${liste}`)) {
        flash('itemsResult', 'Abgebrochen – nichts geändert.', 'info');
        return;
      }
      const res = await apiFetch(`/api/lists/${currentListUuid}/tidy`, {
        method: 'POST',
        body: JSON.stringify({ dryRun: false }),
      });
      flash(
        'itemsResult',
        `✓ ${res.changed} Artikel aufgeräumt` +
          (res.failed.length ? `, ${res.failed.length} nicht geklappt` : '') +
          '.',
        res.changed ? 'success' : 'info'
      );
      await loadCurrentItems(currentListUuid);
    } catch (err) {
      flash('itemsResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('addItemBtn', 'click', async (e) => {
    const listUuid = el('listSelect').value;
    if (!listUuid) return flash('itemsResult', 'Bitte zuerst eine Bring-Liste auswählen.', 'error');
    const name = el('newItemName').value.trim();
    if (!name) return flash('itemsResult', 'Bitte einen Artikel eingeben.', 'error');
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      await apiFetch(`/api/lists/${listUuid}/items`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ name, amount: el('newItemAmount').value.trim() }] }),
      });
      el('newItemName').value = '';
      el('newItemAmount').value = '';
      flash('itemsResult', `✓ ${escHtml(name)} steht auf der Liste.`);
      await loadCurrentItems(listUuid);
    } catch (err) {
      flash('itemsResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('newItemName', 'keydown', (e) => {
    if (e.key === 'Enter') el('addItemBtn').click();
  });
  on('newItemAmount', 'keydown', (e) => {
    if (e.key === 'Enter') el('addItemBtn').click();
  });

  on('importBtn', 'click', async () => {
    const btn = el('importBtn');
    const resultEl = el('importResult');
    const listUuid = el('listSelect').value;
    const text = el('itemsText').value.trim();

    if (!listUuid) return flash(resultEl, 'Bitte zuerst eine Bring-Liste auswählen.', 'error');
    if (!text) return flash(resultEl, 'Bitte mindestens einen Artikel eingeben.', 'error');

    setLoading(btn, true);
    try {
      const result = await apiFetch(`/api/lists/${listUuid}/items`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      flash(
        resultEl,
        `✓ ${result.imported.length} Artikel importiert: ${escHtml(
          result.imported.join(', ')
        )}`
      );
      await loadCurrentItems(listUuid);
    } catch (err) {
      flash(resultEl, `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('clearBtn', 'click', () => {
    el('itemsText').value = '';
    el('importResult').innerHTML = '';
  });

  on('analyzeTextBtn', 'click', async () => {
    const btn = el('analyzeTextBtn');
    const resultEl = el('analyzeItemsResult');
    const text = el('itemsText').value.trim();
    if (!text) return flash(resultEl, 'Bitte zuerst Text eingeben.', 'error');

    setLoading(btn, true);
    try {
      const { items } = await apiFetch('/api/items/analyze', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      const n = itemsToTextarea(items);
      flash(resultEl, `✓ ${n} Artikel erkannt. Bitte oben prüfen und importieren.`);
    } catch (err) {
      flash(resultEl, `Fehler bei der Analyse: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('photoInput', 'change', (e) => {
    selectedPhoto = e.target.files[0] || null;
    el('photoName').textContent = selectedPhoto ? `Gewählt: ${selectedPhoto.name}` : '';
    el('analyzePhotoBtn').disabled = !selectedPhoto;
  });

  on('analyzePhotoBtn', 'click', async () => {
    const btn = el('analyzePhotoBtn');
    const resultEl = el('analyzeItemsResult');
    if (!selectedPhoto) return flash(resultEl, 'Bitte zuerst ein Bild wählen.', 'error');

    setLoading(btn, true);
    try {
      const image = await fileToResizedDataUrl(selectedPhoto);
      const { items } = await apiFetch('/api/items/analyze', {
        method: 'POST',
        body: JSON.stringify({ image }),
      });
      const n = itemsToTextarea(items);
      flash(resultEl, `✓ ${n} Artikel im Bild erkannt. Bitte oben prüfen und importieren.`);
    } catch (err) {
      flash(resultEl, `Fehler bei der Analyse: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  on('listSelect', 'change', async (e) => {
    if (e.target.value) {
      selectListEverywhere(e.target.value);
      await loadCurrentItems(e.target.value);
      saveLastList(e.target.value);
    } else {
      el('currentItems').innerHTML =
        'Wähle eine Liste aus, um die aktuellen Artikel anzuzeigen.';
    }
  });
}
