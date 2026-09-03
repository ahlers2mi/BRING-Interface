// Normalisierung und Vergleich von Zutatennamen.
//
// Ziel ist nicht linguistische Korrektheit, sondern dass "2 Zwiebeln",
// "Zwiebel" und "zwiebel, rot" als dieselbe Zutat erkannt werden. Deshalb wird
// klein geschrieben, entumlautet, Beschreibungs-Beiwerk entfernt und grob
// singularisiert. Damit deutsche Komposita ("Hähnchenbrust" ↔
// "Hähnchenbrustfilet") trotzdem greifen, gilt zusätzlich eine
// Teilwort-Regel (siehe `ingredientMatches`).

// Vorräte, die praktisch immer im Haus sind. Sie zählen bei der Reste-Suche
// nicht als fehlende Zutat und werden beim Lernen ignoriert – sonst wäre
// "Salz" die beliebteste Zutat der Sammlung.
export const PANTRY_ITEMS = [
  'salz',
  'pfeffer',
  'wasser',
  'zucker',
  'mehl',
  'öl',
  'olivenöl',
  'sonnenblumenöl',
  'rapsöl',
  'essig',
  'butter',
  'margarine',
  'milch',
  'ei',
  'eier',
  'zwiebel',
  'knoblauch',
  'senf',
  'tomatenmark',
  'brühe',
  'gemüsebrühe',
  'hühnerbrühe',
  'paprikapulver',
  'currypulver',
  'oregano',
  'thymian',
  'basilikum',
  'petersilie',
  'lorbeerblatt',
  'muskat',
  'zimt',
  'backpulver',
  'speisestärke',
  'honig',
  'sojasauce',
];

// Wörter, die nichts über die Zutat aussagen (Zustand, Herkunft, Zuschnitt).
const FILLER_WORDS = new Set(
  [
    'frisch',
    'frische',
    'frischer',
    'frisches',
    'getrocknet',
    'getrocknete',
    'getrockneter',
    'gemahlen',
    'gemahlene',
    'gemahlener',
    'gehackt',
    'gehackte',
    'gehackter',
    'gewuerfelt',
    'gewuerfelte',
    'geschnitten',
    'geschnittene',
    'gerieben',
    'geriebene',
    'geriebener',
    'gross',
    'grosse',
    'grosser',
    'klein',
    'kleine',
    'kleiner',
    'mittelgross',
    'bio',
    'tk',
    'evtl',
    'ggf',
    'optional',
    'nach',
    'belieben',
    'geschmack',
    'zum',
    'zur',
    'fuer',
    'und',
    'oder',
    'etwas',
    'wenig',
    'viel',
    'ca',
    'ein',
    'eine',
    'einen',
    'halbe',
    'halber',
    'halbes',
    'stueck',
    'stuecke',
    'scheibe',
    'scheiben',
    'prise',
    'prisen',
    'bund',
    'zehe',
    'zehen',
    'dose',
    'dosen',
    'packung',
    'packungen',
    'pck',
    'glas',
    'becher',
    'tasse',
    'esslöffel',
    'teelöffel',
    'moeglichst',
    'am',
    'besten',
    'dazu',
    'davon',
    'gut',
    'sehr',
  ].map((w) => w.replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ä/g, 'ae'))
);

