// Rezepte aus Beiträgen sozialer Netze (Instagram) – und die gemeinsame
// Einfahrt für alles, was kein schema.org-Recipe hat.
//
// Warum eigener Weg: Mealies `recipe-scrapers` liest bei Instagram nur die
// **Meta-Daten** der Seite, und Instagram kürzt die Bildunterschrift dort mitten
// im Satz („… Zutaten für 4 Portionen 150"). Genau ab dort fängt die
// Zutatenliste an – herausgekommen ist deshalb ein Rezept mit Titel und
// Beschreibung, aber „Could not detect ingredients".
//
// Die **vollständige** Bildunterschrift liefert die Einbettungs-Seite
// (`/embed/captioned/`). Die braucht keine Anmeldung und ist der einzige stabile
// öffentliche Weg; die Watch-Seite selbst zeigt Rechenzentren eine Anmeldewand.
//
// Alle Parser sind reine Funktionen; die Netzfunktion nimmt `fetchImpl`.

import { decodeEntities, stripHtml, USER_AGENT } from './recipe-import.js';
import {
  cleanVideoTitle,
  fetchVideoSource,
  isVideoUrl,
  looksLikeIngredientLine,
  youtubeId,
} from './video-import.js';

const TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS || 20000);

// ── Adressen ──────────────────────────────────────────────────────────────────

// Kurzcode eines Beitrags: /reel/<code>/, /p/<code>/, /tv/<code>/.
// Der Anhang aus dem Teilen-Menü (`?igsh=…`) darf dranbleiben.
export function instagramCode(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return '';
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (!/(^|\.)instagram\.com$/.test(host)) return '';
  const m = /^\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/.exec(parsed.pathname);
  return m ? m[1] : '';
}

export function isInstagramUrl(url) {
  return Boolean(instagramCode(url));
}

export function instagramUrl(code) {
  return `https://www.instagram.com/reel/${code}/`;
}

export function instagramEmbedUrl(code) {
  return `https://www.instagram.com/reel/${code}/embed/captioned/`;
}

// ── Einbettungs-Seite auseinandernehmen ───────────────────────────────────────

function jsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return '';
  }
}

function metaContent(html, key) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`,
    'i'
  );
  const m = re.exec(html) || null;
  if (m) return decodeEntities(m[1]);
  // Manche Seiten schreiben content vor property.
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
    'i'
  );
  const m2 = re2.exec(html);
  return m2 ? decodeEntities(m2[1]) : '';
}

// Einbettungs-Seite -> { caption, author, image }
// Drei Quellen, absteigend nach Vollständigkeit – die Meta-Daten sind
// ausdrücklich die letzte Wahl, weil Instagram sie kürzt.
export function parseInstagramEmbed(html) {
  const page = String(html || '');

  // 1. Das JSON, das die Einbettung mitliefert.
  let caption = '';
  const json = /"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"((?:[^"\\]|\\.)*)"/.exec(
    page
  );
  if (json) caption = jsonString(json[1]);
  if (!caption) {
    const flach = /"caption":"((?:[^"\\]|\\.)*)"/.exec(page);
    if (flach) caption = jsonString(flach[1]);
  }

  // 2. Der Text im Markup der Einbettung. Von `class="Caption"` bis zum
  //    Geschwister-Block `CaptionComments` – der Benutzername steht als
  //    eigener Link davor und fliegt raus.
  if (!caption) {
    const block = /class=["']Caption["'][^>]*>([\s\S]*?)<div[^>]+class=["']CaptionComments/i.exec(
      page
    );
    const roh = block ? block[1] : /class=["']Caption["'][^>]*>([\s\S]*?)<\/div>/i.exec(page)?.[1];
    if (roh) {
      caption = stripHtml(
        String(roh).replace(/<a[^>]+class=["']CaptionUsername["'][\s\S]*?<\/a>/i, '')
      );
    }
  }

  // 3. Notnagel: die (gekürzten) Meta-Daten.
  const ogDescription = metaContent(page, 'og:description');
  if (!caption) caption = ogDescription;

  const ogTitle = metaContent(page, 'og:title');
  const owner = /"owner":\{[^}]*"username":"([^"]+)"/.exec(page)?.[1] || '';
  const userLink = /class=["']CaptionUsername["'][^>]*>([^<]+)</i.exec(page)?.[1] || '';

  return {
    caption: String(caption || '')
      .replace(/\r\n/g, '\n')
      .trim(),
    author: (owner || userLink || instagramAuthorFromTitle(ogTitle)).trim(),
    image: metaContent(page, 'og:image'),
  };
}

// og:title ist „Jenny Böhme on Instagram: "…"" – davor steht der Name.
export function instagramAuthorFromTitle(title) {
  const m = /^(.*?)\s+on\s+Instagram/i.exec(String(title || ''));
  return m ? m[1].trim() : '';
}

// Emoji und Deko wegnehmen, ohne Umlaute anzufassen.
function stripDeco(text) {
  return String(text)
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu,
      ' '
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Ein Rezeptname aus der Bildunterschrift. Die erste Zeile ist bei Kochkanälen
// der Aufhänger („Cremiges Bircher Müsli über Nacht – in 15 Minuten
// vorbereitet! 🥣 Du suchst …"), daraus wird der Name vor dem ersten
// Satzzeichen und vor einem angehängten Untertitel.
export function titleFromCaption(caption, fallback = '') {
  const erste = String(caption || '')
    .split('\n')
    .map((l) => stripDeco(l))
    .find((l) => l.length >= 3);
  if (!erste) return cleanVideoTitle(fallback);

  let name = erste
    .replace(/[!?].*$/s, '') // alles ab dem ersten Ausruf/Frage weg
    .replace(/\s+[–—]\s+.*$/s, '') // angehaengter Untertitel
    .replace(/^\s*(rezept|recipe)\s*[:\-–]\s*/i, '')
    .replace(/\s*(?:#\S+\s*)+$/u, '')
    .replace(/[\s.,:;-]+$/, '')
    .trim();

  // Nur ein Wort oder ein Roman? Dann lieber die Rohzeile knapp halten.
  if (name.split(/\s+/).length < 2 || name.length > 70) {
    name = erste.slice(0, 70).replace(/\s+\S*$/, '').trim();
  }
  return name || cleanVideoTitle(fallback);
}

// „Zutaten für 4 Portionen" -> „4 Portionen"
export function servingsFromText(text) {
  const m = /f(?:ü|ue)r\s+(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s*(port|person|glas|gl(?:ä|ae)ser|st(?:ü|ue)ck)/i.exec(
    String(text || '')
  );
  if (!m) return '';
  const wort = /port/i.test(m[2])
    ? 'Portionen'
    : /person/i.test(m[2])
      ? 'Personen'
      : /gl/i.test(m[2])
        ? 'Gläser'
        : 'Stück';
  return `${m[1]} ${wort}`;
}

// ── Netz ──────────────────────────────────────────────────────────────────────

async function getText(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.6',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Instagram-Beitrag nicht abrufbar (HTTP ${res.status}).`);
  return res.text();
}

