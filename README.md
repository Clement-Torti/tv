# TV

Netflix-style front-end for live TV channels, a movies/series catalogue, and
the latest videos from the YouTube channels you follow.
Pure static site — no build step, no dependencies to install.

**Live:** https://clement-torti.github.io/tv/

## Layout

```
index.html            Markup only: navbar, hero, modals, player
assets/
  css/
    base.css          Design tokens, reset, progress bar, toast
    navbar.css        Top navigation, section dropdown, search
    hero.css          Hero banner and shared buttons
    content.css       Skeleton loader, sections, rows, grids, cards
    player.css        Collections modal, video player, carousel
    catalog.css       Movies/Series toolbar and poster grids
    youtube.css       YouTube row, embedded player, profile channel list
  js/
    config.js         Sources, section list, health thresholds, limits
    state.js          Shared state and localStorage persistence
    utils.js          Escaping, gradients, toast, stream helpers
    health.js         Stream verification and the verdict cache
    sources.js        Fetching and merging the channel sources
    stream.js         Channel -> <video>, with failover across candidate URLs
    channels.js       Boot loader: fetch, merge, hand off to the UI
    navigation.js     Search, dropdown, top-level views
    render.js         Cards, rows, grids, delegated click handling
    collections.js    Favourites and user-defined sections
    hero.js           Hero background playback
    player.js         Full-screen player and its controls
    chromecast.js     Cast sender integration
    catalog.js        Movies and Series (one shared scraper)
    youtube.js        Followed YouTube channels, their feeds and the home row
    main.js           Bootstrap and global listeners
  img/                favicon, logo, bundled channel logo
worker/
  stream-proxy.js     Optional Cloudflare Worker: HTTPS front for http streams
extension/            Chrome extension adding a TV link to netflix.com
```

Scripts are plain classic `<script>` tags, not ES modules: the markup wires
buttons through `onclick`, which needs the handlers on `window`. Load order is
fixed in `index.html` — `config.js` and `state.js` first, `main.js` last.

## Development

Any static server works; `file://` will not, because the playlist fetch needs a
real origin.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deployment

GitHub Pages serves the repository root as-is. All paths are relative, so the
site works both at the root of a domain and under `/tv/`. `.nojekyll` keeps
Pages from running the files through Jekyll.

## Channel sources

Four endpoints are merged at load time (~2.9 MB gzipped, all sending
`Access-Control-Allow-Origin: *`), producing **12,576 channels** with **18,162
candidate stream URLs**:

| Source | Role |
| --- | --- |
| `api/streams.json` | Every known stream URL, keyed to a channel |
| `api/channels.json` | Names, categories, `closed` / `is_nsfw` flags |
| `api/logos.json` | Channel logos |
| `api/blocklist.json` | DMCA/NSFW channels, excluded outright |
| `Free-TV/IPTV` | Community playlist, merged for extra backup links |

The flat `index.m3u` this app used to read is **not** used any more: measured
against `streams.json` it contributes zero unique URLs while costing 2.9 MB
uncompressed, and it carries only one link per channel.

Merging is what buys reliability. On channels that have more than one candidate,
trying the alternatives lifts the playable rate from 41% to 65%; folding in
Free-TV rescues a further 5% of the channels the two sources share.

## YouTube channels

The profile menu (the avatar, top right) holds a list of YouTube channels. They
produce two rows on the home page, directly under *My Favorites*:

- **Top 10 on YouTube** — the ten newest uploads across every channel, drawn in
  Netflix's ranked shape (an oversized outlined numeral with the thumbnail tucked
  against it). The numeral's baseline is pulled onto the row's bottom edge with a
  negative bottom margin, so the foot of the digit lines up with the foot of the
  thumbnail; the value is measured rather than derived from font metrics.
- **My Channels** — one circular avatar per channel. Clicking one plays a
  *random* upload from that channel less than three months old
  (`YOUTUBE.randomMaxAgeDays`), and the player then shows a **next** button that
  rolls to another one; a finished video does the same by itself. A channel that
  posts rarely may have nothing that recent, and falls back to its newest few.

- **All Videos** — every upload the feeds carry, merged the same way, in ordinary
  cards. All three rows come from a **single** fetch pass; each just takes a
  different depth from it.

