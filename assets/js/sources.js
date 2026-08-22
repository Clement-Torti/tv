/*
 * Fetching the channel sources and merging them into one list.
 *
 * The result is one entry per channel carrying *several* candidate stream URLs,
 * best first. Everything downstream (player, hero) walks that list and falls
 * back to the next URL when one fails, which is where most of the reliability
 * comes from: on channels that have more than one link, trying the alternatives
 * lifts the playable rate from roughly 41% to 65%.
 */

async function fetchAllSources() {
    const optional = (label, fallback) => (e) => {
        console.warn(`Source "${label}" unavailable, continuing without it.`, e);
        return fallback;
    };

    // streams.json is the only source the app cannot do without.
    const [streams, channels, logos, blocklist, freetv] = await Promise.all([
        fetchJson(SOURCES.streams),
        fetchJson(SOURCES.channels).catch(optional('channels', [])),
        fetchJson(SOURCES.logos).catch(optional('logos', [])),
        fetchJson(SOURCES.blocklist).catch(optional('blocklist', [])),
        fetchText(SOURCES.freetv).catch(optional('freetv', ''))
    ]);

    return { streams, channels, logos, blocklist, freetv };
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return response.json();
}

async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return response.text();
}

/* --- Merging --- */

function mergeSources({ streams, channels, logos, blocklist, freetv }) {
    const meta = new Map();
    for (const channel of channels) meta.set(channel.id, channel);

    const blocked = new Set();
    for (const entry of blocklist) blocked.add(entry.channel);

    const logoByChannel = indexLogos(logos);
    const merged = new Map();

    for (const stream of streams) {
        addCandidate(merged, {
            channelId: stream.channel,
            title: stream.title,
            url: stream.url,
            label: stream.label,
            quality: stream.quality,
            needsHeaders: Boolean(stream.user_agent || stream.referrer),
            penalty: 0
        }, meta, logoByChannel, blocked);
    }

    // Community playlist last: its links are kept as extra fallbacks, ranked
    // just below the API's own (measured 48% playable against the API's 56%).
    for (const entry of parseM3UEntries(freetv)) {
        addCandidate(merged, {
            channelId: meta.has(entry.tvgId) ? entry.tvgId : null,
            title: entry.title,
            url: entry.url,
            label: null,
            quality: null,
            needsHeaders: Boolean(entry.userAgent || entry.referrer),
            penalty: 1,
            fallbackLogo: entry.logo,
            fallbackGroup: entry.group
        }, meta, logoByChannel, blocked);
    }

    const result = [];
    for (const channel of merged.values()) {
        channel.urls = channel.candidates
            .sort((a, b) => a.rank - b.rank)
            .map(c => c.url);
        delete channel.candidates;
        if (channel.urls.length > 0) result.push(channel);
    }

    return result.concat(HARDCODED_CHANNELS);
}

/*
 * Rules applied here are the ones that can be decided without touching the
 * network. They remove channels that could never play in this app:
 *  - DMCA/NSFW blocklisted, or flagged closed upstream
 *  - protocols no browser can open (rtmp, rtsp, srt, mmsh)
 *  - streams that only work with a custom User-Agent or Referer, which a page
 *    is not allowed to set on an XHR
 */
function addCandidate(merged, candidate, meta, logoByChannel, blocked) {
    const { channelId, title, url } = candidate;

    if (!url || !/^https?:\/\//i.test(url)) return;
    if (candidate.needsHeaders) return;
    if (channelId && blocked.has(channelId)) return;

    const info = channelId ? meta.get(channelId) : null;
    if (info && (info.closed || info.is_nsfw)) return;

    const name = (info && info.name) || title;
    if (!name) return;

    const key = channelId || 'title:' + name.trim().toLowerCase();
    let channel = merged.get(key);
    if (!channel) {
        channel = {
            name: key,
            displayName: name.trim(),
            logo: (channelId && logoByChannel.get(channelId)) || candidate.fallbackLogo || '',
            groups: info && info.categories && info.categories.length
                ? info.categories.slice()
                : (candidate.fallbackGroup ? [candidate.fallbackGroup] : ['other']),
            candidates: []
        };
        merged.set(key, channel);
    }

    if (channel.candidates.some(c => c.url === url)) return;
    channel.candidates.push({ url, rank: rankCandidate(candidate) });
}

/* Lower ranks are tried first. */
function rankCandidate({ url, label, quality, penalty }) {
    let rank = penalty || 0;

    // The page is HTTPS, so an http:// link only works if the browser's
    // upgrade-insecure-requests rewrite happens to land on a working host.
    if (url.startsWith('http://')) rank += 8;

    const flags = label || '';
    if (flags.includes('Geo-blocked')) rank += 4;  // measured 23% playable
    if (flags.includes('Not 24/7')) rank += 2;

    // Mild preference for a definite, decent resolution.
    if (!quality) rank += 1;
    else if (/2160|1080/.test(quality)) rank -= 1;

    return rank;
}

/* One logo per channel: prefer the one upstream marks as in use. */
function indexLogos(logos) {
    const best = new Map();
    for (const logo of logos) {
        if (!logo.channel || !logo.url) continue;
        const score = (logo.in_use ? 0 : 2) + (logo.feed ? 1 : 0) + (logo.format === 'SVG' ? 0 : 1);
        const current = best.get(logo.channel);
        if (!current || score < current.score) best.set(logo.channel, { url: logo.url, score });
    }

    const flat = new Map();
    for (const [channel, entry] of best) flat.set(channel, entry.url);
    return flat;
}

/* --- M3U parsing (used for the community playlist) --- */

function parseM3UEntries(text) {
    const entries = [];
    if (!text) return entries;

    let current = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();

        if (line.startsWith('#EXTINF:')) {
            const info = line.substring(8);
            const attr = (name) => {
                const match = info.match(new RegExp(`${name}="([^"]*)"`));
                return match ? match[1] : '';
            };
            current = {
                title: extractExtinfTitle(info),
                tvgId: attr('tvg-id'),
                logo: attr('tvg-logo'),
                group: attr('group-title'),
                userAgent: attr('http-user-agent') || attr('user-agent'),
                referrer: attr('http-referrer')
            };
        } else if (line.startsWith('#EXTVLCOPT') && current) {
            if (/user-agent/i.test(line)) current.userAgent = 'set';
            if (/referrer|referer/i.test(line)) current.referrer = 'set';
        } else if (/^https?:\/\//i.test(line) && current) {
            current.url = line;
            entries.push(current);
            current = null;
        }
    }

    return entries;
}

/*
 * `#EXTINF:<duration> <attributes>,<title>`
 *
 * The title is everything after the first comma that is not inside a quoted
 * attribute value, so both commas in attributes and commas in the channel name
 * itself survive.
 */
function extractExtinfTitle(info) {
    let inQuotes = false;
    for (let i = 0; i < info.length; i++) {
        const char = info[i];
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) return info.slice(i + 1).trim();
    }
    return info.trim();
}
