# Aux

Short public playlists (5 to 10 songs). Spend a credit to add a song to someone else's playlist and earn credits by listening. Sync with friends by ID so everyone hears the same song at the same moment.

Live: https://music.africanspring.co.za

## Song sources

Playlists hold **songs**, not videos. Each song has a source:

- **YouTube Music** (`yt:`): mainstream catalogue. It plays in YouTube's embedded player, which has to stay visible and stops when the screen is off. Search shows YouTube Music's official audio uploads ("Topic" channels) first, labelled **Song**.
- **Audius** (`au:`): independent artists, streamed as plain audio. These songs keep playing with the screen off and show on the lock screen.

## Stack

Cloudflare Workers, no build step:

- `public/`: the app (vanilla JS PWA), served as static assets.
- `src/worker.js`: entry point. Sends `/api/*` and `/ws` to the Hub.
- `src/hub.js`: a single Durable Object that serves the REST API and holds every WebSocket and sync room (using WebSocket hibernation).
- `migrations/`: D1 (SQLite) schema and sample data. Tables: users, sessions, tracks, playlists, playlist_songs, credit_ledger, listens, search_cache.

## Run locally

```
npm install
npm run db:local     # create the local database
npx wrangler dev     # http://localhost:8787
```

For local YouTube search, put `YT_API_KEY=...` in a `.dev.vars` file. Git ignores it.

## Deploy

```
npm run deploy       # applies new D1 migrations, then deploys the Worker
```

Settings live on the `aux-music` Worker in the Cloudflare dashboard (Settings → Variables and Secrets). They aren't in `wrangler.jsonc`, so a deploy doesn't wipe them:

- `YT_API_KEY` (secret): turns on YouTube search. Set it with `npx wrangler secret put YT_API_KEY`.
- `GOOGLE_CLIENT_ID`: turns on Sign in with Google and turns off the plain ID signup.
- `ANDROID_PACKAGE`, `ANDROID_SHA256`: the Android app's package name and signing-key fingerprint(s), served at `/.well-known/assetlinks.json`.

## How sync works

- The Hub keeps each sync room's state: song, playing or paused, position, and a reference time. The queue always comes from the stored playlist, never from the phone.
- Each phone estimates the gap between its clock and the server's with ping and pong messages.
- Every 0.5 s, each phone works out where the song should be. If it is more than 0.35 s off, it seeks to the right point.
- New songs start 1.5 s in the future, so every phone has time to load before the clock starts.
- If a phone buffers for more than 3 s (often an ad), the room pauses for everyone until that phone catches up. If that phone disconnects, the room resumes.
- Anyone in the sync can play, pause, skip and seek.

## Known limits

- **YouTube songs need the app open:** YouTube's embedded player doesn't play in the background or with the screen off. Audius songs do.
- **First play on iPhone:** iOS may need one tap on the player before sound starts. The app shows a hint when that happens.
- **Some YouTube songs won't play:** a few labels block their videos outside YouTube. With an API key, these are rejected when someone adds them. Otherwise they're skipped during playback.
- **Sample profiles:** @thandi, @kabelo, @lerato and @naledi are sample profiles, so the home screen isn't empty. They can't sign in or sync.
