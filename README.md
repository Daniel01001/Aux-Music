# Aux (MVP)

Short public playlists (5 to 10 songs) from YouTube / YouTube Music. Spend a credit to add a song to someone else's playlist and earn credits by listening. Sync with friends by ID so everyone hears the same song at the same moment.

## Run locally

```
npm install
npm start          # http://localhost:3000
```

To test on two phones, the app needs a public HTTPS address. Deploying it is the easiest way to get one (see below).

## Deploy to Render (free)

1. Push this folder to a new GitHub repo.
2. On Render, create a new **Web Service** from that repo.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
3. Optional: add the environment variable `YT_API_KEY` (a YouTube Data API v3 key) to turn on song search. Without it, you add songs by pasting a YouTube or YouTube Music link.
4. Open the `onrender.com` URL on both phones, sign up with a different ID on each, then go to Sync and invite the other phone's ID.

## How sync works

- The server keeps each sync room's state: song, playing or paused, position, and a reference time.
- Each phone estimates the gap between its clock and the server's with ping and pong messages.
- Every 0.5 s, each phone works out where the song should be. If it is more than 0.35 s off, it seeks to the right point.
- New songs start 1.5 s in the future, so every phone has time to load before the clock starts.
- If a phone buffers for more than 3 s (often an ad), the room pauses for everyone until that phone catches up.
- Anyone in the sync can play, pause, skip and seek.

## Known limits of this test build

- **Sign-in:** you pick an ID, saved on that device. Google sign-in and saving playlists back to the user's YouTube Music account need a Google Cloud OAuth client. That's the next step.
- **Storage:** data lives in `data.json`. On Render's free plan that file is wiped whenever the service restarts or sleeps after 15 minutes idle. Move to a database (Render Postgres) before real users.
- **Playback:** the app has to stay open with the video visible. YouTube's embedded player doesn't play in the background or with the screen off.
- **First play on iPhone:** iOS may need one tap on the video before sound starts. The app shows a hint when that happens.
- **Some songs won't play:** a few labels block their videos outside YouTube. The app skips those.
- **Sample profiles:** @thandi, @kabelo and @lerato are sample profiles, so the home screen isn't empty. They can't sync.
