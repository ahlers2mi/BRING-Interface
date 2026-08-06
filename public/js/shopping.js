// Tab "Einkaufsliste": Artikel eintippen oder per KI aus Text/Foto erkennen
// und in eine Bring-Liste schieben.

import {
  apiFetch,
  el,
  escHtml,
  flash,
  on,
  saveLastList,
  selectListEverywhere,
  setLoading,
} from './core.js';

let selectedPhoto = null;

function itemsToTextarea(items) {
  const lines = items
    .map((i) => `${(i.amount || '').trim()} ${(i.name || '').trim()}`.trim())
    .filter((l) => l.length > 0);
  el('itemsText').value = lines.join('\n');
  return lines.length;
}

// Verkleinert ein Bild clientseitig und gibt eine JPEG-Data-URL zurück.
function fileToResizedDataUrl(file, maxDim = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Bild konnte nicht geladen werden.'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export async function loadCurrentItems(listUuid) {
  const target = el('currentItems');
  if (!target) return;
  target.innerHTML = '<span class="spinner"></span>';
  try {
    const data = await apiFetch(`/api/lists/${listUuid}/items`);
    const items = data.purchase ?? [];
    if (items.length === 0) {
      target.innerHTML = '<em style="color:var(--text-muted)">Liste ist leer.</em>';
      return;
    }
    target.innerHTML = items
      .map(
        (i) =>
          `<span class="ingredient-tag">${escHtml(i.name)}${
            i.specification ? ' – ' + escHtml(i.specification) : ''
          }</span>`
      )
      .join('');
  } catch (err) {
    target.innerHTML = `<span style="color:var(--danger)">Fehler: ${escHtml(
      err.message
    )}</span>`;
  }
}

export function initShopping() {
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
