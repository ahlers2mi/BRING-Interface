// Netzfehler lesbar machen.
//
// Node verpackt jeden Verbindungsfehler in ein nacktes `fetch failed`; der
// eigentliche Grund steht in `err.cause`. In der Oberfläche stand deshalb
// bisher nur "Fehler: fetch failed" – daraus lässt sich nicht ablesen, ob der
// Name nicht auflösbar war, die Gegenstelle abgelehnt hat oder eine Firewall
// dazwischen sitzt.

const HINWEIS = {
  ENOTFOUND:
    'Der Name lässt sich nicht auflösen. Bei einer zweiten Instanz: der ' +
    'Docker-Dienstname (z. B. "mealie") gilt nur innerhalb desselben Stacks – ' +
    'von außen die NAS-Adresse mit veröffentlichtem Port nehmen.',
  EAI_AGAIN: 'Der Name lässt sich nicht auflösen (DNS antwortet nicht).',
  ECONNREFUSED:
    'Die Gegenstelle hat die Verbindung abgelehnt – läuft dort wirklich ein ' +
    'Dienst auf diesem Port?',
  ECONNRESET: 'Die Gegenstelle hat die Verbindung abgebrochen.',
  EHOSTUNREACH: 'Die Adresse ist vom Container aus nicht erreichbar.',
  ENETUNREACH:
    'Kein Weg ins Netz. Häufig IPv6: die Gegenstelle hat eine AAAA-Adresse, ' +
    'der Container aber keine IPv6-Route.',
  ETIMEDOUT: 'Zeitüberschreitung beim Verbinden – meist eine Firewall dazwischen.',
  UND_ERR_CONNECT_TIMEOUT: 'Zeitüberschreitung beim Verbinden.',
  UND_ERR_HEADERS_TIMEOUT: 'Die Gegenstelle hat zu lange nicht geantwortet.',
  CERT_HAS_EXPIRED: 'Das Zertifikat der Gegenstelle ist abgelaufen.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Die Gegenstelle hat ein selbst signiertes Zertifikat.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Das Zertifikat der Gegenstelle ist nicht prüfbar.',
};

/**
 * Kurzer Code des eigentlichen Fehlers ('ENOTFOUND') oder ''.
 * Sucht über `cause` in die Tiefe und über `errors` in die Breite: bei Namen
 * mit IPv4- UND IPv6-Adresse sammelt Node die einzelnen Fehlversuche in einem
 * AggregateError, und dort steht der Code nur an den Teilfehlern.
 */
export function errorCode(err, tiefe = 0) {
  if (!err || tiefe > 5) return '';
  if (err.code) return String(err.code);
  if (Array.isArray(err.errors)) {
    for (const teil of err.errors) {
      const code = errorCode(teil, tiefe + 1);
      if (code) return code;
    }
  }
  return errorCode(err.cause, tiefe + 1);
}

/**
 * Aus einem Fehler einen Satz machen, mit dem man etwas anfangen kann.
 * `was` benennt das Ziel, z. B. 'Mealie' oder die Adresse.
 */
export function describeNetError(err, was = '') {
  const code = errorCode(err);
  const ziel = was ? ` (${was})` : '';
  // Zuerst: eine abgelaufene Frist trägt keinen Code, nur den Namen.
  if (err?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return `Zeitüberschreitung${ziel} – die Gegenstelle hat nicht rechtzeitig geantwortet.`;
  }
  if (!code) return `${err?.message || 'Unbekannter Fehler'}${ziel}`;
  const hinweis = HINWEIS[code];
  return `${code}${ziel}${hinweis ? ` – ${hinweis}` : ''}`;
}

/**
 * fetch aufrufen und Verbindungsfehler durch eine lesbare Meldung ersetzen.
 * HTTP-Fehler (404, 500 …) bleiben unangetastet – das ist Sache des Aufrufers.
 */
export async function fetchOrExplain(url, options = {}, { fetchImpl = fetch, was = '' } = {}) {
  try {
    return await fetchImpl(url, options);
  } catch (err) {
    const e = new Error(describeNetError(err, was || String(url)));
    e.code = errorCode(err);
    e.cause = err;
    throw e;
  }
}
