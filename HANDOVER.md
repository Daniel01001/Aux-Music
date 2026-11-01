# Aux: handover for Claude Code

You're taking over **Aux**, a social music app built on YouTube / YouTube Music. A working MVP exists in this repo. This file explains the product, what's built, how it works, and what to do next. Read it fully before changing anything.

- **Repo:** https://github.com/Daniel01001/Aux-Music (the code may still need its first push)
- **Owner:** Daniel (developer, Johannesburg, UTC+2)
- **Stack:** Node 18+, Express 4, `ws` 8, vanilla JS front end (no framework, no build step)
- **Hosting target:** Render web service (free plan to start)

---

## 1. Product vision

1. **YouTube Music integration.** Users sign in with the Google account they use on YouTube Music.
2. **Short public playlists** of 5 to 10 songs. Everyone can browse everyone's playlists.
3. **"Pay" to add songs to other people's playlists.** You can add your own songs (as an artist) or any song, so you hear new music and your music reaches new people. Payment is an in-app **credit**, not real money (see decisions below).
4. **Find people by ID** (e.g. `@sipho`) to put a song on a specific friend's playlist.
5. **Sync listening.** Search someone's ID, tap Sync, and they get a pop-up to accept. If they accept, both devices play the same song at the same moment. Syncs can grow into **parties**, and every new person has to accept first.
6. **UI similar to YouTube Music.** The home screen is people's playlists with **yours at the top**. It should look clean and not like a template: several dark themes plus a light theme.

---

## 2. Current state

**Built and tested in a sandbox with two simulated phones (Playwright):**
- Sign-up with a chosen ID and display name. The token is saved in `localStorage`. This is a stand-in for Google sign-in.
- Home: a row of "Your playlists" (plus a New playlist card), an "In sync" banner when you're in a sync, and a "From people" grid with a 10-slot fill bar on each card.
- Playlist page: cover mosaic, play all, tap a song to play it, add a song, owner can remove songs or delete the playlist.
- Add a song: paste a YouTube or YouTube Music link, which the server resolves through YouTube oEmbed. Keyword search turns on when `YT_API_KEY` is set.
- Credits: start with 5. Adding to someone else's playlist costs 1. Listening 30 s+ to a song someone else put there earns 1, once per user per song per playlist. The owner gets a live notice when someone adds a song.
- People search with online dots. Profile pages show a user's playlists and a Sync button.
- Sync: invite, accept/decline pop-up, multi-person rooms, pending invites shown, Leave, invites expire after 60 s, rooms clean up when people leave.
- Shared controls in a sync: anyone can play, pause, skip, go back, seek or pick a song from the queue.
- Player: one YouTube IFrame player that docks as a mini player above the tab bar and expands to a full sheet with a progress bar, controls, a sync strip and the queue.
- Themes: Midnight (default), Graphite, Wine, Light. Saved per device.

**Test results:** both phones joined, pause and skip carried across, and drift stayed around 60 ms. The sandbox couldn't reach YouTube, so the test used a **fake YT player** and placeholder thumbnails. **It has not been tested on real phones against real YouTube yet.** That's the first thing to do after deploying.

**Not built yet:** Google OAuth, writing playlists to the user's real YouTube Music account, a real database, push notifications, moderation tools, and real payments (if ever).

---

## 3. File map

```
server.js            Express REST API + WebSocket sync server + JSON storage (one file)
public/index.html    Shell: top bar, #view, player (iframe container), tab bar, SVG icon sprite
public/styles.css    Design tokens + all styles (themes via :root[data-theme=...])
public/app.js        SPA: hash router, views, playback engine, socket client (one IIFE)
README.md            Run and deploy notes for humans
HANDOVER.md          This file
```

Run it locally with `npm install && npm start`, then open http://localhost:3000. Env vars: `PORT`, `DATA_FILE` (default `./data.json`) and `YT_API_KEY` (optional).

---

## 4. Server (`server.js`)

### Storage
A single in-memory object `db = { users, playlists, listens }`. It's flushed to `data.json` on a 200 ms debounce. If the file is missing, `seed()` creates 3 **sample** users (`thandi`, `kabelo`, `lerato`), each with one 5-song playlist, so the feed isn't empty. Sample users can't sign in or sync, and the UI tags them "sample".

```
User     { id (handle, lowercase), name, credits, token, sample?, createdAt }
Playlist { id (10 hex), owner (user id), name, songs: Song[], createdAt }
Song     { videoId, title, author, addedBy (user id | null = owner), addedAt }
listens  { "<userId>:<playlistId>:<videoId>": timestamp }   // stops a credit being earned twice
```

