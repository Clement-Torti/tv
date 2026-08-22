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
    config.js         Endpoints, section list, limits, bundled channels
    state.js          Shared state and localStorage persistence
    utils.js          Escaping, gradients, toast, stream URL helpers
    stream.js         Channel -> <video>: proxy, DASH/HLS, HTTPS fallback
    channels.js       Playlist fetch and M3U parsing
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

## Notes

- Channels come from [iptv-org](https://github.com/iptv-org/iptv). Plain-HTTP
  streams are proxied through `corsproxy.io`, since the page itself is HTTPS.
- Favourites and custom sections live in `localStorage`, keyed by the raw
  playlist channel name.
- The CDN players (`hls.js`, `dashjs`) are pinned to a major version. Bump them
  deliberately — `@latest` used to ship breaking releases straight to production.
