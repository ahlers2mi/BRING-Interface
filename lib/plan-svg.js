// Wochenplan als Bild (SVG) – für Dashboards, die keine Webseite einbetten
// können, aber Bilder anzeigen (z. B. FHEMVIZ mit `vizWidget image` bzw.
// `weblink image`).
//
// Wichtig: das SVG muss **in sich geschlossen** sein. In einem <img> lädt ein
// SVG keine externen Bilder nach, deshalb werden die Fotos als data:-URI
// eingebettet (siehe `collectImages` in server.js).

const W = 900;
const H = 560;

const COLORS = {
  bg: '#0f1115',
  panel: '#171a21',
  panel2: '#1e222b',
  line: '#2a2f3a',
  text: '#e8eaef',
  muted: '#99a1b3',
  accent: '#f97316',
  good: '#22c55e',
};

export function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Einfacher Umbruch: SVG kann das nicht selbst. Breite je Zeichen grob
// geschätzt (0.55 × Schriftgröße reicht für die üblichen Rezeptnamen).
export function wrapText(text, { fontSize, maxWidth, maxLines = 2 }) {
  const perChar = fontSize * 0.55;
  const maxChars = Math.max(6, Math.floor(maxWidth / perChar));
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);

  // Läuft der Text über, letzte Zeile kürzen statt abzuschneiden.
  if (lines.length === maxLines) {
    const used = lines.join(' ').split(/\s+/).length;
    if (used < words.length) {
      const last = lines[maxLines - 1];
      lines[maxLines - 1] =
        last.length > maxChars - 1 ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
    }
  }
  return lines.length ? lines : ['–'];
}

const stars = (value) => {
  const n = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
};

const deDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.` : String(iso || '');
};

function image(href, x, y, w, h, clipId) {
  if (!href) return '';
  return (
    `<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/></clipPath>` +
    `<image href="${escapeXml(href)}" x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
  );
}

function placeholder(x, y, w, h, label = '🍽') {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${COLORS.panel2}"/>` +
    `<text x="${x + w / 2}" y="${y + h / 2 + 12}" text-anchor="middle" font-size="34" ` +
    `fill="${COLORS.muted}" opacity="0.45">${label}</text>`
  );
}

