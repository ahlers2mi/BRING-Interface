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
export function matchRecipeToFridge(ingredients, haveList, { assumePantry = true } = {}) {
  const matched = [];
  const missing = [];
  let relevant = 0;

  for (const ing of realIngredients(ingredients)) {
    const name = ing.name || '';
    const hit = haveList.find((have) => ingredientMatches(name, have));
    if (hit) {
      matched.push({ ...ing, matchedWith: hit });
      relevant += 1;
      continue;
    }
    if (assumePantry && isPantryItem(name)) continue; // gilt als vorhanden
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
