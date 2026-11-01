// Web push without a payload: we only "ring" the device, signed with our VAPID key.
// The service worker then asks /api/push/latest what to show, so nothing needs encrypting here.

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

let keyCache = null;
async function signingKey(privateJwk) {
  if (!keyCache) keyCache = await crypto.subtle.importKey('jwk', JSON.parse(privateJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return keyCache;
}

async function vapidJwt(endpoint, privateJwk, subject) {
  const header = enc({ typ: 'JWT', alg: 'ES256' });
  const claims = enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(privateJwk), new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

// Returns 'ok', 'gone' (subscription no longer valid; delete it) or 'failed'.
export async function ring(endpoint, env) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return 'failed';
  try {
    const jwt = await vapidJwt(endpoint, env.VAPID_PRIVATE_KEY, 'https://music.africanspring.co.za');
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, TTL: '86400', Urgency: 'normal', 'Content-Length': '0' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'ok' : 'failed';
  } catch { return 'failed'; }
}