Avatars are not in the feed, so each costs one channel-page fetch (its
`og:image`, re-requested at 176px rather than the 900px advertised), done once
and stored with the channel. The initial is drawn underneath and stays there, so
an avatar that fails to load leaves a letter rather than an empty circle. The
image carries `referrerpolicy="no-referrer"` — without it googleusercontent
refuses the request and Chrome blocks the response outright
(`ERR_BLOCKED_BY_ORB`).

This runs entirely on the public Atom feed,
`youtube.com/feeds/videos.xml?channel_id=UC...` — **no API key, no quota and no
OAuth**, which is why it needs no configuration beyond adding a channel. Two
properties of that feed shape the implementation:

- **It sends no CORS header.** The browser cannot read it directly, so every
  request goes through the same Worker as the streams and the catalogue. Nothing
  extra needs deploying: `worker/stream-proxy.js` forwards any `http(s)` target
  already.
- **It carries the 15 most recent uploads and nothing else** — no paging, no
  `max-results`. "Latest videos" is therefore all this can ever show, which is
  exactly what the row is for.

### Why the row is not sorted by date

Sorting the pooled videos newest-first is the obvious merge and it is wrong: it
hands the whole row to whichever channel uploads most often. Measured on the real
feeds, Sky News publishes **one video every 1.2 hours** while MKBHD publishes one
every **120 hours** — a hundredfold spread. Every Sky News entry is therefore
newer than anything the slower channels have, so a date sort puts six of them in
the first six slots and pushes the channels you follow for their videos off the
end of the row.

So `interleaveByChannel` deals the videos out in rounds, one per channel, sorting
only *within* a round. Each channel is guaranteed its newest upload in round one,
its second in round two, and so on, whatever its upload rate:

```
by date        Sky, Sky, Sky, Sky, Sky, Sky, Linus, MKBHD
interleaved    Sky, Fireship, MKBHD, Linus, Sky, Fireship, Linus, MKBHD
```

The row still opens with the newest video overall, because round one holds every
channel's latest. With a single channel followed it degenerates to plain
newest-first, which is correct.

### Adding a channel

The input accepts whatever the address bar happened to give you: a bare
`UC…` id, `/channel/UC…`, an `@handle` (with or without the URL around it), the
legacy `/c/` and `/user/` paths, or even a link to one of the channel's videos.

Anything that is not already an id is resolved by fetching the page and reading
the channel id out of the markup, and **the order of that read matters**. On a
channel page the `<link rel="canonical">` is authoritative; the first
`"channelId"` in the HTML belongs to whatever channel the sidebar is recommending,
so trusting it adds the wrong channel — measured on `youtube.com/@mkbhd`, that
first match is a completely unrelated id. On a *watch* page there is no channel
canonical, and there the first `"channelId"` **is** the uploader. So canonical is
tried first and the embedded id is the fallback, which covers both.

Resolving a handle costs one ~2.5 MB page fetch, but only once: the id and name
are stored, and afterwards only the few-KB feed is read.

### Shorts

Shorts share the uploads feed with regular videos and **no field distinguishes
them** — the only signal is the `/shorts/` link the entry carries. The "Hide
Shorts" toggle in the profile modal keys off that, and is on by default.

### Caching

Feeds are cached in `localStorage` for 30 minutes (`YOUTUBE.cacheTtlMs`), so a
page refresh costs no requests at all; the refresh button beside the row heading
bypasses it. YouTube itself caches the feed for several minutes, so polling harder
would only burn Worker quota for the same bytes.

## The YouTube player

Videos play in an iframe — YouTube serves no manifest hls.js or dashjs could
attach to, so nothing in `stream.js` applies. But the iframe is driven through
the **IFrame Player API** and wrapped in the live-TV player's own chrome, so the
two players match: `.video-modal`, `.player-overlay`, `.player-top`,
`.control-btn` and `.player-carousel` are all reused from `player.css`.

YouTube's **own control bar is left on**, because the audio-track selector lives
in it (see below). So the split is: YouTube owns playback — volume, speed,
quality, captions, fullscreen, audio track — and this overlay owns navigation:
back, title, an Arabic-subtitle button, the "up next" carousel and a link out.

That split has one consequence worth knowing about. `player.css` switches
`pointer-events` on for the *whole* overlay while the wrapper is hovered, which
over an iframe would swallow every click meant for YouTube's controls. So
`#ytOverlay` never takes pointer events; only its own buttons do.

Keyboard shortcuts still run through the IFrame API — space, `f`, `c` and the
arrows behave as they do in the TV player, since every API method except
`setAudioTrack` keeps working with `controls: 1`.