// `view`: Rückgabe von buildWeekView, `images`: Map recipeId -> data:-URI
export function renderPlanSvg(view, images = new Map()) {
  const hero = view.days.find((d) => d.isToday) || view.days[0];
  const others = view.days.filter((d) => d.date !== hero.date);
  const parts = [];

  parts.push(`<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`);

  // Kopfzeile
  parts.push(
    `<text x="24" y="34" font-size="13" letter-spacing="3" fill="${COLORS.muted}">WOCHENPLAN</text>`,
    `<text x="${W - 24}" y="34" text-anchor="end" font-size="15" fill="${COLORS.muted}">` +
      `KW ${escapeXml(view.week.slice(-2))} · ${deDate(view.from)} – ${deDate(view.to)}</text>`
  );

  // Heute
  const heroY = 52;
  const heroH = 216;
  parts.push(
    `<rect x="16" y="${heroY}" width="${W - 32}" height="${heroH}" rx="16" ` +
      `fill="${COLORS.panel}" stroke="${COLORS.line}"/>`
  );
  const img = hero.recipe ? images.get(hero.recipe.id) : null;
  parts.push(
    img
      ? image(img, 32, heroY + 16, 264, heroH - 32, 'heroClip')
      : placeholder(32, heroY + 16, 264, heroH - 32)
  );

  const textX = 320;
  parts.push(
    `<text x="${textX}" y="${heroY + 40}" font-size="13" letter-spacing="3" fill="${
      COLORS.accent
    }">${hero.isToday ? 'HEUTE' : escapeXml(hero.label.toUpperCase())}</text>`
  );

  const titleLines = wrapText(hero.recipe ? hero.recipe.name : 'Nichts geplant', {
    fontSize: 34,
    maxWidth: W - textX - 40,
    maxLines: 2,
  });
  titleLines.forEach((line, i) => {
    parts.push(
      `<text x="${textX}" y="${heroY + 84 + i * 40}" font-size="34" font-weight="600" ` +
        `fill="${COLORS.text}">${escapeXml(line)}</text>`
    );
  });

  const metaY = heroY + 84 + titleLines.length * 40 + 6;
  const meta = [];
  if (hero.recipe?.prep_time) meta.push(hero.recipe.prep_time);
  if (hero.recipe?.servings) meta.push(hero.recipe.servings);
  if (hero.status === 'cooked') meta.push('✓ gekocht');
  if (meta.length) {
    parts.push(
      `<text x="${textX}" y="${metaY}" font-size="16" fill="${COLORS.muted}">${escapeXml(
        meta.join('  ·  ')
      )}</text>`
    );
  }
  if (hero.recipe?.rating_count) {
    parts.push(
      `<text x="${textX}" y="${metaY + 28}" font-size="18" fill="${COLORS.accent}">${stars(
        hero.recipe.avg_stars
      )} <tspan fill="${COLORS.muted}" font-size="15">${Number(
        hero.recipe.avg_stars
      ).toFixed(1)}</tspan></text>`
    );
  } else if (hero.recipe) {
    parts.push(
      `<text x="${textX}" y="${metaY + 28}" font-size="15" fill="${
        COLORS.muted
      }">noch nicht bewertet</text>`
    );
  }

  // Die anderen Tage: 3 Spalten × 2 Reihen
  const cols = 3;
  const gap = 14;
  const cardW = (W - 32 - gap * (cols - 1)) / cols;
  const cardH = 118;
  const gridY = heroY + heroH + 16;

  others.forEach((day, i) => {
    const x = 16 + (i % cols) * (cardW + gap);
    const y = gridY + Math.floor(i / cols) * (cardH + gap);
    parts.push(
      `<rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="12" ` +
        `fill="${COLORS.panel}" stroke="${day.isToday ? COLORS.accent : COLORS.line}"/>`
    );

    const thumb = day.recipe ? images.get(day.recipe.id) : null;
    parts.push(
      thumb
        ? image(thumb, x + 10, y + 10, 78, cardH - 20, `thumb${i}`)
        : placeholder(x + 10, y + 10, 78, cardH - 20, '＋')
    );

    const tx = x + 100;
    parts.push(
      `<text x="${tx}" y="${y + 28}" font-size="14" font-weight="600" fill="${
        COLORS.text
      }">${escapeXml(day.label)}</text>`,
      `<text x="${x + cardW - 12}" y="${y + 28}" text-anchor="end" font-size="12" ` +
        `fill="${COLORS.muted}">${deDate(day.date)}</text>`
    );

    const lines = wrapText(day.recipe ? day.recipe.name : '– nichts geplant –', {
      fontSize: 15,
      maxWidth: cardW - 112,
      maxLines: 3,
    });
    lines.forEach((line, li) => {
      parts.push(
        `<text x="${tx}" y="${y + 52 + li * 20}" font-size="15" fill="${
          day.recipe ? COLORS.text : COLORS.muted
        }">${escapeXml(line)}</text>`
      );
    });

    if (day.status === 'cooked') {
      parts.push(
        `<text x="${tx}" y="${y + cardH - 12}" font-size="12" fill="${
          COLORS.good
        }">✓ gekocht</text>`
      );
    } else if (day.recipe?.rating_count) {
      parts.push(
        `<text x="${tx}" y="${y + cardH - 12}" font-size="13" fill="${COLORS.accent}">${stars(
          day.recipe.avg_stars
        )}</text>`
      );
    }
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif">` +
    parts.join('') +
    '</svg>'
  );
}

export const SVG_SIZE = { width: W, height: H };
