// Rezepte aus Kochvideos (YouTube).
//
// Ein Video hat kein schema.org-Recipe, der übliche Importer läuft dort also
// ins Leere. Zu holen ist aber trotzdem eine Menge:
//
//   1. Titel, Kanal, Dauer und das Vorschaubild – steckt im `ytInitialPlayerResponse`
//      der Watch-Seite.
//   2. Die **Videobeschreibung**. Bei Kochkanälen steht das Rezept dort fast
//      immer komplett drin, oft mit Zutatenliste in eigenen Zeilen.
//   3. Falls die Beschreibung nichts hergibt: die **Untertitel**. Die Adressen
//      der Spuren stehen ebenfalls im Player-Response; automatische Spuren
//      (`kind: 'asr'`) sind der letzte Rückfall.
//
// Aus dem so gesammelten Text macht entweder die KI-Analyse (server.js) oder
// – ohne API-Schlüssel – `recipeFromText()` hier ein Rezept.
//
// Alle Parser sind reine Funktionen und ohne Netz testbar; die einzige Funktion
// mit Netzzugriff (`fetchVideoSource`) nimmt `fetchImpl` als Parameter.

import { splitAmount } from './normalize.js';
import { decodeEntities, formatMinutes, stripHtml, USER_AGENT } from './recipe-import.js';

const TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS || 20000);

// Sprachen für die Untertitelwahl, beste zuerst.
const CAPTION_LANGS = ['de', 'en'];

// ── Adressen ──────────────────────────────────────────────────────────────────

// Alle YouTube-Schreibweisen auf die Video-Kennung bringen. Robust gegen den
// Anhang aus der Teilen-Funktion (`?si=…`, `&t=42`) – und gegen das `?is=`,
// das beim Kopieren von Hand daraus wird.
export function youtubeId(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return /^[\w-]{11}$/.test(text) ? text : '';
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  const valid = (id) => (/^[\w-]{11}$/.test(id || '') ? id : '');

  if (host === 'youtu.be') return valid(parsed.pathname.slice(1).split('/')[0]);
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return '';
  if (parsed.pathname === '/watch') return valid(parsed.searchParams.get('v'));
  const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(parsed.pathname);
  return m ? valid(m[1]) : '';
}

export function isVideoUrl(url) {
  return Boolean(youtubeId(url));
}

export function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

// `maxresdefault` gibt es nicht bei jedem Video, `hqdefault` immer.
export function thumbnailUrls(id) {
  return [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ];
}

// ── Watch-Seite auseinandernehmen ─────────────────────────────────────────────

// Ein JSON-Objekt hinter einem Marker aus einer Seite schneiden. Klammern
// zählen statt Regex: der Player-Response enthält selbst geschweifte Klammern
// in Zeichenketten, ein `/\{.*\}/` läuft da hoffnungslos daneben.
export function sliceJsonObject(text, marker) {
  const at = String(text).indexOf(marker);
  if (at < 0) return null;
  const start = String(text).indexOf('{', at + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Watch-Seite -> { title, author, description, minutes, thumbnail, captionTracks }
export function parseWatchPage(html) {
  const page = String(html || '');
  const player =
    sliceJsonObject(page, 'ytInitialPlayerResponse =') ||
    sliceJsonObject(page, 'ytInitialPlayerResponse":') ||
    {};
  const details = player.videoDetails || {};

  // Rückfall, wenn YouTube das Feld umbenennt: die Beschreibung steht auch als
  // einzelne Zeichenkette im Seitenquelltext.
  let description = typeof details.shortDescription === 'string' ? details.shortDescription : '';
  if (!description) {
    const m = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(page);
    if (m) {
      try {
        description = JSON.parse(`"${m[1]}"`);
      } catch {
        description = '';
      }
    }
  }

  const seconds = Number(details.lengthSeconds || 0);
  const thumbs = Array.isArray(details.thumbnail?.thumbnails)
    ? [...details.thumbnail.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))
    : [];

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return {
    id: String(details.videoId || ''),
    title: decodeEntities(String(details.title || '')).trim(),
    author: decodeEntities(String(details.author || '')).trim(),
    description: description.replace(/\r\n/g, '\n').trim(),
    minutes: seconds > 0 ? Math.round(seconds / 60) : null,
    thumbnail: thumbs[0]?.url || '',
    captionTracks: tracks
      .filter((t) => t && t.baseUrl)
      .map((t) => ({
        url: String(t.baseUrl),
        lang: String(t.languageCode || '').toLowerCase(),
        auto: t.kind === 'asr',
        label: String(t.name?.simpleText || t.name?.runs?.[0]?.text || ''),
      })),
  };
}

// Beste Untertitelspur: erst Sprache (de, dann en, dann was da ist), innerhalb
// einer Sprache lieber die selbst geschriebene als die automatische.
export function pickCaptionTrack(tracks, langs = CAPTION_LANGS) {
  const list = (tracks || []).filter((t) => t && t.url);
  if (!list.length) return null;
  const rank = (t) => {
    const langIndex = langs.findIndex((l) => t.lang === l || t.lang.startsWith(`${l}-`));
    return (langIndex < 0 ? langs.length : langIndex) * 2 + (t.auto ? 1 : 0);
  };
  return [...list].sort((a, b) => rank(a) - rank(b))[0];
}

// Untertitel -> Fließtext. YouTube liefert je nach `fmt` XML oder json3.
export function parseCaptions(body) {
  const text = String(body || '').trim();
  if (!text) return '';

  if (text.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return '';
    }
    const parts = (data.events || [])
      .flatMap((e) => (e.segs || []).map((s) => s.utf8 || ''))
      .join('');
    return tidyCaptions(parts);
  }

  // YouTube maskiert im XML **doppelt** (`&amp;#39;` für ein Apostroph),
  // deshalb nach dem stripHtml noch einmal dekodieren.
  const lines = [...text.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)].map((m) =>
    decodeEntities(stripHtml(m[1]))
  );
  return tidyCaptions(lines.join(' '));
}

