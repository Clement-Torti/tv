# TV

Netflix-style front-end for live TV channels plus a movies/series catalogue.
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
    main.js           Bootstrap and global listeners
  img/                favicon, logo, bundled channel logo
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
- **There is no CORS proxy in the playback path**, and re-adding one would not
  help. Measured from a real browser: `corsproxy.io` answers 403 on every request,
  and `api.allorigins.win` succeeds only intermittently (1 of 3 attempts) taking
  6–25 seconds per request. Live HLS needs a fresh segment every few seconds, so
  a proxy that slow cannot sustain playback even when it does answer. Playback
  falls back to the next candidate URL instead.
- A consequence worth knowing: **`http://` streams are effectively unusable on the
  deployed site.** The page is HTTPS and sets `upgrade-insecure-requests`, so the
  browser rewrites them to `https://`, and the bare-IP hosts these links point at
  do not serve HTTPS. They are ranked last for this reason. Tools like VLC have no
  such restriction, which is why a link can work there and not here.
- The Movies/Series catalogue still goes through `api.allorigins.win`, so it
  inherits that unreliability and may fail to load.
- The CDN players (`hls.js`, `dashjs`) are pinned to a major version. Bump them
  deliberately — `@latest` used to ship breaking releases straight to production.
