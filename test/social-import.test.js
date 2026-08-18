import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchInstagramSource,
  instagramAuthorFromTitle,
  instagramCode,
  isInstagramUrl,
  isSocialUrl,
  parseInstagramEmbed,
  servingsFromText,
  socialKey,
  socialRecipeBase,
  titleFromCaption,
} from '../lib/social-import.js';

// Echte Bildunterschrift eines Kochkanals, gekuerzt auf das Wesentliche.
// Wichtig: Instagram liefert in og:description nur den ANFANG - genau bis
// "Zutaten fuer 4 Portionen 150" - danach faengt die Liste erst an.
const CAPTION = [
  'Cremiges Bircher Müsli über Nacht – in 15 Minuten vorbereitet! 🥣🍎⬇️ Du suchst ein gesundes Frühstück für deine Familie?',
  '',
  'Zutaten für 4 Portionen',
  '150 g Haferflocken',
  '400 g Joghurt',
  '1 Apfel',
  '1 Birne',
  '50 g Nüsse',
  '2 EL Rosinen',
  '',
  'Zubereitung',
  'Apfel und Birne reiben und alles verrühren.',
  'Über Nacht in den Kühlschrank stellen.',
  '',
  'Speicher dir das @familienkost Rezept!',
  '#frühstück #mealprep',
].join('\n');

const GEKUERZT =
  'Cremiges Bircher Müsli über Nacht – in 15 Minuten vorbereitet! 🥣🍎⬇️ Du suchst ein gesundes Frühstück für deine Familie? Zutaten für 4 Portionen 150';

function embedPage({ caption = CAPTION, mitJson = true } = {}) {
  const meta = `
    <meta property="og:title" content="Jenny Böhme on Instagram: &quot;${GEKUERZT}&quot;" />
    <meta property="og:description" content="${GEKUERZT}" />
    <meta property="og:image" content="https://scontent.example/bircher.jpg" />`;
  const json = mitJson
    ? `<script>window.__additionalDataLoaded('extra', {"shortcode_media":{"owner":{"username":"familienkost"},"edge_media_to_caption":{"edges":[{"node":{"text":${JSON.stringify(
        caption
      )}}}]}}});</script>`
    : '';
  const markup = `
    <div class="Caption">
      <a class="CaptionUsername" href="/familienkost/">familienkost</a>
      ${caption.replace(/\n/g, '<br>')}
      <div class="CaptionComments"><a>48 comments</a></div>
    </div>`;
  return `<!doctype html><html><head>${meta}</head><body>${markup}${json}</body></html>`;
}

// ── Adressen ──────────────────────────────────────────────────────────────────

test('instagramCode kennt Reels, Beitraege und den Teilen-Anhang', () => {
  const code = 'DcFt7BnDY4U';
  assert.equal(instagramCode(`https://www.instagram.com/reel/${code}/`), code);
  assert.equal(instagramCode(`https://www.instagram.com/reel/${code}/?igsh=abc123`), code);
  assert.equal(instagramCode(`https://instagram.com/p/${code}/`), code);
  assert.equal(instagramCode(`https://www.instagram.com/tv/${code}`), code);

  assert.equal(instagramCode('https://www.instagram.com/familienkost/'), '');
  assert.equal(instagramCode('https://youtu.be/smWgIBFuVRU'), '');
  assert.equal(instagramCode(''), '');
  assert.equal(isInstagramUrl(`https://www.instagram.com/reel/${code}/`), true);
});

test('isSocialUrl und socialKey deckeln beide Quellen ab', () => {
  assert.equal(isSocialUrl('https://youtu.be/smWgIBFuVRU'), true);
  assert.equal(isSocialUrl('https://www.instagram.com/reel/DcFt7BnDY4U/'), true);
  assert.equal(isSocialUrl('https://www.chefkoch.de/rezepte/123/X.html'), false);

  assert.equal(socialKey('https://youtu.be/smWgIBFuVRU'), 'smWgIBFuVRU');
  assert.equal(socialKey('https://www.instagram.com/reel/DcFt7BnDY4U/'), 'DcFt7BnDY4U');
  // Derselbe Beitrag als /p/ und als /reel/ ist dieselbe Kennung.
  assert.equal(
    socialKey('https://www.instagram.com/p/DcFt7BnDY4U/'),
    socialKey('https://www.instagram.com/reel/DcFt7BnDY4U/?igsh=x')
  );
  assert.equal(socialKey('https://blog.example/rezept/'), '');
});

// ── Einbettungs-Seite ─────────────────────────────────────────────────────────

test('parseInstagramEmbed nimmt die VOLLE Bildunterschrift, nicht die Meta-Daten', () => {
  const info = parseInstagramEmbed(embedPage());
  assert.equal(info.author, 'familienkost');
  assert.equal(info.image, 'https://scontent.example/bircher.jpg');
  // Der Beweis: die Zutaten stehen NUR im vollen Text.
  assert.match(info.caption, /150 g Haferflocken/);
  assert.match(info.caption, /Über Nacht in den Kühlschrank/);
  assert.ok(info.caption.length > GEKUERZT.length, 'mehr als die Meta-Daten');
});

test('parseInstagramEmbed faellt auf das Markup zurueck, wenn das JSON fehlt', () => {
  const info = parseInstagramEmbed(embedPage({ mitJson: false }));
  assert.match(info.caption, /150 g Haferflocken/);
  assert.equal(info.author, 'familienkost', 'Name aus dem Caption-Link');
  assert.doesNotMatch(
    info.caption.split('\n')[0],
    /^familienkost/,
    'der Benutzername steht nicht im Text'
  );
});