function tidyCaptions(text) {
  return String(text)
    .replace(/\[[^\]]{0,30}\]/g, ' ') // [Musik], [Applaus]
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Beschreibung -> Rezept (ohne KI) ──────────────────────────────────────────

// Zeilen, die in Videobeschreibungen unter dem Rezept stehen und nichts damit
// zu tun haben. Ab der ersten solchen Zeile hört das Rezept auf.
const CUTOFF = [
  /^\s*(abonnier|abonnier?t|folge|folgt|mehr von|meine|unsere)\b.*\b(kanal|instagram|tiktok|facebook)/i,
  /^\s*(instagram|tiktok|facebook|website|webseite|blog|shop|amazon|werbung|anzeige|affiliate)\s*[:\-–]/i,
  /^\s*(kapitel|timestamps|zeitstempel|inhalt)\s*[:\-–]?\s*$/i,
  /^\s*\*+\s*(werbung|anzeige)/i,
  // Reine Hashtag-Zeile. `[^\s#]` statt `\w`, sonst rutscht „#frühstück"
  // durch – `\w` kennt keine Umlaute.
  /^\s*#[^\s#]+(\s+#[^\s#]+)*\s*$/,
  // „Speicher dir das @familienkost Rezept" & Co. – ab einer Erwähnung ist es
  // Eigenwerbung, nicht mehr Zubereitung.
  /(?:^|\s)@[A-Za-z0-9_.]{2,}/,
  /^\s*\d{1,2}:\d{2}\s+\S/, // Kapitelmarken "00:45 Teig"
  /https?:\/\/\S+\s*$/i,
];

// Eine Zeile sieht nach Zutat aus, wenn sie mit einer Menge beginnt und danach
// noch ein Name kommt. Absichtlich streng: sonst wird jeder Zubereitungssatz
// mit "2 Minuten" zur Zutat.
export function looksLikeIngredientLine(line) {
  const text = String(line || '')
    .replace(/^[-–•*▪️✔️☑️\s]+/, '')
    .trim();
  if (!text || text.length > 80) return false;
  if (/[.!?]\s/.test(text)) return false; // ganze Sätze sind keine Zutat
  const { amount, name } = splitAmount(text);
  if (!amount || !name) return false;
  if (!/[a-zA-ZäöüÄÖÜß]{3}/.test(name)) return false;

  // „20 Minuten bei 200 Grad backen" fängt genauso mit einer Zahl an wie
  // „500 g Gnocchi". Zwei Unterschiede, die reichen:
  //
  // Zeit und Temperatur gehören zur Zubereitung. Geprüft wird die Rohzeile,
  // **nicht** das Ergebnis von `splitAmount`: das hält bei „200 Grad" das „G"
  // für Gramm und lässt „rad Umluft vorheizen" übrig.
  if (/^\d+\s*(°|grad|min\.?|minuten?|std\.?|stunden?|sek\.?|sekunden?)\b/i.test(text)) {
    return false;
  }
  const words = name.split(/\s+/).length;
  if (words > 6) return false; // Zutatennamen sind kurz
  if (/\.$/.test(text) && words > 3) return false; // Satzpunkt am Ende
  return true;
}

