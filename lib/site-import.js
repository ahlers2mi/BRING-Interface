// Rezepte von einer beliebigen Rezeptseite einsammeln.
//
// Gedacht für Übersichts- und Kategorieseiten von Koch-Blogs
// (gaumenfreundin.de/rezepte/hauptgerichte/, familienkost.de/rezepte.php,
// emmikochteinfach.de/tag/familien-rezepte/ …). Der Ablauf ist zweistufig:
//
//   1. Übersichtsseite holen, alle Links derselben Domain einsammeln,
//      offensichtlichen Beiwerk-Kram (Kategorien, Feeds, Bilder) wegwerfen
//   2. jede verbliebene Adresse anlesen und nur behalten, was wirklich ein
//      Rezept ist – erkennbar an schema.org-Daten auf der Seite
//
// Schritt 2 ist der Grund, warum hier nichts seitenspezifisch verdrahtet ist:
// welche Links Rezepte sind, sagt die Seite selbst. Das kostet einen Abruf je
// Kandidat, ist dafür aber gegen jedes Layout immun.
//
// Bewusst zurückhaltend: ein Abruf nach dem anderen mit Pause dazwischen, und
// harte Obergrenzen für Seiten und Kandidaten. Das hier ist ein Helfer für die
// eigene Rezeptsammlung, kein Absaugwerkzeug.

import { parseRecipeFromHtml, USER_AGENT } from './recipe-import.js';
import { fetchOrExplain } from './neterror.js';
import { realIngredients } from './normalize.js';

export const MAX_PAGES = 20;
export const MAX_CANDIDATES = 400;

// Endungen, hinter denen nie ein Rezept steckt.
const BAD_EXTENSION = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|css|js|ico|xml)$/i;

// Pfadbestandteile, die typische Blog-Nebenwege markieren. Bewusst knapp –
// aussortiert wird ohnehin erst nach dem Anlesen.
const BAD_PATH =
  /(^|\/)(wp-json|wp-admin|wp-content|wp-includes|feed|comments|author|kontakt|impressum|datenschutz|newsletter|shop|produkt|warenkorb|kasse|mein-konto|suche|search|tag|tags|kategorie|category|thema|ueber-mich|about)(\/|$)/i;

// Manche Seiten legen die Übersichten als einzelne Dateien ab, nicht als
// Verzeichnis – z. B. familienkost.de/kategorie-fleischgerichte.html. Die
// tragen dort sogar schema.org-Rezeptdaten, fallen also erst hier heraus.
const BAD_FILENAME = /^(kategorie|category|tag|thema|uebersicht|rezepte)[-_.]/i;

/** Relative Adresse -> absolute. Ungültiges ergibt null. */
export function absolutize(href, baseUrl) {
  if (!href) return null;
  const raw = String(href).trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(raw)) return null;
  try {
    const url = new URL(raw, baseUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function sameHost(a, b) {
  try {
    // www. ignorieren: viele Seiten verlinken gemischt.
    const strip = (h) => h.replace(/^www\./i, '').toLowerCase();
    return strip(new URL(a).host) === strip(new URL(b).host);
  } catch {
    return false;
  }
}

/** Alle <a href> einer Seite, absolut gemacht und ohne Dubletten. */
export function collectLinks(html, baseUrl) {
  const out = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const url = absolutize(match[1], baseUrl);
    if (url) out.add(url);
  }
  return [...out];
}

/** Kommt diese Adresse überhaupt als Rezeptseite in Frage? */
export function looksLikeCandidate(url, baseUrl) {
  if (!sameHost(url, baseUrl)) return false;
  let path;
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
    // Übersichtsseiten mit Seitenzahl sind keine Rezepte.
    if (/\/page\/\d+\/?$/i.test(path)) return false;
    if (parsed.searchParams.has('replytocom')) return false;
  } catch {
    return false;
  }
  if (path === '/' || path === '') return false;
  if (BAD_EXTENSION.test(path)) return false;
  if (BAD_PATH.test(path)) return false;
  if (BAD_FILENAME.test(path.split('/').pop() || '')) return false;
  // Die Übersichtsseite selbst nicht noch einmal.
  try {
    if (new URL(url).pathname === new URL(baseUrl).pathname) return false;
  } catch {
    /* egal */
  }
  return true;
}

/**
 * Adresse der nächsten Übersichtsseite. Erst die sauberen Wege
 * (<link rel="next">, <a rel="next">), dann die zwei verbreiteten Muster.
 */
