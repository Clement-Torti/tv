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

The profile menu (the avatar, top right) holds a list of YouTube channels. Their
latest uploads are merged into one **Latest on YouTube** row directly under
*My Favorites* on the home page, newest first across every channel.

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
  exactly what the row is for. `YOUTUBE.perChannel` trims it further before the
  merge so one prolific channel cannot crowd out the rest.

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

### Caching and playback

Feeds are cached in `localStorage` for 30 minutes (`YOUTUBE.cacheTtlMs`), so a
page refresh costs no requests at all; the refresh button beside the row heading
bypasses it. YouTube itself caches the feed for several minutes, so polling harder
would only burn Worker quota for the same bytes.

Videos play in an embedded iframe, **not** the site's own player: YouTube serves
no manifest that hls.js or dashjs could attach to, so none of `stream.js` applies.
Some uploads forbid embedding, so the player header always offers a way out to
youtube.com.

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