// Maßeinheiten, die beim Trennen "Menge ↔ Name" als Einheit gelten.
const UNITS = [
  'g',
  'gr',
  'gramm',
  'kg',
  'mg',
  'ml',
  'cl',
  'l',
  'liter',
  'el',
  'tl',
  'msp',
  'prise',
  'prisen',
  'stück',
  'stk',
  'st',
  'dose',
  'dosen',
  'pck',
  'pckg',
  'packung',
  'packungen',
  'päckchen',
  'bund',
  'zehe',
  'zehen',
  'scheibe',
  'scheiben',
  'blatt',
  'blätter',
  'zweig',
  'zweige',
  'stange',
  'stangen',
  'tasse',
  'tassen',
  'becher',
  'glas',
  'gläser',
  'kugel',
  'kugeln',
  'tropfen',
  'handvoll',
  'cm',
  'portion',
  'portionen',
  // Nachgetragen, weil sie in echten Rezepten vorkamen und ohne sie im
  // Artikelnamen landen ("1 Schuss Balsamico" -> Artikel "Schuss Balsamico").
  'schuss',
  'spritzer',
  'hand',
  'hände',
  'msp.',
  'messerspitze',
  'messerspitzen',
  'würfel',
  'knolle',
  'knollen',
  'kopf',
  'köpfe',
  'topf',
  'beutel',
  'flasche',
  'flaschen',
  'tüte',
  'tüten',
  'rolle',
  'rollen',
  'riegel',
  'tafel',
  'tafeln',
  'ring',
  'ringe',
  'kanne',
  'schale',
  'schalen',
  'netz',
  'korb',
  'esslöffel',
  'teelöffel',
  'kilo',
  'kilogramm',
  'milliliter',
  'zentiliter',
];

const FRACTIONS = {
  '½': 0.5,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 0.25,
  '¾': 0.75,
  '⅕': 0.2,
  '⅛': 0.125,
};

export function deumlaut(str) {
  return String(str)
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue');
}