export function nextPageUrl(html, currentUrl) {
  const relNext =
    /<link\b[^>]*\brel=["']next["'][^>]*\bhref=["']([^"']+)["']/i.exec(html) ||
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']next["']/i.exec(html) ||
    /<a\b[^>]*\brel=["'][^"']*\bnext\b[^"']*["'][^>]*\bhref=["']([^"']+)["']/i.exec(html) ||
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*\bnext\b[^"']*["']/i.exec(html);
  if (relNext) {
    const url = absolutize(relNext[1], currentUrl);
    if (url && url !== currentUrl) return url;
  }

  // WordPress: …/seite/ -> …/seite/page/2/ -> …/page/3/
  try {
    const parsed = new URL(currentUrl);
    const wp = /^(.*\/)page\/(\d+)\/?$/.exec(parsed.pathname);
    if (wp) {
      const guess = new URL(currentUrl);
      guess.pathname = `${wp[1]}page/${Number(wp[2]) + 1}/`;
      if (html.includes(guess.pathname)) return guess.toString();
      return null;
    }
    // Klassische PHP-Seiten: ?seite=2 / ?page=2
    for (const key of ['seite', 'page', 'p']) {
      if (parsed.searchParams.has(key)) {
        const guess = new URL(currentUrl);
        const next = Number(parsed.searchParams.get(key)) + 1;
        if (!Number.isFinite(next)) continue;
        guess.searchParams.set(key, String(next));
        return html.includes(`${key}=${next}`) ? guess.toString() : null;
      }
    }
    // Erste Seite einer WordPress-Übersicht ohne /page/ im Pfad
    const first = new URL(currentUrl);
    first.pathname = `${parsed.pathname.replace(/\/$/, '')}/page/2/`;
    if (html.includes(first.pathname)) return first.toString();
  } catch {
    /* dann eben keine nächste Seite */
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Übersichtsseite(n) durchgehen und die Adressen einsammeln, die als Rezept
 * in Frage kommen. Prüft NICHT, ob dort wirklich ein Rezept steht – das macht
 * `verifyRecipeUrls`, weil es je Adresse einen Abruf kostet.
 */
export async function discoverCandidates({
  url,
  maxPages = 3,
  maxCandidates = 100,
  fetchImpl = fetch,
  delayMs = 250,
  log = () => {},
}) {
  const pages = Math.max(1, Math.min(MAX_PAGES, Number(maxPages) || 1));
  const limit = Math.max(1, Math.min(MAX_CANDIDATES, Number(maxCandidates) || 100));
  const seen = new Set();
  const found = [];
  let current = url;

  for (let page = 0; page < pages && current; page += 1) {
    let html;
    try {
      html = await fetchPage(current, fetchImpl);
    } catch (err) {
      log(`Übersichtsseite ${current} nicht lesbar: ${err.message}`);
      break;
    }
    let addedHere = 0;
    for (const link of collectLinks(html, current)) {
      if (found.length >= limit) break;
      if (seen.has(link)) continue;
      seen.add(link);
      if (!looksLikeCandidate(link, url)) continue;
      found.push(link);
      addedHere += 1;
    }
    log(`Seite ${page + 1}: ${addedHere} mögliche Rezepte (gesamt ${found.length}).`);
    if (found.length >= limit) break;
    current = nextPageUrl(html, current);
    if (current) await sleep(delayMs);
  }
  return found;
}

async function fetchPage(url, fetchImpl) {
  const res = await fetchOrExplain(
    url,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(Number(process.env.IMPORT_TIMEOUT_MS || 20000)),
    },
    { fetchImpl, was: url }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Ist das ein einzelnes Rezept – oder eine Übersichtsseite, die sich als eines
 * ausgibt? Manche Seiten (familienkost.de) hängen schema.org-Rezeptdaten auch
 * an ihre Kategorieseiten; die haben dann einen Namen, aber keine Zutaten.
 * Die Zutatenliste ist deshalb das verlässlichere Merkmal als die Adresse.
 */
export function looksLikeSingleRecipe(recipe, { minIngredients = 2 } = {}) {
  if (!recipe?.name) return false;
  return realIngredients(recipe.ingredients).length >= minIngredients;
}

/**
 * Kandidaten anlesen und nur die behalten, auf denen wirklich ein Rezept
 * steht. Gibt { url, recipe } zurück – `recipe` stammt aus den
 * schema.org-Daten der Seite und dient der Vorschau; importiert wird je nach
 * Betriebsart trotzdem über Mealie.
 */
export async function verifyRecipeUrls(
  urls,
  {
    fetchImpl = fetch,
    delayMs = 250,
    limit = 50,
    minIngredients = 2,
    log = () => {},
    isCancelled = () => false,
  }
) {
  const hits = [];
  let checked = 0;
  let uebersichten = 0;
  for (const url of urls) {
    if (hits.length >= limit || isCancelled()) break;
    checked += 1;
    try {
      const html = await fetchPage(url, fetchImpl);
      const recipe = parseRecipeFromHtml(html, url);
      if (!recipe?.name) {
        // gar keine Rezeptdaten – normal, das ist der Regelfall bei Nebenwegen
      } else if (looksLikeSingleRecipe(recipe, { minIngredients })) {
        hits.push({ url, recipe });
      } else {
        uebersichten += 1;
        log(`übersprungen (sieht nach Übersicht aus, keine Zutaten): ${recipe.name}`);
      }
    } catch (err) {
      log(`${url}: ${err.message}`);
    }
    await sleep(delayMs);
  }
  log(
    `${checked} Adressen geprüft, ${hits.length} davon sind Rezepte` +
      `${uebersichten ? `, ${uebersichten} waren Übersichtsseiten` : ''}.`
  );
  return hits;
}
