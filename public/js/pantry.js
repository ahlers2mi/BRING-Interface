// Karte „Vorräte": was im Haus sein SOLL, mit Zustand da / knapp / leer.
// Knappes und Leeres wandert auf Knopfdruck auf die Bring-Liste.
//
// Bewusst getrennt von der Reste-Küche: dort geht es um „was liegt gerade im
// Kühlschrank" für die Rezeptsuche, hier um den Grundstock im Schrank.

import { apiFetch, currentListUuid, el, escHtml, flash, on, setLoading } from './core.js';

const STATUS = [
  { key: 'have', label: '✅ da', title: 'Ist da' },
  { key: 'low', label: '⚠️ knapp', title: 'Wird knapp – auf die Liste' },
  { key: 'out', label: '❌ leer', title: 'Leer – auf die Liste' },
];

let items = [];

function render() {
  const box = el('pantryList');
  if (!box) return;

  if (!items.length) {
    box.className = 'hint';
    box.textContent =
      'Noch keine Vorräte eingetragen – „Grundstock anlegen" füllt Salz, Pfeffer, Mehl & Co. ein.';
    return;
  }
  box.className = 'pantry-list';
  box.innerHTML = '';

  const fehlt = items.filter((i) => i.status !== 'have').length;
  const kopf = document.createElement('div');
  kopf.className = 'hint';
  kopf.textContent = fehlt
    ? `${items.length} Vorräte, ${fehlt} davon knapp oder leer.`
    : `${items.length} Vorräte, alles da.`;
  box.appendChild(kopf);

  for (const item of items) {
    box.appendChild(buildRow(item));
  }
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = `pantry-row status-${item.status}`;
  row.innerHTML = `
    <span class="pantry-name">${escHtml(item.name)}</span>
    <span class="pantry-status">
      ${STATUS.map(
        (s) =>
          // Der gewaehlte Zustand bekommt `is-on` und seine Farbe per CSS. Alle
          // als btn-primary zu faerben waere lauter Alarm: "da" ist der
          // Normalfall, auffallen sollen knapp und leer.
          `<button class="btn btn-sm btn-secondary pantry-pick${
            item.status === s.key ? ' is-on' : ''
          }" data-status="${s.key}" title="${escHtml(s.title)}">${s.label}</button>`
      ).join('')}
    </span>
    <input type="text" class="pantry-amount" value="${escHtml(item.amount || '')}"
      placeholder="Menge" title="Menge, die auf der Bring-Liste stehen soll" />
    <button class="btn btn-danger btn-sm" data-act="del" title="Aus den Vorräten nehmen">🗑</button>
  `;

  const speichern = async (body, btn) => {
    if (btn) setLoading(btn, true);
    try {
      await apiFetch(`/api/pantry/${item.id}`, { method: 'PUT', body: JSON.stringify(body) });
      await loadPantry();
    } catch (err) {
      flash('pantryResult', `Fehler: ${escHtml(err.message)}`, 'error');
      if (btn) setLoading(btn, false);
    }
  };

  for (const btn of row.querySelectorAll('[data-status]')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.status === item.status) return; // schon so
      speichern({ status: btn.dataset.status }, btn);
    });
  }
  // Menge beim Verlassen des Feldes speichern – wie in der Listen-Karte.
  const menge = row.querySelector('.pantry-amount');
  menge.addEventListener('change', () => speichern({ amount: menge.value.trim() }));

  row.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      await apiFetch(`/api/pantry/${item.id}`, { method: 'DELETE' });
      await loadPantry();
    } catch (err) {
      flash('pantryResult', `Fehler: ${escHtml(err.message)}`, 'error');
      setLoading(e.currentTarget, false);
    }
  });
  return row;
}

// Gekauftes übernehmen. Bekommt die Bring-Listen, wie sie gerade geladen
// wurden – abgehakt wird in der Bring-App, hier kommt nur der Zustand an.
// Läuft still im Hintergrund: schlägt es fehl, ist das kein Grund, dem Nutzer
// beim Öffnen der Einkaufsliste einen Fehler hinzuwerfen.
export async function checkPantryAgainst(data) {
  if (!items.length) return; // keine Vorräte gepflegt, nichts zu prüfen
  try {
    const res = await apiFetch('/api/pantry/check', {
      method: 'POST',
      body: JSON.stringify({
        purchase: data?.purchase || [],
        recently: data?.recently || data?.recent || [],
      }),
    });
    if (!res.bought.length) return;
    items = res.items || items;
    render();
    flash('pantryResult', `✓ ${escHtml(res.message)}`, 'success');
  } catch (err) {
    console.warn('Vorräte konnten nicht abgeglichen werden:', err.message);
  }
}

export async function loadPantry() {
  try {
    const data = await apiFetch('/api/pantry');
    items = data.items || [];
    render();
  } catch (err) {
    flash('pantryResult', `Vorräte konnten nicht geladen werden: ${escHtml(err.message)}`, 'error');
  }
}

export function initPantry() {
  on('pantryAddBtn', 'click', async (e) => {
    const name = el('pantryName').value.trim();
    if (!name) return flash('pantryResult', 'Bitte einen Namen eingeben.', 'error');
    setLoading(e.currentTarget, true);
    try {
      await apiFetch('/api/pantry', {
        method: 'POST',
        body: JSON.stringify({ name, amount: el('pantryAmount').value.trim() }),
      });
      el('pantryName').value = '';
      el('pantryAmount').value = '';
      await loadPantry();
    } catch (err) {
      flash('pantryResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(e.currentTarget, false);
    }
  });

  // Mit Enter im Namensfeld genauso aufnehmen.
  on('pantryName', 'keydown', (e) => {
    if (e.key === 'Enter') el('pantryAddBtn').click();
  });

  on('pantrySeedBtn', 'click', async (e) => {
    setLoading(e.currentTarget, true);
    try {
      const res = await apiFetch('/api/pantry/seed', { method: 'POST' });
      flash(
        'pantryResult',
        res.added
          ? `✓ ${res.added} Vorräte angelegt${res.skipped ? `, ${res.skipped} waren schon da` : ''}.`
          : 'Der Grundstock steht schon vollständig drin.',
        res.added ? 'success' : 'info'
      );
      await loadPantry();
    } catch (err) {
      flash('pantryResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(e.currentTarget, false);
    }
  });

  on('pantryShopBtn', 'click', async (e) => {
    const listUuid = currentListUuid();
    if (!listUuid) {
      return flash('pantryResult', 'Bitte oben zuerst eine Bring-Liste auswählen.', 'error');
    }
    setLoading(e.currentTarget, true);
    try {
      const res = await apiFetch('/api/pantry/shopping', {
        method: 'POST',
        body: JSON.stringify({ listUuid }),
      });
      flash('pantryResult', escHtml(res.message), res.imported.length ? 'success' : 'info');
    } catch (err) {
      flash('pantryResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(e.currentTarget, false);
    }
  });

  on('pantryAllHaveBtn', 'click', async (e) => {
    const fehlt = items.filter((i) => i.status !== 'have').length;
    if (!fehlt) return flash('pantryResult', 'Steht schon alles auf „da".', 'info');
    if (!confirm(`${fehlt} Vorräte wieder auf „da" setzen?`)) return;
    setLoading(e.currentTarget, true);
    try {
      await apiFetch('/api/pantry/all', {
        method: 'POST',
        body: JSON.stringify({ status: 'have' }),
      });
      await loadPantry();
      flash('pantryResult', `✓ ${fehlt} Vorräte wieder auf „da".`);
    } catch (err) {
      flash('pantryResult', `Fehler: ${escHtml(err.message)}`, 'error');
    } finally {
      setLoading(e.currentTarget, false);
    }
  });
}