// Grobe Singularisierung: eine Endung abschneiden, wenn das Wort dadurch nicht
// zu kurz wird. Konsistenz ist wichtiger als Korrektheit – beide Schreibweisen
// sollen auf denselben Stamm fallen.
function stem(word) {
  if (word.length <= 4) return word;
  for (const suffix of ['nnen', 'en', 'er', 'es', 'se', 'n', 'e', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

// Zutatenname -> Liste von Suchbegriffen (Stämmen). Leeres Array, wenn nichts
// Verwertbares übrig bleibt.
export function ingredientKeys(name) {
  const cleaned = deumlaut(String(name || '').toLowerCase())
    .replace(/\([^)]*\)/g, ' ') // Klammerzusätze weg
    .replace(/[^a-z\s-]/g, ' ') // Zahlen und Sonderzeichen weg
    .replace(/-/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !FILLER_WORDS.has(w));

  const keys = new Set();
  for (const word of cleaned) keys.add(stem(word));
  return [...keys];
}

// Ein einzelner Vergleichsschlüssel (für Gruppierung/Statistik).
export function normalizeName(name) {
  const keys = ingredientKeys(name);
  return keys.length ? keys.join(' ') : deumlaut(String(name || '').toLowerCase().trim());
}

const PANTRY_KEYS = new Set(PANTRY_ITEMS.flatMap((item) => ingredientKeys(item)));

export function isPantryItem(name) {
  const keys = ingredientKeys(name);
  return keys.length > 0 && keys.every((k) => PANTRY_KEYS.has(k));
}

// Passen zwei Zutatenbezeichnungen zusammen? Neben gleichen Stämmen gilt die
// Teilwort-Regel für Komposita: "hahnchenbrust" ⊂ "hahnchenbrustfilet".
export function ingredientMatches(a, b) {
  const ka = ingredientKeys(a);
  const kb = ingredientKeys(b);
  if (!ka.length || !kb.length) return false;
  for (const x of ka) {
    for (const y of kb) {
      if (x === y) return true;
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      if (short.length >= 5 && long.includes(short)) return true;
    }
  }
  return false;
}

// ── Angerissene Rezepte ───────────────────────────────────────────────────────
//
// Rezepte hinter der Chefkoch-PLUS-Schranke werden importiert, geben aber nur
// einen Anriss her: ein paar Zutaten und dann ein Platzhalter
// ("-- additional ingredients not fully disclosed --"). Der ist keine Zutat –
// er darf nicht auf den Einkaufszettel, nicht in die Reste-Suche, und er darf
// ein Rezept nicht vollständig aussehen lassen.
const TEASER_MARKER =
  /(not fully disclosed|additional ingredients not|weitere zutaten|nicht vollst(ä|ae)ndig)/i;

export function isTeaserIngredient(name) {
  return TEASER_MARKER.test(String(name || ''));
}

export function realIngredients(list) {
  return (list || []).filter((ing) => ing && !isTeaserIngredient(ing.name));
}

// Nur mit geladener Zutatenliste zu beantworten – ohne sie lieber nichts sagen.
export function isIncompleteRecipe(recipe) {
  const list = recipe?.ingredients;
  if (!Array.isArray(list)) return false;
  return list.some((ing) => isTeaserIngredient(ing?.name)) || realIngredients(list).length === 0;
}

// ── Vorlauf ───────────────────────────────────────────────────────────────────
//
// Manches muss man am Vortag anfangen: Fleisch auftauen, Bohnen einweichen,
// Teig gehen lassen. Das steht bei niemandem als Feld im Rezept, aber fast
// immer im Text – danach suchen wir, statt eine Pflege zu verlangen.
const PREP_HINTS = [
  { re: /auftau|tiefgek(ü|ue)hlt|gefrorene/i, text: 'auftauen' },
  { re: /(ü|ue)ber nacht|am vortag|vortag|24 stunden/i, text: 'am Vortag ansetzen' },
  { re: /einweichen|quellen lassen/i, text: 'einweichen' },
  { re: /marinier/i, text: 'marinieren' },
  { re: /gehen lassen|hefeteig/i, text: 'Teig gehen lassen' },
];

// Rückgabe: kurzer Hinweistext oder '' – der taugt gleich als Ansage.
export function prepHint(recipe) {
  const text = [
    recipe?.name || '',
    ...(Array.isArray(recipe?.tags) ? recipe.tags : []),
    recipe?.instructions || '',
    recipe?.description || '',
  ].join(' ');
  if (!text.trim()) return '';
  const treffer = PREP_HINTS.filter((hint) => hint.re.test(text)).map((h) => h.text);
  return [...new Set(treffer)].join(', ');
}

// Bewertet ein Rezept gegen die eingegebenen Reste.
// Rückgabe: { matched, missing, coverage } – coverage 0..1 über die
// "relevanten" Zutaten (Vorräte optional ausgenommen).
// `pantryNames`: die gepflegte Vorratsliste des Haushalts (nur was auf „da"
// steht). Ohne sie greift die feste Liste `PANTRY_ITEMS` – so bleibt der Haken
// „Vorräte annehmen" auch dann sinnvoll, wenn niemand Vorräte gepflegt hat.
export function matchRecipeToFridge(
  ingredients,
  haveList,
  { assumePantry = true, pantryNames = null } = {}
) {
  const matched = [];
  const missing = [];
  let relevant = 0;

  const imVorrat = (name) =>
    Array.isArray(pantryNames)
      ? pantryNames.some((vorrat) => ingredientMatches(name, vorrat))
      : isPantryItem(name);

  for (const ing of realIngredients(ingredients)) {
    const name = ing.name || '';
    const hit = haveList.find((have) => ingredientMatches(name, have));
    if (hit) {
      matched.push({ ...ing, matchedWith: hit });
      relevant += 1;
      continue;
    }
    if (assumePantry && imVorrat(name)) continue; // gilt als vorhanden
    relevant += 1;
    missing.push(ing);
  }

  return {
    matched,
    missing,
    coverage: relevant === 0 ? 0 : matched.length / relevant,
  };
}

// "500 g Mehl" -> { amount: "500 g", name: "Mehl" }
// Erkennt Zahlen, Brüche (1/2, ½) und die üblichen Einheiten.
export function splitAmount(line) {
  const text = String(line || '').trim().replace(/\s+/g, ' ');
  if (!text) return { name: '', amount: '' };

  const unitPattern = UNITS.map((u) => u.replace(/\./g, '\\.')).join('|');
  const numberPattern = `(?:\\d+[.,]?\\d*(?:\\s*\\/\\s*\\d+)?|[${Object.keys(FRACTIONS).join(
    ''
  )}])`;
  // Die Einheit muss am Wortende aufhören: ohne das greift das `g` für Gramm
  // mitten in "Glas", das `l` in "Liter" und das `st` in "Stangen" – aus
  // "1 Glas Rotkohl" wurde "1 G" + "las Rotkohl". Der Lookahead sorgt neben der
  // Wortgrenze auch dafür, dass die laengere Einheit gewinnt ("gramm" vor "g"),
  // weil die kurze Alternative sonst am Lookahead scheitert und zurueckgesetzt
  // wird.
  const re = new RegExp(
    `^((?:${numberPattern})(?:\\s*[-–]\\s*(?:${numberPattern}))?)\\s*(?:(${unitPattern})\\.?(?=[\\s,;]|$)\\s*)?(.*)$`,
    'i'
  );

  const m = re.exec(text);
  if (!m) return { name: text, amount: '' };

  const [, num, unit, rest] = m;
  const name = (rest || '').trim();
  if (!name) return { name: text, amount: '' }; // z. B. reine Mengenangabe
  const amount = [num.trim(), (unit || '').trim()].filter(Boolean).join(' ');
  return { name, amount };
}

// Welche Artikel einer Bring-Liste gehören zu diesem Rezept? Die reine
// Rechnerei hinter dem Knopf „wieder rausnehmen" – die Bring-Aufrufe macht der
// Aufrufer.
//
// **Verglichen wird streng**, mit `normalizeName` (Stämme, also passt „Zwiebel"
// auf „Zwiebeln"), und ausdrücklich **nicht** mit `ingredientMatches`: dessen
// Teilwort-Regel würde bei „Zucker" auch „Puderzucker" von der Liste nehmen.
// Beim Zusammenlegen ist so ein Fehlgriff eine krumme Menge, beim Löschen ist
// er ein fehlendes Lebensmittel im Einkaufswagen.
//
// `items` ist Bringst Form ([{ name, specification }]), `keepNames` sind
// Artikel, die stehen bleiben müssen, obwohl sie passen (Vorräte, die wir
// selbst auf die Liste geschoben haben).
export function recipeItemsOnList(items, ingredients, { keepNames = [] } = {}) {
  const schluessel = new Map();
  for (const ing of realIngredients(ingredients)) {
    const key = normalizeName(ing.name);
    if (key && !schluessel.has(key)) schluessel.set(key, ing.name);
  }
  const behalten = new Set(keepNames.map((n) => normalizeName(n)).filter(Boolean));

  const remove = [];
  const kept = [];
  const getroffen = new Set();

  for (const item of items || []) {
    const name = String(item?.name || '').trim();
    if (!name) continue;
    const key = normalizeName(name);
    const zutat = schluessel.get(key);
    if (!zutat) continue;

    getroffen.add(key);
    const treffer = { name, amount: String(item.specification || '').trim(), ingredient: zutat };
    if (behalten.has(key)) kept.push({ ...treffer, reason: 'vorrat' });
    else remove.push(treffer);
  }

  // Was das Rezept braucht, aber nicht (mehr) auf der Liste steht. Nicht als
  // Fehler – meist ist es schon abgehakt oder war nie drauf.
  const missing = [...schluessel.entries()]
    .filter(([key]) => !getroffen.has(key))
    .map(([, name]) => name);

  return { remove, kept, missing };
}

// Welche Artikel einer Bring-Liste haben die Menge im NAMEN? Das ist die reine
// Rechnerei hinter dem Aufräumen-Knopf – die Bring-Aufrufe macht der Aufrufer.
//
// `items` ist Bringst Form: [{ name, specification }].
export function tidyItems(items) {
  const changes = [];
  for (const item of items || []) {
    const name = String(item?.name || '').trim();
    if (!name) continue;
    const geteilt = splitIngredientText(name);
    if (!geteilt.name || geteilt.name === name) continue;

    // Ein von Hand eingetragenes Mengenfeld bleibt stehen – die abgeleitete
    // Menge kommt davor, damit nichts verloren geht.
    const vorhanden = String(item.specification || '').trim();
    const amount = [geteilt.amount, vorhanden].filter(Boolean).join(' ').trim();
    changes.push({ from: name, to: geteilt.name, amount, hadSpec: Boolean(vorhanden) });
  }
  return changes;
}

// Freitext-Zutat -> { name, amount }.
//
// Quellen liefern Zutaten oft als EINE Zeichenkette ("400 g Hähnchenbrustfilet(s)").
// Mealie legt solche Zutaten in `note` ab, ohne `quantity`/`unit` – ungetrennt
// landet die Menge dann im Artikelnamen auf der Bring-Liste, und die
// Portions-Umrechnung greift gar nicht, weil die rechnet nur am `amount`-Feld.
//
// Über `splitAmount` hinaus werden hier drei Eigenheiten der Quellen geglättet:
export function splitIngredientText(text) {
  let raw = String(text || '').trim();
  if (!raw) return { name: '', amount: '' };

  // 1. Plural-Markierungen von Chefkoch & Co. Ohne das frisst die
  //    Einheiten-Erkennung bei "1 Dose/n Kokosmilch" das Wort "Dose" und lässt
  //    "/n Kokosmilch" als Artikelnamen übrig.
  raw = raw
    .replace(/\((?:n|e|en|s|innen)\)/gi, '')
    .replace(/\/(?:n|e|en|s)(?=\s|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 2. Unbestimmte Mengen ("n. B." = nach Bedarf) sind keine Menge und gehören
  //    erst recht nicht in den Namen.
  raw = raw
    .replace(
      /^(?:n\.?\s*b\.?|nach\s+bedarf|nach\s+geschmack|je\s+nach\s+geschmack|etwas|evtl\.?|ggf\.?)\s+/i,
      ''
    )
    .trim();

  let { name, amount } = splitAmount(raw);

  // 3. Krumme Zahlen lesbar machen: 0.25 -> 1/4. So schreiben es die Scraper,
  //    auf einem Einkaufszettel will das niemand lesen.
  const zahl = /^(\d+(?:[.,]\d+)?)(\s+.*)?$/.exec(amount);
  if (zahl) {
    const schoen = formatAmountNumber(Number(zahl[1].replace(',', '.')));
    if (schoen) amount = (schoen + (zahl[2] || '')).trim();
  }

  // 4. Eine Gewichtsangabe in Klammern am Ende gehört nicht in den
  //    Artikelnamen. Aus "1 Dose/n Kokosmilch (ca. 400 g)" wird der Artikel
  //    "Kokosmilch" mit der Menge "1 Dose" – die Packungseinheit gewinnt, die
  //    legt man in den Wagen. Nur wenn sonst KEINE Menge dasteht
  //    ("Kokosmilch (ca. 400 g)"), tritt das Gewicht an ihre Stelle.
  const klammer = new RegExp(
    `^(.*?)\\s*\\(\\s*(?:ca\\.?|etwa|ungef(?:ä|ae)hr|je)?\\s*(\\d+(?:[.,]\\d+)?)\\s*(${UNITS.map(
      (u) => u.replace(/\./g, '\\.')
    ).join('|')})\\s*\\)$`,
    'i'
  );
  const inKlammern = klammer.exec(name);
  if (inKlammern && inKlammern[1].trim()) {
    if (!amount) {
      const zahlInKlammer = formatAmountNumber(Number(inKlammern[2].replace(',', '.')));
      amount = `${zahlInKlammer || inKlammern[2]} ${inKlammern[3]}`;
    }
    name = inKlammern[1].trim();
  }

  // 4b. Eine Klammer VOR dem Namen ist eine Anmerkung zur Menge, kein Teil des
  //     Artikels. Regel 4 fasst nur das Ende, weil dort die Packungsangabe
  //     steht – in echten Rezepten steht sie aber auch mitten in der Zeile:
  //     "2 EL (ca. 30 g) Butter" ergab den Artikel "(ca. 30 g) Butter",
  //     "400 g (ca. 150 g roher Reis) gekochter Basmatireis" entsprechend. So
  //     etwas findet Bring in seinem Katalog nicht.
  const klammerVorn = /^\(([^)]*)\)\s*(.+)$/.exec(name);
  if (klammerVorn && klammerVorn[2].trim()) {
    name = klammerVorn[2].trim();
  }

  // 5. Größenangaben wandern zur Menge. Auf der Bring-Liste soll der Artikel
  //    "Zwiebel" heißen (das kennt Bring), nicht "kleine Zwiebel" – die Größe
  //    ist eine Angabe zur Menge, keine andere Zutat. Farb- und Sortenwörter
  //    ("rote") bleiben stehen, die bezeichnen ein anderes Produkt.
  const groesse = /^(kleine?[rs]?|grosse?[rs]?|große?[rs]?|mittelgrosse?|mittelgroße?)\s+(.+)$/i.exec(
    name
  );
  if (groesse && amount) {
    amount = `${amount} ${groesse[1].toLowerCase()}`;
    name = groesse[2];
  }

  return { name: name.trim(), amount: amount.trim() };
}

// ── Mengen zusammenrechnen ────────────────────────────────────────────────────
//
// Für den Wocheneinkauf: dasselbe Gewürz kommt in drei Rezepten vor. Vorher
// wurden die Mengen bloß aneinandergehängt – auf dem Zettel stand dann
// "½ TL + 1 TL + 1 TL Salz" und "2 + 1 Knoblauchzehen". Gleiche Einheit heißt
// aber: addieren.
//
// Umgerechnet wird nur innerhalb einer Familie und nur, wo es verlustfrei ist
// (g/kg, ml/l). TL und EL bleiben getrennt: "5⅓ EL" ist für einen Einkauf
// weniger brauchbar als "4 EL + 4 TL", und krumme Löffelzahlen sind ohnehin
// keine Kaufmenge.
const UNIT_FAMILIES = {
  g: { family: 'gewicht', factor: 1 },
  gr: { family: 'gewicht', factor: 1 },
  gramm: { family: 'gewicht', factor: 1 },
  kg: { family: 'gewicht', factor: 1000 },
  kilo: { family: 'gewicht', factor: 1000 },
  kilogramm: { family: 'gewicht', factor: 1000 },
  ml: { family: 'volumen', factor: 1 },
  milliliter: { family: 'volumen', factor: 1 },
  cl: { family: 'volumen', factor: 10 },
  zentiliter: { family: 'volumen', factor: 10 },
  l: { family: 'volumen', factor: 1000 },
  liter: { family: 'volumen', factor: 1000 },
  // Ausgeschrieben ist dieselbe Einheit.
  esslöffel: { family: 'el', factor: 1 },
  teelöffel: { family: 'tl', factor: 1 },
};

// Einheit -> Familienschlüssel für zählbare Einheiten. Ohne das wären "2 Dosen"
// und "1 Dose" zwei verschiedene Dinge geblieben. Kurze Einheiten (g, ml, EL …)
// bleiben unangetastet, die stehen ohnehin in UNIT_FAMILIES.
function unitStem(unit) {
  const u = unit.toLowerCase();
  if (u.length < 4) return u;
  for (const suffix of ['en', 'n', 'e', 's']) {
    if (u.endsWith(suffix) && u.length - suffix.length >= 3) {
      return u.slice(0, u.length - suffix.length);
    }
  }
  return u;
}

// "2 EL" -> { value: 2, unit: 'EL' }. `null`, wenn nach Zahl und Einheit noch
// etwas übrig bleibt ("1 kleine", "2 EL (ca. 30 g)", "2-3") – solche Angaben
// werden nicht verrechnet, sondern unverändert stehen gelassen.
export function parseAmount(text) {
  const roh = String(text || '').trim().replace(/\s+/g, ' ');
  if (!roh) return null;

  const unitPattern = UNITS.map((u) => u.replace(/\./g, '\\.')).join('|');
  const re = new RegExp(
    `^(\\d+(?:[.,]\\d+)?(?:\\s*\\/\\s*\\d+)?|[${Object.keys(FRACTIONS).join('')}])` +
      `\\s*(${unitPattern})?\\.?$`,
    'i'
  );
  const m = re.exec(roh);
  if (!m) return null;

  const zahl = m[1];
  let value;
  if (FRACTIONS[zahl] !== undefined) {
    value = FRACTIONS[zahl];
  } else if (zahl.includes('/')) {
    const [oben, unten] = zahl.split('/').map((s) => Number(s.trim().replace(',', '.')));
    value = unten ? oben / unten : NaN;
  } else {
    value = Number(zahl.replace(',', '.'));
  }
  if (!Number.isFinite(value)) return null;

  return { value, unit: (m[2] || '').trim() };
}

// Liste von Mengen -> eine Zeichenkette. Was sich addieren lässt, wird addiert;
// der Rest bleibt mit " + " dahinter stehen. Die Einheit der ERSTEN Angabe
// gewinnt (1 kg + 500 g -> "1,5 kg", umgekehrt "1500 g").
export function mergeAmounts(amounts) {
  const gruppen = [];

  for (const roh of amounts || []) {
    const text = String(roh || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;

    const teil = parseAmount(text);
    if (!teil) {
      gruppen.push({ text });
      continue;
    }
    const familie = UNIT_FAMILIES[teil.unit.toLowerCase()] || {
      family: unitStem(teil.unit),
      factor: 1,
    };
    const treffer = gruppen.find((g) => g.family === familie.family);
    if (treffer) {
      treffer.summe += teil.value * familie.factor;
      // Mehrzahl merken: "1 Zehe + 2 Zehen" soll "3 Zehen" ergeben, nicht
      // "3 Zehe". Zwei Bedingungen, beide notwendig:
      //   - dasselbe Wort, nur laenger ("Dose" -> "Dosen"). Ohne das wuerde aus
      //     "2 EL + 1 Esslöffel" die Einheit "Esslöffel".
      //   - kein Umrechnungsfaktor im Spiel. Sonst wuerde aus "500 g + 1 kg"
      //     die Angabe "1500 kg" – die Summe steht in Gramm.
      const laenger = teil.unit.toLowerCase();
      const bisher = treffer.unit.toLowerCase();
      if (
        familie.factor === treffer.factor &&
        laenger.length > bisher.length &&
        laenger.startsWith(bisher)
      ) {
        treffer.mehrzahl = teil.unit;
      }
    } else {
      gruppen.push({
        family: familie.family,
        unit: teil.unit,
        factor: familie.factor,
        summe: teil.value * familie.factor,
      });
    }
  }

  return gruppen
    .map((g) => {
      if (g.text !== undefined) return g.text;
      const wert = g.summe / g.factor;
      const zahl = formatAmountNumber(wert);
      const einheit = wert > 1 && g.mehrzahl ? g.mehrzahl : g.unit;
      return [zahl, einheit].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(' + ');
}

// Zahl fürs Anzeigen aufbereiten: 0.5 -> "1/2", 2 -> "2", 1.5 -> "1,5"
export function formatAmountNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (Math.abs(num - 0.5) < 1e-9) return '1/2';
  if (Math.abs(num - 0.25) < 1e-9) return '1/4';
  if (Math.abs(num - 0.75) < 1e-9) return '3/4';
  if (Number.isInteger(num)) return String(num);
  return String(Number(num.toFixed(2))).replace('.', ',');
}