test('parseInstagramEmbed nimmt notfalls die gekuerzten Meta-Daten', () => {
  const nur_meta = `<html><head>
    <meta property="og:title" content="Jenny Böhme on Instagram: &quot;Bircher&quot;" />
    <meta property="og:description" content="${GEKUERZT}" />
  </head><body>Bitte anmelden</body></html>`;
  const info = parseInstagramEmbed(nur_meta);
  assert.equal(info.caption, GEKUERZT);
  assert.equal(info.author, 'Jenny Böhme', 'Name aus dem og:title');
  assert.equal(parseInstagramEmbed('<html></html>').caption, '');
});

test('instagramAuthorFromTitle schneidet das "on Instagram" ab', () => {
  assert.equal(
    instagramAuthorFromTitle('Jenny Böhme on Instagram: "Cremiges Bircher Müsli"'),
    'Jenny Böhme'
  );
  assert.equal(instagramAuthorFromTitle('irgendwas'), '');
});

// ── Titel und Portionen ───────────────────────────────────────────────────────

test('titleFromCaption macht aus dem Aufhaenger einen Rezeptnamen', () => {
  // Emoji weg, alles ab dem Ausrufezeichen weg, angehaengter Untertitel weg.
  assert.equal(titleFromCaption(CAPTION), 'Cremiges Bircher Müsli über Nacht');

  assert.equal(titleFromCaption('Lasagne wie bei Oma\n\n500 g Hack'), 'Lasagne wie bei Oma');
  assert.equal(titleFromCaption('Rezept: Ofengemüse mit Feta'), 'Ofengemüse mit Feta');
  // Ein Roman als erste Zeile wird gekuerzt, aber nicht mitten im Wort.
  const lang = titleFromCaption(`${'Sehr lecker '.repeat(20)}`);
  assert.ok(lang.length <= 70, `zu lang: ${lang}`);
  assert.doesNotMatch(lang, /\s$/);
  // Nichts brauchbares -> Rueckfall.
  assert.equal(titleFromCaption('', 'Bircher Müsli | Rezept'), 'Bircher Müsli');
});

test('servingsFromText liest die Portionsangabe', () => {
  assert.equal(servingsFromText(CAPTION), '4 Portionen');
  assert.equal(servingsFromText('Zutaten für 2 Personen'), '2 Personen');
  assert.equal(servingsFromText('für 6 Gläser'), '6 Gläser');
  assert.equal(servingsFromText('für 12 Stück'), '12 Stück');
  assert.equal(servingsFromText('einfach lecker'), '');
});

test('socialRecipeBase kennzeichnet die Quelle', () => {
  const insta = socialRecipeBase({
    platform: 'instagram',
    title: 'Bircher Müsli',
    url: 'https://www.instagram.com/reel/X/',
    image: 'https://bild.example/a.jpg',
    author: 'familienkost',
    servings: '4 Portionen',
  });
  assert.deepEqual(insta.tags, ['Instagram', 'familienkost']);
  assert.equal(insta.servings, '4 Portionen');
  assert.equal(insta.name, 'Bircher Müsli');

  const video = socialRecipeBase({
    platform: 'youtube',
    title: 'Gnocchi-Auflauf | Rezept von Emmi',
    url: 'https://www.youtube.com/watch?v=X',
    author: 'Emmi',
  });
  assert.deepEqual(video.tags, ['Video', 'Emmi']);
  assert.equal(video.name, 'Gnocchi-Auflauf', 'Videotitel wird entlaermt');
  assert.ok(!('servings' in video), 'ohne Angabe kein leeres Feld');
});

// ── Zusammenspiel mit dem Netz ────────────────────────────────────────────────

test('fetchInstagramSource holt die Einbettungs-Seite', async () => {
  const geholt = [];
  const fetchImpl = async (url) => {
    geholt.push(String(url));
    return new Response(embedPage(), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };

  const source = await fetchInstagramSource(
    'https://www.instagram.com/reel/DcFt7BnDY4U/?igsh=abc',
    { fetchImpl }
  );
  assert.equal(geholt.length, 1);
  assert.match(geholt[0], /\/reel\/DcFt7BnDY4U\/embed\/captioned\/$/);

  assert.equal(source.platform, 'instagram');
  assert.equal(source.id, 'DcFt7BnDY4U');
  assert.equal(source.url, 'https://www.instagram.com/reel/DcFt7BnDY4U/');
  assert.equal(source.title, 'Cremiges Bircher Müsli über Nacht');
  assert.equal(source.author, 'familienkost');
  assert.equal(source.servings, '4 Portionen');
  assert.equal(source.used, 'Instagram-Text');
  assert.match(source.text, /150 g Haferflocken/);
});

test('fetchInstagramSource meldet die Anmeldewand verstaendlich', async () => {
  const fetchImpl = async () =>
    new Response('<html><body>Bitte anmelden</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  await assert.rejects(
    () => fetchInstagramSource('https://www.instagram.com/reel/DcFt7BnDY4U/', { fetchImpl }),
    /Beitragstext nicht mitgeliefert/
  );

  const weg = async () => new Response('nope', { status: 404 });
  await assert.rejects(
    () => fetchInstagramSource('https://www.instagram.com/reel/DcFt7BnDY4U/', { fetchImpl: weg }),
    /HTTP 404/
  );

  await assert.rejects(
    () => fetchInstagramSource('https://blog.example/rezept/', { fetchImpl }),
    /keine Instagram-Adresse/
  );
});
