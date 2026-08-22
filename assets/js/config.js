/* Static configuration. Everything tunable lives here. */

// Live TV playlist (iptv-org).
const REPO_URL = 'https://iptv-org.github.io/iptv/index.m3u';

// Sections built from the playlist's `group-title` values.
const STANDARD_SECTIONS = ['News', 'Kids', 'Movies', 'Music', 'Series', 'Sports', 'Documentary'];

// The page is served over HTTPS, so plain-HTTP streams must be proxied.
const STREAM_PROXY_ORIGIN = 'https://corsproxy.io/';
const STREAM_PROXY = STREAM_PROXY_ORIGIN + '?';

// Scraped catalogue (Movies / Series) and the read-through proxy used to fetch it.
const CATALOG_BASE_URL = 'https://pelispedia.mov';
const CATALOG_PROXY = 'https://api.allorigins.win/get?url=';

// localStorage keys.
const STORAGE_KEYS = {
    favorites: 'clement_favorites',
    sections: 'clement_custom_sections'
};

// Caps that keep very large listings from freezing the page.
const LIMITS = {
    discoverRow: 50,
    otherSection: 500,
    searchResults: 200
};

// Channels bundled with the app, appended to whatever the playlist returns.
const HARDCODED_CHANNELS = [
    {
        name: 'Hardcoded MBC3 arabic',
        displayName: 'MBC3 arabic',
        logo: 'assets/img/MBC_3.png',
        groups: ['Kids'],
        url: 'https://tgn.bozztv.com/eshgtv-trn09/ga-mchannel3/index.m3u8'
    }
];