// Text (Beschreibung oder Untertitel) -> Rezept im Format dieser App.
// Findet nur etwas, wenn wirklich eine Zutatenliste in eigenen Zeilen steht –
// aus Fließtext raten wir bewusst nicht, dafür ist die KI-Analyse da.
export function recipeFromText(text, { name = '', minutes = null } = {}) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');

  const body = [];
  for (const line of lines) {
    if (CUTOFF.some((re) => re.test(line))) break;
    body.push(line);
  }

  const ingredients = [];
  const steps = [];
  let seenIngredient = false;
  for (const line of body) {
    const clean = line.replace(/^[-–•*▪️✔️\s]+/, '').trim();
    if (!clean) continue;
    if (looksLikeIngredientLine(line)) {
      seenIngredient = true;
      const { amount, name: ingName } = splitAmount(clean);
      ingredients.push({ name: ingName, amount });
      continue;
    }
    // Überschriften wie "Zutaten:" oder "Zubereitung:" nicht in die Anleitung.
    if (/^(zutaten|ingredients|zubereitung|anleitung|so geht'?s)\s*:?\s*$/i.test(clean)) continue;
    if (seenIngredient) steps.push(clean);
  }

  if (ingredients.length < 2) return null;

  return {
    name: name || '',
    description: '',
    ingredients,
    instructions: steps.join('\n'),
    prep_time: minutes ? formatMinutes(minutes) : '',
  };
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
  if (!res.ok) throw new Error(`Video nicht abrufbar (HTTP ${res.status}).`);
  return res.text();
}

// Alles zusammentragen, was das Video hergibt. `text` ist der Rohtext für die
// weitere Auswertung, `used` sagt woher er kommt ('beschreibung'|'untertitel').
export async function fetchVideoSource(url, { fetchImpl = fetch, withCaptions = true } = {}) {
  const id = youtubeId(url);
  if (!id) throw new Error('Das ist keine YouTube-Adresse.');

  const page = await getText(watchUrl(id), fetchImpl);
  const info = parseWatchPage(page);
  if (!info.title) {
    throw new Error(
      'YouTube hat die Videodaten nicht mitgeliefert (Altersfreigabe, ' +
        'Zustimmungsseite oder Sperre). Beschreibung von Hand kopieren und die ' +
        'KI-Analyse benutzen.'
    );
  }

  // Beschreibung zuerst: kurz, sauber gegliedert, oft mit Zutatenliste.
  const description = info.description;
  const hasList = description
    .split('\n')
    .filter((l) => looksLikeIngredientLine(l)).length >= 2;

  let transcript = '';
  if (withCaptions && !hasList) {
    const track = pickCaptionTrack(info.captionTracks);
    if (track) {
      try {
        const sep = track.url.includes('?') ? '&' : '?';
        transcript = parseCaptions(await getText(`${track.url}${sep}fmt=json3`, fetchImpl));
      } catch {
        transcript = ''; // Untertitel sind ein Bonus, kein Muss
      }
    }
  }

  const text = hasList || !transcript ? description : `${description}\n\n${transcript}`.trim();
  return {
    platform: 'youtube',
    id,
    url: watchUrl(id),
    title: info.title,
    author: info.author,
    minutes: info.minutes,
    image: info.thumbnail || thumbnailUrls(id)[1],
    description,
    transcript,
    text,
    used: hasList ? 'beschreibung' : transcript ? 'untertitel' : 'beschreibung',
  };
}

// Die Grunddaten (Name, Quelle, Bild, Tags) baut `socialRecipeBase()` in
// `social-import.js` – dort liegt auch der Instagram-Weg, und die Felder sollen
// für beide Quellen dieselben sein.

// Videotitel sind auf Klicks getrimmt. Den Lärm abziehen, den Namen behalten.
export function cleanVideoTitle(title) {
  let text = String(title || '').trim();
  text = text.replace(/\s*[|｜]\s*[^|｜]{0,40}$/u, ''); // "… | Rezept von XY"
  text = text.replace(
    /\s*[-–]\s*(so einfach|ganz einfach|schnell und einfach|in \d+ minuten|das beste rezept|rezept)\s*!?\s*$/i,
    ''
  );
  text = text.replace(/\s*\((?:rezept|thermomix|schnell|einfach)[^)]*\)\s*$/i, '');
  text = text.replace(/[!?]{2,}\s*$/, '');
  text = text.replace(/\s*(?:#\w+\s*)+$/u, '');
  return text.trim() || String(title || '').trim();
}
