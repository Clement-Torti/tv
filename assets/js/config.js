/* Static configuration. Everything tunable lives here. */

/*
 * Channel sources, merged at load time (see sources.js).
 *
 * The iptv-org API is the primary source: unlike the flat `index.m3u` this app
 * used to read, it lists *every* known stream per channel, which is what makes
 * failover between backup links possible. Measured on a 300-stream sample only
 * ~57% of streams actually play in a browser, so extra candidates matter.
 *
 * Free-TV is a community playlist merged in on top; it contributes ~1,200 URLs
 * the API does not have. All four endpoints send `Access-Control-Allow-Origin: *`,
 * so the browser can read them directly.
 */
const SOURCES = {
    // Stream URLs, one entry per known link. Keyed to a channel id.
    streams: 'https://iptv-org.github.io/api/streams.json',
    // Channel metadata: display name, categories, closed/nsfw flags.
    channels: 'https://iptv-org.github.io/api/channels.json',
    // Channel logos.
    logos: 'https://iptv-org.github.io/api/logos.json',
    // Channels removed for DMCA/NSFW reasons; excluded outright.
    blocklist: 'https://iptv-org.github.io/api/blocklist.json',
    // Community playlist, merged in for the extra backup links it carries.
    freetv: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'
};

/*
 * Optional HTTPS front for plain-HTTP streams (see worker/stream-proxy.js).
 *
 * Leave empty to disable. A browser cannot load an http:// stream from this
 * HTTPS page at all -- it is either blocked as mixed content or upgraded to a
 * https:// the origin does not speak -- so without a proxy those channels are
 * unreachable. About 1,800 channels are http-only and roughly half still
 * broadcast, so configuring this recovers close to a thousand of them.
 *
 * Must end with the query parameter, e.g.
 *   'https://tv-stream-proxy.<your-subdomain>.workers.dev/?url='
 */
const STREAM_PROXY = 'https://tv-stream-proxy.clement-torti.workers.dev/?url=';

/*
 * Sections shown on the home page. These match the iptv-org category slugs
 * (lower-cased when compared), so no translation table is needed.
 */
const STANDARD_SECTIONS = [
    'News', 'Sports', 'Movies', 'Series', 'Entertainment', 'Kids', 'Music', 'Documentary', 'General'
];

/*
 * Stream health checking.
 *
 * A channel is verified by fetching its manifest: that single request proves the
 * stream is reachable *and* that it sends CORS headers, which hls.js needs. It is
 * the same check the player would fail on, just done ahead of time.
 */
const HEALTH = {
    // Parallel probes. Manifests are a few KB, so this is cheap; it is the main
    // lever on how fast a listing finishes screening.
    concurrency: 10,
    /*
     * A stream that has not answered by now is treated as broken. Measured over
     * the working streams in a 300-stream sample: p95 answers in 2.7s and p99 in
     * 3.3s, so 4s misclassifies about 1% of good streams while cutting a third
     * off the time spent waiting on dead ones.
     */
    timeoutMs: 4000,
    // How long a verdict is trusted before it is re-checked.
    ttlMs: 12 * 60 * 60 * 1000,
    // Verdict cache entries kept in localStorage (oldest dropped first).
    maxCached: 5000,
    /*
     * Candidate URLs probed per channel before it is declared broken. This is a
     * screening depth, not a limit on playback: the player still walks every
     * candidate a channel has when the user actually opens it.
     */
    maxUrlsPerChannel: 3,
    // Channels verified per view by the background sweep. Cards on screen are
    // always checked first; this bounds the work for everything below the fold
    // so a long listing cannot turn into thousands of requests.
    sweepLimit: 400,
    // Delay before the sweep starts, leaving the visible cards to go first.
    sweepDelayMs: 1200,
    /*
     * How long a candidate gets to produce actual video once it has been
     * attached. A manifest that parses but never yields a frame is broken, and
     * without this it would simply hang on a black screen for ever.
     */
    playbackTimeoutMs: 10000
};

// Scraped catalogue (Movies / Series) and the read-through proxy used to fetch it.
const CATALOG_BASE_URL = 'https://pelispedia.mov';
// Reuses the same Worker as the streams (worker/stream-proxy.js). The public
// proxy this used before, api.allorigins.win, now fails every request.
const CATALOG_PROXY = 'https://tv-stream-proxy.clement-torti.workers.dev/?url=';

/*
 * YouTube channel feeds.
 *
 * `https://www.youtube.com/feeds/videos.xml?channel_id=UC...` is a plain Atom
 * feed: no API key, no quota, no OAuth. It does *not* send CORS headers, though,
 * so the browser cannot read it directly -- every request goes through the same
 * Worker the streams and the catalogue use.
 *
 * The feed carries the 15 most recent uploads and nothing else: there is no
 * paging and no `max-results`, so 15 per channel is a hard ceiling, not a choice.
 */
const YOUTUBE = {
    feedBase: 'https://www.youtube.com/feeds/videos.xml?channel_id=',
    // Same Worker as STREAM_PROXY/CATALOG_PROXY, named separately so it can be
    // pointed elsewhere without touching stream playback.
    proxy: 'https://tv-stream-proxy.clement-torti.workers.dev/?url=',
    // Feeds are cached this long before being re-fetched. YouTube itself caches
    // the feed for several minutes, so polling harder would only burn quota.
    cacheTtlMs: 30 * 60 * 1000,
    // Feeds fetched at once. Each is a few KB, but every one is a Worker request.
    concurrency: 4,
    // Videos kept per channel before the merged row is built.
    perChannel: 6,
    // Watch URL used for the "open on YouTube" fallback.
    watchBase: 'https://www.youtube.com/watch?v=',
    // Privacy-preserving embed host, used by the in-app player.
    embedBase: 'https://www.youtube-nocookie.com/embed/',
    /*
     * Subtitle language forced on every video, and the player's own UI language.
     * A track the uploader published in this language is preferred; failing that
     * YouTube auto-translates whatever track exists into it.
     *
     * This does NOT control the *audio* track. YouTube's multi-language dubs are
     * not reachable from the IFrame API at all -- it exposes no audio-track
     * method -- so `hl` below is the only signal available, and a dub plays only
     * where the uploader published one.
     */
    captionLang: 'ar'
};

// localStorage keys.
const STORAGE_KEYS = {
    favorites: 'clement_favorites',
    sections: 'clement_custom_sections',
    verdicts: 'clement_stream_health',
    hideBroken: 'clement_hide_broken',
    watchTimer: 'clement_watch_timer',
    youtubeChannels: 'clement_youtube_channels',
    youtubeCache: 'clement_youtube_cache',
    hideShorts: 'clement_hide_shorts'
};

// Caps that keep very large listings from freezing the page.
const LIMITS = {
    // A horizontal row only ever shows a handful of cards, so rendering every
    // channel in it just costs DOM nodes and health probes. Category pages are
    // unaffected -- they use the grid caps below.
    homeRow: 60,
    discoverRow: 50,
    otherSection: 500,
    searchResults: 200,
    // Merged YouTube row on the home page, newest first across every channel.
    youtubeRow: 40
};

// Channels bundled with the app, appended to whatever the sources return.
const HARDCODED_CHANNELS = [
    {
        name: 'Hardcoded MBC3 arabic',
        displayName: 'MBC3 arabic',
        logo: 'assets/img/MBC_3.png',
        groups: ['kids'],
        urls: ['https://tgn.bozztv.com/eshgtv-trn09/ga-mchannel3/index.m3u8']
    }
];