### REST (all except signup need `Authorization: Bearer <token>`)
| Method | Path | Notes |
|---|---|---|
| POST | /api/signup | `{handle, name}`. Handle must match `^[a-z0-9_]{3,20}$`. Returns `{token, user}` |
| GET | /api/me | Current user + credits |
| GET | /api/feed | `{mine[], others[]}`, newest first |
| GET | /api/users?q= | Search by ID or name. Online users first, max 20 |
| GET | /api/users/:id | `{user, playlists}` |
| POST | /api/playlists | `{name}` |
| GET / DELETE | /api/playlists/:id | Delete is owner only |
| GET | /api/resolve?url= | Parses a YouTube / YouTube Music / youtu.be / shorts link or a bare 11-char ID, then oEmbeds the title and artist |
| GET | /api/search?q= | YouTube Data API `search.list` (Music category). Returns `{enabled:false}` without a key. Results cached in memory |
| POST | /api/playlists/:id/songs | `{videoId|url, title?, author?}`. Free for the owner, 1 credit otherwise (402 if none). Max 10 songs, no duplicates |
| DELETE | /api/playlists/:id/songs/:videoId | Owner only |
| POST | /api/listen | `{playlistId, videoId}`. Earns 1 credit if someone else put the song there and it hasn't been credited before |

### WebSocket `/ws?token=...`
Server state: `online: Map<userId, Set<ws>>`, `rooms: Map<roomId, Room>`, `invites: Map<inviteId, {from,to,roomId,at}>`.

```
Room { id, host, members:Set, pending:Set,
       state: { videoId, title, author, playing, position, ref, queue[], index, playlistId, heldBy? } }
```

**The core idea:** the room's playback state is absolute. Expected position = `position + (serverNow - ref)/1000` while playing, or `position` while paused. Every change sends the **whole** room to every member (`{type:'room', room}`).

Client → server messages:
- `ping {t}` → `pong {t, s}` (for working out the clock offset)
- `invite {to}`: creates a room with the sender as host if needed, adds the person to `pending`, and sends them `{type:'invite', id, from, roomSize}`. Errors: unknown ID, sample user, offline, already in a sync.
- `respond {id, accept}`: on accept, leaves any other room and joins this one. On decline, tells the inviter.
- `leave`. When a room drops to one member with no pending invites, it closes.
- `load {queue, index, playlistId}`: sets `ref = now + 1500 ms` so every device can load before the clock starts.
- `pause {position}`, `resume {position}` (resume sets `ref = now + 600 ms`), `seek {position}`
- `next {from?}` / `prev`. `from` is the index the sender thinks is playing, so two phones that both hit "song ended" only skip once.
- `hold` / `release`: if a phone buffers for 3 s+ (usually an ad), the room pauses for everyone until that phone is playing again.

Server → client: `room`, `invite`, `invite-expired`, `notice {text}`, `error {text}`, `pong`.

When a user closes their last socket, they're removed from their room after a 15 s grace period, so a page refresh doesn't drop them.

---

## 5. Client (`public/app.js`)