`player.js` itself is **not** reused, because every one of its controls talks to
a `<video>` element. The carousel differs too: it lists the **other videos in the
row** rather than favourite channels, and a finished video rolls on to the next.

### The scrim

### Nothing of ours sits on the picture

Our controls live in a bar **above** the video, not over it. Two earlier attempts
put them in an overlay and both were wrong:

- A permanently drawn bar covered YouTube's own top-right controls, and its
  settings menu — which holds the audio track — opens *upward* from the
  bottom-right into the same band.
- Hiding that bar until the pointer approached did not fix it either, because an
  overlay at `opacity: 0` **still takes pointer events**, so it went on swallowing
  clicks aimed at the controls underneath.

Out in its own bar, nothing of ours can reach the video at all: a hit-test at
every corner of the frame returns the iframe. The only thing still drawn over the
picture is the "up next" strip, which is off unless asked for.

## Arabic subtitles and dubbed audio

The two halves of this are not equally solvable, so they are worth separating.

### Subtitles: forced on, and verified

Every video opens with Arabic subtitles on. A track the uploader actually
published in Arabic is preferred; failing that YouTube auto-translates whatever
track exists (Arabic is among its 156 translation targets).

The auto-translation is **not** a one-liner, and the obvious spelling of it fails
silently:

```js
// Accepted and then ignored — no error, no subtitles.
player.setOption('captions', 'translationLanguage', { languageCode: 'ar' });

// Works: the property has to ride on the track object, written back.
const track = player.getOption('captions', 'track');
track.translationLanguage = { languageCode: 'ar' };
player.setOption('captions', 'track', track);
```

Caption tracks also load *lazily*, sometimes more than ten seconds after the
player reports ready, so a single attempt usually finds an empty tracklist.
`scheduleArabicCaptions` retries for ~25 seconds before giving up. Plenty of
videos genuinely ship no captions at all; those dim the CC button rather than
leaving it lit as though Arabic were on.

### Dubbed audio: YouTube's own menu, deliberately

Arabic dubs are reached through **YouTube's own control bar** (⚙ → Audio track →
العربية). That is why `controls: 1` is set and this overlay carries navigation
only, leaving the bottom of the frame clear. An earlier revision hid YouTube's
controls for a tidier look and took the audio track away with them; that was the
wrong trade.

The reason there is no in-house audio button is not effort. Measured against a
live player:

| Route | Result |
| --- | --- |
| `getAvailableAudioTracks()` inside the frame | lists every dub, Arabic included (`ar.3`) |
| `setAudioTrack(track)` inside the frame | **works** — audio switches to العربية |
| Same call via the IFrame API postMessage bridge | **ignored** — track stays put |
| `hl=ar` + `Accept-Language: ar-SA`, signed out | **no effect** — default stayed `en.4`, "English: original" |

So the method exists but is not on the API's whitelist, and only same-origin code
inside the iframe may call it. A static page cannot, and no amount of embed
parameters substitutes for it.

The player's UI language (`YOUTUBE.uiLang`) is **English**, set separately from
the subtitle language (`YOUTUBE.captionLang`, Arabic) — so the settings menu and
the audio-track names stay readable while subtitles remain Arabic.

One thing still tilts the odds:

- **The default host, `www.youtube.com`, not `youtube-nocookie.com`.** Signed-in
  cookies travel with it, and a YouTube account whose language is Arabic is the
  one lever that makes a dub come up on its own. Setting the *account* language
  (youtube.com → settings → Language) is worth doing; setting only the browser's
  language is not, as the table above shows.

The player shows a one-time hint pointing at the audio-track menu, and the
YouTube button in the top bar opens the video on youtube.com.

## Why streams get hidden

Only about **57% of upstream streams actually play in a browser**, measured over
a 300-stream sample. The gap is not all dead links:

- 24% are unreachable (403/404/timeout)
- 19% return a valid manifest but **no CORS header** — they play in VLC and fail
  here, because hls.js reads them over XHR

So `health.js` verifies a channel by fetching one of its manifests, which tests
reachability and CORS in a single request — the same thing the player would fail
on. Verdicts are cached in `localStorage` for 12 hours, so a second visit starts
from an already-clean list.

Cards on screen are checked first; a bounded background sweep then screens the
rest of the view. A full home page settles in ~40 seconds on a first visit and
removes roughly 180 broken channels. The "Hide broken channels" toggle in the TV
menu turns the filter off.

