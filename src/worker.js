// Aux on Cloudflare: static files come from /public; the API and the sync socket go to one Hub Durable Object.
import { Hub } from './hub.js';

export { Hub };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Google sign-in only trusts the https address, so never serve the app over plain http.
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    const res = await route(req, env, url.pathname);
    if (url.protocol !== 'https:' || res.status === 101) return res;
    // Tell browsers to use https from now on, even when someone types the address without it.
    const out = new Response(res.body, res);
    out.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return out;
  },
};

async function route(req, env, pathname) {
  if (pathname === '/.well-known/assetlinks.json') {
    // Lets the Android app (TWA) open full screen without a browser bar.
    const fingerprints = String(env.ANDROID_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
    return Response.json(env.ANDROID_PACKAGE && fingerprints.length ? [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: env.ANDROID_PACKAGE, sha256_cert_fingerprints: fingerprints },
    }] : []);
  }
  if (pathname === '/api/config') {
    return Response.json({
      googleClientId: env.GOOGLE_CLIENT_ID || null,
      pushKey: env.VAPID_PRIVATE_KEY ? env.VAPID_PUBLIC_KEY || null : null,
      sources: { yt: !!env.YT_API_KEY, au: true, jm: !!env.JAMENDO_CLIENT_ID },
    });
  }
  if (pathname.startsWith('/api/') || pathname === '/ws') return env.HUB.get(env.HUB.idFromName('hub')).fetch(req);
  return env.ASSETS.fetch(req);
}