// Gleiche Form wie `fetchVideoSource`, damit der Aufrufer nicht unterscheiden
// muss: { id, url, title, author, image, description, text, used }
export async function fetchInstagramSource(url, { fetchImpl = fetch } = {}) {
  const code = instagramCode(url);
  if (!code) throw new Error('Das ist keine Instagram-Adresse.');

  const page = await getText(instagramEmbedUrl(code), fetchImpl);
  const info = parseInstagramEmbed(page);
  if (!info.caption) {
    throw new Error(
      'Instagram hat den Beitragstext nicht mitgeliefert (Anmeldewand oder ' +
        'gelöschter Beitrag). Text von Hand kopieren und die KI-Analyse benutzen.'
    );
  }

  return {
    platform: 'instagram',
    id: code,
    url: instagramUrl(code),
    title: titleFromCaption(info.caption),
    author: info.author,
    minutes: null,
    image: info.image,
    description: info.caption,
    transcript: '',
    text: info.caption,
    servings: servingsFromText(info.caption),
    used: 'Instagram-Text',
  };
}

// ── Gemeinsame Einfahrt ───────────────────────────────────────────────────────

export function isSocialUrl(url) {
  return isVideoUrl(url) || isInstagramUrl(url);
}

// Schlüssel für die Dublettenprüfung: die Kennung des Beitrags, nicht die
// Adresse. Bei Instagram unterscheiden sich /reel/ und /p/ derselben Sache.
export function socialKey(url) {
  return youtubeId(url) || instagramCode(url) || '';
}

export function fetchSocialSource(url, opts = {}) {
  if (isInstagramUrl(url)) return fetchInstagramSource(url, opts);
  return fetchVideoSource(url, opts);
}

// Grunddaten aus dem Beitrag, unabhängig davon, wer den Text auswertet.
// **Keine Zeit aus der Videolänge**: ein 12-Minuten-Video ist kein
// 12-Minuten-Gericht und würde das Zeitlimit beim Würfeln verfälschen.
export function socialRecipeBase(source) {
  const platform = source?.platform === 'instagram' ? 'Instagram' : 'Video';
  return {
    name:
      source?.platform === 'instagram'
        ? source.title
        : cleanVideoTitle(source?.title),
    source_url: source?.url,
    image_url: source?.image,
    ...(source?.servings ? { servings: source.servings } : {}),
    tags: [platform, source?.author].filter(Boolean),
  };
}

export { looksLikeIngredientLine };