Some exclusions need no network check at all: blocklisted, upstream-`closed` and
NSFW channels, and protocols a browser cannot open (`rtmp`, `rtsp`, `srt`).

Streams carrying a `user_agent` are deliberately **not** excluded. Nearly all of
them just ask for an ordinary browser User-Agent, which the browser already
sends — the field is there for VLC and ffmpeg users. An earlier version dropped
them and lost 628 working channels, BFM Alsace among them.

## Notes

- Favourites and custom sections live in `localStorage`, keyed by the channel id
  (or its name, for streams the API has not matched to one).
- Followed YouTube channels, the "Hide Shorts" preference and the cached feeds
  are `localStorage` too, so the list is per-browser and never leaves the device.
- The IFrame Player API is loaded lazily, on the first video played, so visitors
  who never open one pay nothing for it.
- **Public CORS proxies are not usable for this.** Measured from a real browser:
  `corsproxy.io` answers 403 on every request, and `api.allorigins.win` succeeds
  only intermittently (1 of 3 attempts) at 6–25 seconds per request. Live HLS
  needs a fresh segment every few seconds, so a proxy that slow cannot sustain
  playback even when it does answer. See the section below for what does work.
- The Movies/Series catalogue goes through the same Worker. It used
  `api.allorigins.win`, which now fails every request — the "Failed to fetch"
  that section used to show was that proxy, not a dead source. `fetchCatalogDocument`
  accepts either a raw body or an allorigins-style `{"contents": ...}` wrapper, so
  swapping `CATALOG_PROXY` again is a one-line change.
- The CDN players (`hls.js`, `dashjs`) are pinned to a major version. Bump them
  deliberately — `@latest` used to ship breaking releases straight to production.

## Plain-HTTP streams and the optional proxy

About **1,796 channels (14%) are http-only**, and roughly half of them are still
broadcasting. On the deployed HTTPS site none of them can play, and this is a
browser rule rather than an app choice. Measured on an HTTPS page:

| Page | Result fetching an `http://` stream |
| --- | --- |
| With `upgrade-insecure-requests` | `TypeError` after 370 ms — upgraded to `https://`, which the host does not speak |
| Without it | `TypeError` after **2 ms** — blocked as mixed content, never leaves the browser |
| Same stream from an HTTP page | `200 OK`, valid manifest |

So the stream is alive; only the transport is impossible. Removing the CSP meta
makes it worse, not better. An HTTPS hop is the only way, which is what
`worker/stream-proxy.js` provides.

**How much it actually recovers: about 440 channels**, not the ~980 a count of
live http streams suggests. Measured through the deployed Worker over a 45-channel
sample: 19 were alive when fetched directly, but only 11 also worked through the
proxy — the other 8 answered `403`. Many of these bare-IP restream hosts refuse
datacenter address ranges, so they serve a home connection and reject Cloudflare.
That is a property of those hosts, not something the Worker can fix.

Forwarding the playlist is not sufficient on its own: an HLS manifest points at
segments, audio tracks, subtitles and keys by relative or absolute URL, so every
URL inside it has to be rewritten to come back through the proxy. The Worker does
that; measured through it, a full segment arrives in 400–800 ms.

### Setting it up

```sh
npm install -g wrangler
wrangler login
wrangler deploy worker/stream-proxy.js --name tv-stream-proxy --compatibility-date 2024-01-01
```

Add your site to `ALLOWED_ORIGINS` in the Worker (without it, anyone could use it
as an open proxy on your quota), then put the deployed URL in `assets/js/config.js`:

```js
const STREAM_PROXY = 'https://tv-stream-proxy.<your-subdomain>.workers.dev/?url=';
```

Leaving it empty keeps the proxy off. Cloudflare's free tier allows 100,000
requests/day — on the order of 50–150 hours of viewing.

A Worker is only reachable from an origin listed in `ALLOWED_ORIGINS`; anything
else gets a `403`. If a request fails with `Upstream responded 403`, that is the
*stream host* refusing Cloudflare, not the allowlist.

Only `http://` URLs are routed through it; HTTPS streams always go direct, since a
needless hop would add latency and burn quota. Health verdicts stay keyed by the
channel's real URL, and cached verdicts for http streams are discarded whenever
the proxy setting changes, because the answer genuinely differs.