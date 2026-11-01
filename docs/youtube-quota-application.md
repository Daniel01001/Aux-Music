# YouTube API quota extension: draft answers

For Google's **YouTube API Services – Audit and Quota Extension Form**. Copy each answer into the form, check the numbers against the Google Cloud console on the day, and attach the screenshots listed at the end.

Quota extensions are free. Google reviews the app against the YouTube API Services Terms and Developer Policies before granting more.

---

## About the organisation and app

- **Organisation / developer name:** Mukelwa Hlatshwayo (Aux)
- **Contact email:** hlatshwayomukelwa@gmail.com
- **Google Cloud project:** aux-music
- **App name:** Aux
- **App URL:** https://music.africanspring.co.za
- **Privacy policy:** https://music.africanspring.co.za/privacy
- **Terms of service:** https://music.africanspring.co.za/terms
- **Data & security page:** https://music.africanspring.co.za/security
- **Platforms:** Web app (installable PWA); Android app (Trusted Web Activity) planned.
- **Country:** South Africa

## What does the app do? (use case)

> Aux is a social music app. People make short public playlists (5 to 10 songs), add songs to friends' playlists, and listen together in sync: everyone in a "party" hears the same song at the same moment in the embedded YouTube player. Users find songs by searching or by pasting / sharing a YouTube or YouTube Music link.
>
> YouTube content is always played in the official YouTube IFrame player, visible on screen, with YouTube's own branding and controls for ads. Aux does not download, store, re-host, separate or modify audio or video, and does not play YouTube content in the background.

## Which API features do you use, and why?

| Endpoint | Cost | Why |
|---|---|---|
| `search.list` (type=video, videoCategoryId=10, videoEmbeddable=true) | 100 units | When a user taps **Search** to find a song to add to a playlist. |
| `videos.list` (part=snippet,status) | 1 unit | When a song is added: confirms it exists and is embeddable, and gets its title and channel. |
| `playlists.list` + `playlistItems.list` | 1 unit each | When a user imports songs from a YouTube Music album or playlist link they pasted. |
| IFrame Player API | – | Playback, visible on screen. |

## How do you limit API use?

> - Searches run only when the user presses Search (no search-as-you-type).
> - Results are cached for 7 days and shared between users; identical searches cost nothing.
> - Typing shows free suggestions from searches already cached.
> - Each user is limited to 15 new searches per day; more is served from cache and from independent-music sources (Audius).
> - "Share to Aux" from the YouTube Music app costs 1 unit (videos.list) instead of a search.
> - If quota is exhausted the app stops calling the API until the daily reset and falls back to cached results.
> - Before the daily reset, a scheduled job refreshes up to 20 popular cached searches using unused quota.

## How much quota do you need?

Fill in from the Cloud console (APIs & Services → YouTube Data API v3 → Quotas) on the day:

- Daily active users now: **[number]**; expected in 3 months: **[number]**
- New searches per active user per day (after caching): about **[2–4]**
- Requested daily quota: **[e.g. 100,000 units]**

> Example justification: "With 1,000 daily users each making about 3 new searches (the rest are served from our 7-day cache), we need about 300,000 units a day for searches plus about 5,000 for videos.list lookups. We are requesting 100,000 units now and will apply again as usage grows."

## Data handling and compliance

> - **Storage of API data:** search results and video metadata (video ID, title, channel name, thumbnail URL) are cached for at most 7 days and refreshed or deleted after that. Video IDs and titles are kept for songs that users have added to their playlists, so the playlists can be shown; this metadata is refreshed when a song is added again.
> - **No downloading or re-hosting** of YouTube audio or video. Thumbnails are loaded directly from i.ytimg.com.
> - **Player:** the official IFrame player is used and stays visible while playing, at least 200×200 px; when minimised, YouTube playback pauses and a cover image is shown. YouTube branding is not hidden or overlaid.
> - **No background playback** of YouTube content.
> - **Users' Google data:** sign-in uses Google Identity with basic scopes only (openid, profile). Aux stores a keyed hash of the Google account ID and the user's name; it does not store email addresses or Google access/refresh tokens.
> - **Terms and privacy:** the Terms link to the YouTube Terms of Service; the Privacy Policy links to the Google Privacy Policy and states that Aux uses YouTube API Services.
> - **Deletion:** users can delete their account in the app; their data is removed immediately.

## Screenshots / recording to attach

1. Home screen (playlists, Fresh finds, Live parties).
2. The add-song sheet showing the **Search YouTube Music** button and suggestions.
3. The full player with the YouTube video visible.
4. A party with two phones playing the same song (a 30-second screen recording is best).
5. The Terms page showing the YouTube Terms of Service link, and the Privacy page showing the Google Privacy Policy link.
6. Google Cloud console quota usage graph for the last 30 days.

## Player size

> The full player shows the YouTube video at the full screen width (well above 200×200 px). When the player is minimised, a YouTube song is paused and its cover image is shown instead of the video; it resumes when the player is opened again. YouTube content therefore only plays in a player of at least 200×200 px.
