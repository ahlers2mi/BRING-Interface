import crypto from 'crypto';

// Gemeinsames Passwort. Ist es nicht gesetzt, ist der Schutz deaktiviert
// (z. B. für rein lokalen/VPN-Betrieb) – für öffentlichen Zugriff zwingend setzen.
const PASSWORD = process.env.APP_PASSWORD || '';

// Schlüssel zum Signieren des Session-Cookies. Fällt auf einen aus dem Passwort
// abgeleiteten Wert zurück; ändert sich das Passwort, werden alte Sessions ungültig.
const SECRET =
  process.env.APP_SECRET ||
  (PASSWORD
    ? crypto.createHash('sha256').update('bring-interface:' + PASSWORD).digest('hex')
    : '');

const COOKIE = 'bring_auth';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 Tage
const ALLOW_PATHS = new Set(['/login', '/logout', '/favicon.svg']);

export const authEnabled = Boolean(PASSWORD);

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('hex');
}

function makeToken() {
  const issued = Date.now().toString();
  return `${issued}.${sign(issued)}`;
}

function verifyToken(token) {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const issued = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = sign(issued);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const ts = Number(issued);
  return Number.isFinite(ts) && Date.now() - ts <= MAX_AGE_MS;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function passwordMatches(input) {
  const a = Buffer.from(String(input));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function isAuthed(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function setAuthCookie(req, res) {
  const parts = [
    `${COOKIE}=${makeToken()}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

const loginPage = (error) => `<!DOCTYPE html>
<html lang="de"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Anmelden – BRING-Interface</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#f8fafc;color:#1e293b;display:flex;min-height:100vh;align-items:center;
    justify-content:center;margin:0;padding:1rem;}
  .box{background:#fff;border-radius:0.75rem;box-shadow:0 4px 16px rgba(0,0,0,.12);
    padding:2rem;width:100%;max-width:340px;text-align:center;}
  .logo{font-size:2.5rem;}
  h1{font-size:1.25rem;margin:.5rem 0 1.25rem;}
  input{width:100%;padding:.7rem;border:1px solid #e2e8f0;border-radius:.75rem;
    font-size:1rem;margin-bottom:.75rem;}
  button{width:100%;padding:.7rem;border:0;border-radius:.75rem;background:#f97316;
    color:#fff;font-size:1rem;font-weight:600;cursor:pointer;}
  button:hover{background:#ea580c;}
  .err{background:#fee2e2;color:#991b1b;border-radius:.5rem;padding:.5rem;
    font-size:.9rem;margin-bottom:.75rem;}
</style></head>
<body>
  <form class="box" method="POST" action="/login">
    <div class="logo">🛒</div>
    <h1>BRING-Interface</h1>
    ${error ? '<div class="err">Falsches Passwort.</div>' : ''}
    <input type="password" name="password" placeholder="Passwort" autofocus
      autocomplete="current-password" />
    <button type="submit">Anmelden</button>
  </form>
</body></html>`;

export function registerAuth(app) {
  if (!authEnabled) {
    console.warn(
      '⚠ APP_PASSWORD ist nicht gesetzt – die App ist OHNE Passwortschutz erreichbar.'
    );
    return;
  }

  // Schutz-Middleware für alle nachfolgenden Routen/Assets.
  app.use((req, res, next) => {
    if (isAuthed(req) || ALLOW_PATHS.has(req.path)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Nicht angemeldet.' });
    }
    return res.redirect('/login');
  });

  app.get('/login', (req, res) => {
    if (isAuthed(req)) return res.redirect('/');
    res.type('html').send(loginPage(false));
  });

  app.post('/login', async (req, res) => {
    const password = (req.body && req.body.password) || '';
    if (passwordMatches(password)) {
      setAuthCookie(req, res);
      return res.redirect('/');
    }
    // Brute-Force-Bremse: kleine Verzögerung bei Fehlversuch.
    await new Promise((r) => setTimeout(r, 1000));
    res.status(401).type('html').send(loginPage(true));
  });

  app.get('/logout', (req, res) => {
    clearAuthCookie(res);
    res.redirect('/login');
  });
}