- **Router:** hash-based. `#home`, `#search`, `#sync`, `#you`, `#p-<playlistId>`, `#u-<userId>`. Signed out, it shows onboarding.
- **Playback engine:** one state shape for solo and synced play. `act(msg)` applies the action locally when solo (mirroring the server's reducer) or sends it to the socket when in a room. **Keep these two reducers in sync** if you change either one.
- **`tick()` runs every 500 ms:**
  - Loads a new `videoId` when it changes.
  - When paused or before the start time, holds at the right position.
  - When playing, seeks if drift is more than 0.35 s, waits 2 s between corrections, and seeks 0.2 s ahead to cover the seek's own delay.
  - Watches for long buffering (sends `hold`) and tracks listening time for credits.
- **Clock offset:** 5 pings on connect, then one every 10 s. Keeps the offset from the fastest round trip.
- **Player DOM:** the `#yt` iframe must **never be moved** in the DOM, because that reloads it. Mini and full views are switched with CSS classes on `#player` only.
- **Autoplay:** if the player isn't playing 3 s after a load, a pass-through hint says "Tap the video to start the music". It's non-interactive on purpose, because iOS needs the tap to land on the iframe itself.

---

## 6. Design system

- Fonts: **Bricolage Grotesque** (display, 600/700) and **DM Sans** (body).
- Tokens live in `:root` in `styles.css`: `--bg --surface --surface-2 --line --text --muted --accent --on-accent --good --bad`.
- Themes override them via `:root[data-theme="graphite|wine|paper"]`. `paper` is the light theme and is labelled "Light" in the UI.
- Accents: Midnight amber `#F2A65A`, Graphite teal `#5CC8B5`, Wine rose `#E8707E`, Light burnt orange `#C94E22`.
- Style rules: no emoji, inline SVG icons (`<symbol>` sprite in `index.html`), pill buttons, avatars tinted from a hash of the handle, 560 px max width.
- Avoid generic AI looks: no purple gradients, no Inter, no everything-centered layouts. Keep it close to YouTube Music's layout without copying its branding.

---

## 7. Decisions and constraints (don't undo these without asking Daniel)

1. **Credits, not cash.** Paying real money to get songs onto playlists looks like payola (pay-for-placement rules and disclosure issues) and fills feeds with paid spam. With credits, the cost of being heard is listening to other people. If real payments ever come in, they need legal review and "promoted" labels.
2. **Playback happens in our own embedded player.** There's no API to control the YouTube Music app, so syncing has to happen inside our player.
3. **Keep the video visible and don't play in the background.** YouTube's terms and the IFrame player require the app to stay open with the video shown. Don't hide the iframe or strip out the audio.
4. **YouTube Data API quota.** 10,000 units per project per day. `playlistItems.insert` and `playlists.insert` cost **50** each (about 200 writes a day for the whole app). `search.list` has its own small daily bucket (around 100 calls). Cache aggressively and apply for a quota extension (YouTube API Services audit) before launch.
5. **Ads break sync.** Ads are per device, and the hold/release mechanism is the current answer. Users with YouTube Premium signed in at youtube.com may not see ads in embeds, but don't rely on that.
6. Some videos can't be embedded (blocked by the label). `onError` skips them. Consider checking `status.embeddable` with `videos.list` (1 unit) when a song is added.

---

## 8. Immediate next steps

1. **Push this code** to `Daniel01001/Aux-Music` on `main`. Keep `data.json` and `node_modules` out of git (already in `.gitignore`).
2. **Deploy on Render** as a Web Service. Runtime Node, build `npm install`, start `npm start`, free plan, region Frankfurt (closest to Johannesburg among Render's regions). Optionally set `YT_API_KEY`. Daniel's Render workspace is "My Workspace" (`tea-d98pvqreo5us73fi4dv0`). The repo must be public, or Render must be connected to GitHub.
3. **Test on two real phones** (one Android, one iPhone if possible):
   - Real songs play (oEmbed titles resolve).
   - Accepting an invite starts audio, or the tap hint shows.
   - Drift stays under about 0.5 s; tune the 0.35 s threshold and 0.2 s lead if not.
   - Ads trigger hold/release correctly.
   - Reconnecting after the screen locks puts you back in the room.
4. Fix whatever real-device testing turns up before adding features.

## 9. Roadmap (rough priority)

1. **Real database:** Render Postgres. On the free plan, `data.json` is wiped on every restart or idle spin-down. Tables: `users`, `playlists`, `playlist_songs`, `credit_ledger` (log every credit change), `listens`.
2. **Google sign-in:** OAuth 2.0 with the `youtube` scope, set up in Google Cloud. Link the Google account to the Aux ID, which becomes a profile handle chosen at first sign-in. Store refresh tokens encrypted.
3. **Mirror Aux playlists to the user's YouTube Music account:** `playlists.insert` + `playlistItems.insert`, so songs added by others show up in their real YouTube Music library. Queue the writes and batch them to stay within quota.
4. **Song search** with an API key, plus server-side caching (keyed by query, 24 h).
5. **Owner controls:** approve or auto-accept incoming songs, kick a song with the credit refunded, optional genre or vibe tag per playlist.
6. **Notifications:** web push or PWA install for invites and "someone added a song to your playlist".
7. **Sync polish:** host-only control mode, a "who's here" presence list, invite links, rejoining after a disconnect.
8. **Abuse and safety:** rate limits on signup, adds and invites; block users; report a playlist.

## 10. Known rough edges in the MVP

- Tokens are stored in plain text and looked up with a linear scan. Use hashed session tokens and a map or database index.
- No rate limiting or input-size limits beyond simple slicing.
- The `queue` sent with `load` comes from the client and is trusted. It should be checked against the playlist on the server.
- If a phone that sent `hold` disconnects, the room stays paused until someone taps play.
- If oEmbed fails, the title falls back to "YouTube track".
- The `listens` map grows without limit.
- The Back link uses `history.back()`, which leaves the app if you opened a playlist URL directly.
- No automated tests are in the repo. The Playwright two-phone test with the fake YT player lived in the sandbox. Recreating it under `test/` would be worth doing.
