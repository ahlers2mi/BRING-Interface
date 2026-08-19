import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanVideoTitle,
  fetchVideoSource,
  isVideoUrl,
  looksLikeIngredientLine,
  parseCaptions,
  parseWatchPage,
  pickCaptionTrack,
  recipeFromText,
  sliceJsonObject,
  thumbnailUrls,
  youtubeId,
} from '../lib/video-import.js';

// ── Adressen ──────────────────────────────────────────────────────────────────

test('youtubeId kennt alle Schreibweisen', () => {
  const id = 'smWgIBFuVRU';
  assert.equal(youtubeId(`https://youtu.be/${id}`), id);
  // So kommt es aus dem Teilen-Menü – und so, wenn beim Abtippen aus dem
  // "si" ein "is" wird.
  assert.equal(youtubeId(`https://youtu.be/${id}?si=u2Opfb20Jf_uPqVb`), id);
  assert.equal(youtubeId(`https://youtu.be/${id}?is=u2Opfb20Jf_uPqVb`), id);
  assert.equal(youtubeId(`https://www.youtube.com/watch?v=${id}&t=42s`), id);
  assert.equal(youtubeId(`https://m.youtube.com/watch?v=${id}`), id);
  assert.equal(youtubeId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(youtubeId(`https://www.youtube.com/embed/${id}`), id);
  assert.equal(youtubeId(`https://www.youtube-nocookie.com/embed/${id}`), id);

  assert.equal(youtubeId('https://www.chefkoch.de/rezepte/123/Nudeln.html'), '');
  assert.equal(youtubeId('https://www.youtube.com/@meinkanal'), '');
  assert.equal(youtubeId('https://youtu.be/zu-kurz'), '');
  assert.equal(youtubeId(''), '');
  assert.equal(isVideoUrl(`https://youtu.be/${id}`), true);
  assert.equal(isVideoUrl('https://blog.example/rezept/'), false);
});

test('thumbnailUrls liefert Reihenfolge gross vor sicher', () => {
  const [gross, sicher] = thumbnailUrls('abcdefghijk');
  assert.match(gross, /maxresdefault/);
  assert.match(sicher, /hqdefault/);
});

test('cleanVideoTitle nimmt den Klick-Laerm weg', () => {
  assert.equal(cleanVideoTitle('Gnocchi-Auflauf | Rezept von Emmi'), 'Gnocchi-Auflauf');
  assert.equal(cleanVideoTitle('Bester Kartoffelsalat - so einfach!'), 'Bester Kartoffelsalat');
  assert.equal(cleanVideoTitle('Linsensuppe (Thermomix TM6)'), 'Linsensuppe');
  assert.equal(cleanVideoTitle('Ofengemuese #vegan #schnell'), 'Ofengemuese');
  // Ein Titel ohne Laerm bleibt unangetastet, und leer wird nie daraus.
  assert.equal(cleanVideoTitle('Chili con Carne'), 'Chili con Carne');
  assert.equal(cleanVideoTitle('| nur Laerm'), '| nur Laerm');
});

// ── Watch-Seite ───────────────────────────────────────────────────────────────

test('sliceJsonObject zaehlt Klammern statt zu raten', () => {
  const html = `var x = {"a":"} kein Ende {","b":{"c":1}}; var y = 2;`;
  assert.deepEqual(sliceJsonObject(html, 'var x ='), { a: '} kein Ende {', b: { c: 1 } });
  assert.equal(sliceJsonObject(html, 'gibt es nicht'), null);
  assert.equal(sliceJsonObject('var x = {kaputt', 'var x ='), null);
});

const BESCHREIBUNG = [
  'Mein liebster Gnocchi-Auflauf.',
  '',
  'Zutaten:',
  '500 g Gnocchi',
  '250 g Kirschtomaten',
  '1 Kugel Mozzarella',
  '2 EL Olivenoel',
  '',
  'Zubereitung:',
  'Alles in eine Form geben und mischen.',
  '20 Minuten bei 200 Grad backen.',
  '',
  'Instagram: @meinkanal',
  'Werbung: Die Form gibt es hier https://shop.example/form',
].join('\n');

function watchPage({ description = BESCHREIBUNG, tracks = [] } = {}) {
  const player = {
    videoDetails: {
      videoId: 'smWgIBFuVRU',
      title: 'Gnocchi-Auflauf | Rezept von Emmi',
      author: 'Emmi kocht einfach',
      lengthSeconds: '512',
      shortDescription: description,
      thumbnail: {
        thumbnails: [
          { url: 'https://i.ytimg.com/vi/smWgIBFuVRU/hqdefault.jpg', width: 480 },
          { url: 'https://i.ytimg.com/vi/smWgIBFuVRU/maxresdefault.jpg', width: 1280 },
        ],
      },
    },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  };
  return `<!doctype html><html><body><script>var ytInitialPlayerResponse = ${JSON.stringify(
    player
  )};</script></body></html>`;
}

test('parseWatchPage holt Titel, Kanal, Bild und Beschreibung', () => {
  const info = parseWatchPage(watchPage());
  assert.equal(info.id, 'smWgIBFuVRU');
  assert.equal(info.title, 'Gnocchi-Auflauf | Rezept von Emmi');
  assert.equal(info.author, 'Emmi kocht einfach');
  assert.equal(info.minutes, 9); // 512 s
  assert.match(info.thumbnail, /maxresdefault/, 'groesstes Bild zuerst');
  assert.match(info.description, /500 g Gnocchi/);
});

test('parseWatchPage findet die Beschreibung auch ohne Player-Response', () => {
  // Notfallweg: YouGube liefert die Seite, aber nicht das erwartete Objekt.
  const html = `<html><body><script>ytcfg.set({"x":1});
    var other = {"shortDescription":"200 g Mehl\\n2 Eier\\nVerruehren."};</script></body></html>`;
  const info = parseWatchPage(html);
  assert.match(info.description, /200 g Mehl/);
  assert.equal(info.title, '', 'ohne Titel wird der Aufrufer den Fehler melden');
});

test('pickCaptionTrack nimmt Deutsch und lieber die echte Spur', () => {
  const tracks = [
    { url: 'a', lang: 'en', auto: false },
    { url: 'b', lang: 'de', auto: true },
    { url: 'c', lang: 'de', auto: false },
  ];
  assert.equal(pickCaptionTrack(tracks).url, 'c');
  assert.equal(pickCaptionTrack([tracks[0], tracks[1]]).url, 'b', 'de-auto vor en');
  assert.equal(pickCaptionTrack([{ url: 'x', lang: 'fr', auto: true }]).url, 'x');
  assert.equal(pickCaptionTrack([]), null);
});

test('parseCaptions liest json3 und XML', () => {
  const json3 = JSON.stringify({
    events: [
      { segs: [{ utf8: 'Wir nehmen ' }, { utf8: '500 g Gnocchi' }] },
      { segs: [{ utf8: ' und backen.' }] },
    ],
  });
  assert.equal(parseCaptions(json3), 'Wir nehmen 500 g Gnocchi und backen.');

  // YouTube maskiert im XML doppelt: aus einem Apostroph wird &amp;#39;.
  const xml =
    '<?xml version="1.0"?><transcript>' +
    '<text start="0" dur="2">[Musik]</text>' +
    '<text start="2" dur="3">so geht&amp;#39;s: 500 g Gnocchi</text>' +
    '</transcript>';
  assert.equal(parseCaptions(xml), "so geht's: 500 g Gnocchi");
  assert.equal(parseCaptions(''), '');
  assert.equal(parseCaptions('{kaputt'), '');
});

// ── Text -> Rezept ────────────────────────────────────────────────────────────

test('looksLikeIngredientLine ist streng genug', () => {
  assert.equal(looksLikeIngredientLine('500 g Gnocchi'), true);
  assert.equal(looksLikeIngredientLine('- 1 Kugel Mozzarella'), true);
  assert.equal(looksLikeIngredientLine('• 2 EL Olivenoel'), true);
  assert.equal(looksLikeIngredientLine('2 Eier'), true, 'Menge ohne Einheit');
  // Kurze Zutatennamen: mit einer 3-Buchstaben-Regel fiel die Öl-Zeile jeder
  // Liste durch.
  assert.equal(looksLikeIngredientLine('2 EL Öl'), true);
  assert.equal(looksLikeIngredientLine('- 3 Ei'), true);
  assert.equal(looksLikeIngredientLine('300 g Mehl (Type 405)'), true);

  // Zubereitungssaetze fangen genauso mit einer Zahl an.
  assert.equal(looksLikeIngredientLine('20 Minuten bei 200 Grad backen. Danach ruhen.'), false);
  assert.equal(looksLikeIngredientLine('20 Minuten bei 200 Grad backen.'), false);
  assert.equal(looksLikeIngredientLine('20 Minuten in den Ofen'), false);
  assert.equal(looksLikeIngredientLine('200 Grad Umluft vorheizen'), false);
  assert.equal(looksLikeIngredientLine('Zutaten:'), false);
  assert.equal(looksLikeIngredientLine('Alles mischen'), false);
  assert.equal(looksLikeIngredientLine(''), false);
});

test('recipeFromText liest die Zutatenliste aus einer Videobeschreibung', () => {
  const rezept = recipeFromText(BESCHREIBUNG, { name: 'Gnocchi-Auflauf' });
  assert.ok(rezept, 'Rezept erkannt');
  assert.deepEqual(
    rezept.ingredients.map((i) => `${i.amount} ${i.name}`),
    ['500 g Gnocchi', '250 g Kirschtomaten', '1 Kugel Mozzarella', '2 EL Olivenoel']
  );
  assert.match(rezept.instructions, /Alles in eine Form/);
  assert.match(rezept.instructions, /20 Minuten bei 200 Grad/);
  // Alles unterhalb der Eigenwerbung fliegt raus.
  assert.doesNotMatch(rezept.instructions, /Instagram|shop\.example/);
  // "Zutaten:"/"Zubereitung:" sind Ueberschriften, keine Arbeitsschritte.
  assert.doesNotMatch(rezept.instructions, /^Zutaten/m);
  // Die Videolaenge ist keine Kochzeit.
  assert.equal(rezept.prep_time, '');
});

test('recipeFromText schneidet Eigenwerbung aus einer Instagram-Bildunterschrift', () => {
  const caption = [
    'Zutaten für 4 Portionen',
    '150 g Haferflocken',
    '400 g Joghurt',
    '',
    'Zubereitung',
    'Alles verruehren und kuehl stellen.',
    '',
    'Speicher dir das @familienkost Rezept fuers naechste Meal-Prep!',
    '#frühstück #mealprep',
  ].join('\n');

  const rezept = recipeFromText(caption, { name: 'Bircher' });
  assert.equal(rezept.ingredients.length, 2);
  assert.equal(rezept.instructions, 'Alles verruehren und kuehl stellen.');
  // Beides hat vorher in der Zubereitung gestanden: die Erwaehnung, weil keine
  // Regel darauf passte, und die Hashtag-Zeile, weil \w kein "ü" kennt.
  assert.doesNotMatch(rezept.instructions, /familienkost/);
  assert.doesNotMatch(rezept.instructions, /frühstück|mealprep/);
});

test('recipeFromText gibt auf, wenn keine Liste da ist', () => {
  assert.equal(recipeFromText('Heute machen wir Nudeln. Das schmeckt gut.'), null);
  assert.equal(recipeFromText('500 g Gnocchi'), null, 'eine Zutat ist keine Liste');
  assert.equal(recipeFromText(''), null);
});

// ── Zusammenspiel mit dem Netz (gefaelschtes fetch) ───────────────────────────

function fakeYoutube(pages) {
  return async (url) => {
    const href = String(url);
    for (const [muster, body] of Object.entries(pages)) {
      if (href.includes(muster)) {
        return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
      }
    }
    return new Response('weg', { status: 404 });
  };
}

test('fetchVideoSource nimmt die Beschreibung, wenn eine Liste drinsteht', async () => {
  const fetchImpl = fakeYoutube({ '/watch': watchPage() });
  const source = await fetchVideoSource('https://youtu.be/smWgIBFuVRU?si=abc', { fetchImpl });

  assert.equal(source.id, 'smWgIBFuVRU');
  assert.equal(source.url, 'https://www.youtube.com/watch?v=smWgIBFuVRU');
  assert.equal(source.used, 'beschreibung');
  assert.equal(source.transcript, '', 'Untertitel gar nicht erst geholt');
  assert.match(source.text, /500 g Gnocchi/);
  assert.match(source.image, /maxresdefault/);
});

test('fetchVideoSource holt die Untertitel, wenn die Beschreibung nichts hergibt', async () => {
  const seite = watchPage({
    description: 'Heute wird gekocht. Zutaten im Video!',
    tracks: [
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=de', languageCode: 'de' },
    ],
  });
  const fetchImpl = fakeYoutube({
    '/watch': seite,
    '/api/timedtext': JSON.stringify({
      events: [{ segs: [{ utf8: 'Wir brauchen 500 g Gnocchi und 1 Kugel Mozzarella.' }] }],
    }),
  });

  const source = await fetchVideoSource('https://youtu.be/smWgIBFuVRU', { fetchImpl });
  assert.equal(source.used, 'untertitel');
  assert.match(source.text, /Zutaten im Video/, 'Beschreibung bleibt dabei');
  assert.match(source.text, /500 g Gnocchi und 1 Kugel Mozzarella/);
});

test('fetchVideoSource meldet verstaendlich, wenn YouTube nichts rausgibt', async () => {
  const fetchImpl = fakeYoutube({ '/watch': '<html><body>Bitte anmelden</body></html>' });
  await assert.rejects(
    () => fetchVideoSource('https://youtu.be/smWgIBFuVRU', { fetchImpl }),
    /Videodaten nicht mitgeliefert/
  );

  await assert.rejects(
    () => fetchVideoSource('https://blog.example/rezept/', { fetchImpl }),
    /keine YouTube-Adresse/
  );
});

test('fetchVideoSource laesst fehlende Untertitel durchgehen', async () => {
  const seite = watchPage({
    description: 'Nur Gelaber, keine Liste.',
    tracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=x', languageCode: 'de' }],
  });
  // Untertitel-Abruf scheitert (404) – das Video bleibt trotzdem auswertbar.
  const fetchImpl = fakeYoutube({ '/watch': seite });
  const source = await fetchVideoSource('https://youtu.be/smWgIBFuVRU', { fetchImpl });
  assert.equal(source.transcript, '');
  assert.equal(source.used, 'beschreibung');
});
