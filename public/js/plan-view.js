// Wandtablet-Ansicht des Wochenplans.
//
// Läuft absichtlich ohne die Module der Hauptseite: eigene, kleine Logik, kein
// Login-Sprung (ein Tablet soll nicht plötzlich auf der Anmeldeseite stehen),
// und der Zugang geht über ?token=… in der Adresse – so kann die Seite auch in
// FHEM als Rahmen (iframe) hängen.

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const REFRESH_MS = 60 * 1000;

let week = 'current';
let view = null;

const el = (id) => document.getElementById(id);

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { 'X-API-Token': TOKEN } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error(
      TOKEN
        ? 'Zugang abgelehnt – stimmt der Token in der Adresse?'
        : 'Kein Zugang – Adresse mit ?token=… aufrufen.'
    );
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function say(html, cls = 'info') {
  el('message').innerHTML = `<span class="${cls}">${html}</span>`;
  clearTimeout(say.timer);
  if (cls !== 'err') {
    say.timer = setTimeout(() => {
      el('message').innerHTML = '';
    }, 8000);
  }
}

// Bilder laufen über unseren Server; der Token muss mit in die Adresse, weil
// <img> keine Header schickt.
function imageUrl(recipe, size) {
  if (!recipe?.image_url) return '';
  const url = recipe.image_url;
  if (!url.startsWith('/')) return url; // externe Adresse (z. B. Chefkoch)
  const params = new URLSearchParams();
  if (size) params.set('size', size);
  if (TOKEN) params.set('token', TOKEN);
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}

const stars = (value) => {
  const n = Math.round(Number(value) || 0);
  return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
};

const deDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.` : String(iso || '');
};

const RATINGS = [
  { key: 'lecker', icon: '😋', title: 'Lecker (5)' },
  { key: 'gut', icon: '🙂', title: 'Gut (4)' },
  { key: 'ok', icon: '😐', title: 'Ging so (3)' },
  { key: 'schlecht', icon: '👎', title: 'Hat nicht geschmeckt (1)' },
  { key: 'rausgeflogen', icon: '🗑', title: 'Gar nicht gekocht' },
];

function ratingRow(day, cls) {
  const done = day.rating
    ? day.rating.kind === 'rejected'
      ? 'rausgeflogen'
      : { 5: 'lecker', 4: 'gut', 3: 'ok', 2: 'schlecht', 1: 'schlecht' }[day.rating.stars]
    : null;
  return RATINGS.map(
    (r) =>
      `<button class="${cls}${done === r.key ? ' done' : ''}" data-rate="${r.key}" ` +
      `data-date="${day.date}" title="${esc(r.title)}">${r.icon}</button>`
  ).join('');
}

// ── Zeichnen ──────────────────────────────────────────────────────────────────

function render() {
  el('weekLabel').textContent = `KW ${view.week.slice(-2)} · ${deDate(view.from)} – ${deDate(
    view.to
  )}`;

  // Held der Seite: heute, sonst der erste Tag der angezeigten Woche.
  const hero = view.days.find((d) => d.isToday) || view.days[0];
  const recipe = hero.recipe;

  el('heroDay').textContent = hero.isToday
    ? 'Heute'
    : `${hero.label}, ${deDate(hero.date)}`;
  el('heroName').textContent = recipe ? recipe.name : 'Nichts geplant';

  const img = el('heroImage');
  const src = imageUrl(recipe, 'original');
  img.style.backgroundImage = src ? `url("${src}")` : '';
  img.classList.toggle('empty', !src);

  const meta = [];
  if (recipe?.prep_time) meta.push(`⏱ ${esc(recipe.prep_time)}`);
  if (recipe?.rating_count) {
    meta.push(
      `<span class="stars">${stars(recipe.avg_stars)}</span> ${Number(
        recipe.avg_stars
      ).toFixed(1)}`
    );
  } else if (recipe) {
    meta.push('noch nicht bewertet');
  }
  if (hero.status === 'cooked') meta.push('✓ gekocht');
  if (hero.status === 'skipped') meta.push('🗑 nicht gekocht');
  el('heroMeta').innerHTML = meta.join('<span class="sep">·</span>');

  el('heroRate').innerHTML = recipe ? ratingRow(hero, 'rate') : '';

  const link = el('heroLink');
  if (recipe?.source_url) {
    link.href = recipe.source_url;
    link.style.display = '';
  } else {
    link.style.display = 'none';
  }
  el('rollTodayBtn').dataset.date = hero.date;
  el('rollTodayBtn').textContent = hero.isToday
    ? '🎲 Heute neu würfeln'
    : `🎲 ${hero.label} neu würfeln`;

  // Die anderen Tage
  el('days').innerHTML = view.days
    .filter((d) => d.date !== hero.date)
    .map((day) => {
      const r = day.recipe;
      const thumb = imageUrl(r);
      const badge =
        day.status === 'cooked'
          ? '<span class="badge cooked">✓ gekocht</span>'
          : day.status === 'skipped'
            ? '<span class="badge skipped">🗑 nicht gekocht</span>'
            : '';
      return `
        <article class="day${day.isToday ? ' today' : ''}${
          day.status === 'cooked' ? ' cooked' : ''
        }">
          <div class="day-img${thumb ? '' : ' empty'}" ${
            thumb ? `style="background-image:url('${thumb}')"` : ''
          }></div>
          <div class="day-body">
            <div class="day-head">
              <span class="day-name">${esc(day.label)}</span>
              <span class="day-date">${deDate(day.date)}</span>
            </div>
            <div class="dish${r ? '' : ' empty'}">${
              r ? esc(r.name) : '– nichts geplant –'
            }</div>
            <div class="day-meta">
              ${badge}
              ${
                r?.rating_count
                  ? `<span class="stars">${stars(r.avg_stars)}</span>`
                  : r
                    ? 'neu'
                    : ''
              }
              ${r?.prep_time ? ` · ⏱ ${esc(r.prep_time)}` : ''}
            </div>
          </div>
          <div class="day-actions">
            <button class="mini" data-roll="${day.date}" title="Für diesen Tag würfeln">🎲</button>
            ${r ? ratingRow(day, 'mini') : ''}
          </div>
        </article>`;
    })
    .join('');

  wire();
}

function wire() {
  document.querySelectorAll('[data-rate]').forEach((btn) => {
    btn.addEventListener('click', () => rate(btn.dataset.date, btn.dataset.rate, btn));
  });
  document.querySelectorAll('[data-roll]').forEach((btn) => {
    btn.addEventListener('click', () => roll({ date: btn.dataset.roll }, btn));
  });
}

function busy(btn, on) {
  if (!btn) return;
  if (on) {
    btn.dataset.text = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.text || btn.innerHTML;
    btn.disabled = false;
  }
}

// ── Aktionen ──────────────────────────────────────────────────────────────────

async function load(target = week) {
  try {
    view = await api(`/api/plan?week=${encodeURIComponent(target)}`);
    week = view.week;
    render();
  } catch (err) {
    say(esc(err.message), 'err');
  }
}

async function roll(body, btn) {
  busy(btn, true);
  try {
    const res = await api('/api/plan/roll', { method: 'POST', body: { week, ...body } });
    view = res.plan;
    render();
    const failed = (res.results || []).find((r) => r.error);
    if (failed) say(esc(failed.error), 'err');
    else say('🎲 gewürfelt.', 'ok');
  } catch (err) {
    say(esc(err.message), 'err');
    busy(btn, false);
  }
}

async function rate(date, rating, btn) {
  busy(btn, true);
  try {
    const res = await api(`/api/plan/${date}/rate`, { method: 'POST', body: { rating } });
    view = res.plan;
    render();
    say('Danke, notiert.', 'ok');
  } catch (err) {
    say(esc(err.message), 'err');
    busy(btn, false);
  }
}

function shiftWeek(delta) {
  // Der Server rechnet die Kalenderwoche aus einem Datum – Montag ± 7 Tage.
  const monday = new Date(`${view.from}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + delta * 7);
  return monday.toISOString().slice(0, 10);
}

// ── Start ─────────────────────────────────────────────────────────────────────

function tick() {
  el('clock').textContent = new Date().toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

el('prevBtn').addEventListener('click', () => load(shiftWeek(-1)));
el('nextBtn').addEventListener('click', () => load(shiftWeek(1)));
el('todayBtn').addEventListener('click', () => load('current'));
el('rollTodayBtn').addEventListener('click', (e) =>
  roll({ date: e.currentTarget.dataset.date }, e.currentTarget)
);
el('rollWeekBtn').addEventListener('click', (e) => roll({}, e.currentTarget));
el('rollEmptyBtn').addEventListener('click', (e) => roll({ onlyEmpty: true }, e.currentTarget));

el('shoppingBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  busy(btn, true);
  try {
    // Nimmt die zuletzt benutzte Bring-Liste (wie der FHEM-Weg).
    const res = await api(`/api/fhem/shopping?week=${encodeURIComponent(week)}`, {
      method: 'POST',
    });
    say(`🛒 ${res.imported} Zutaten in Bring.`, 'ok');
  } catch (err) {
    say(esc(err.message), 'err');
  } finally {
    busy(btn, false);
  }
});

tick();
setInterval(tick, 10000);
load('current');
// Regelmäßig nachladen, damit das Tablet nicht auf gestern stehen bleibt.
setInterval(() => load(week), REFRESH_MS);
