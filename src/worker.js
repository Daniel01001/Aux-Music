// Aux on Cloudflare: static files come from /public; the API and the sync socket go to one Hub Durable Object.
import { Hub } from './hub.js';

export { Hub };

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);

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
  },
};
