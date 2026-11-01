// Aux on Cloudflare: static files come from /public; the API and the sync socket go to one Hub Durable Object.
import { Hub } from './hub.js';

export { Hub };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Google sign-in only trusts the https address, so never serve the app over plain http.
    // (Local dev presents requests as http to the real domain, so .dev.vars sets LOCAL_DEV to skip this.)
    if (url.protocol === 'http:' && !env.LOCAL_DEV) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    const res = await route(req, env, url.pathname);
    if (res.status === 101) return res;
    const out = new Response(res.body, res);
    // Tell browsers to use https from now on, even when someone types the address without it.
    if (url.protocol === 'https:') out.headers.set('Strict-Transport-Security', 'max-age=31536000');
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin'); // YouTube embeds need the origin
    if ((out.headers.get('Content-Type') || '').includes('text/html')) {
      out.headers.set('Content-Security-Policy', CSP);
      out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    }
    return out;
  },
};

// Pages may only run scripts from Aux itself, Google sign-in and YouTube's player. This makes it far
// harder for injected content to run code and steal a sign-in. Images and audio can come from any
// https host because song covers and streams live on many music servers.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://accounts.google.com",
  "connect-src 'self' https://accounts.google.com/gsi/",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

async function route(req, env, pathname) {
  if (pathname.startsWith('/media/')) {
    // Uploaded profile photos. Each upload gets a new name, so they can be cached for good.
    const obj = await env.MEDIA.get(decodeURIComponent(pathname.slice(7)));
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
  }
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
      version: env.CF_VERSION_METADATA?.id || 'dev',
      googleClientId: env.GOOGLE_CLIENT_ID || null,
      pushKey: env.VAPID_PRIVATE_KEY ? env.VAPID_PUBLIC_KEY || null : null,
      lyrics: env.LYRICS !== 'off',
      sources: { yt: !!env.YT_API_KEY, au: true, jm: !!env.JAMENDO_CLIENT_ID },
    });
  }
  if (pathname.startsWith('/api/') || pathname === '/ws') return env.HUB.get(env.HUB.idFromName('hub')).fetch(req);
  return env.ASSETS.fetch(req);
}
