/*
 * YouTube: the followed-channel list in the profile menu, the feeds behind it,
 * and the "Latest on YouTube" row on the home page.
 *
 * Everything here runs off the public Atom feed
 * (`/feeds/videos.xml?channel_id=UC...`) -- no API key and no quota. Two
 * consequences shape the rest of this file:
 *
 *  - The feed sends no CORS header, so every request goes through the Worker.
 *  - It carries the 15 most recent uploads and nothing else. There is no paging,
 *    so "latest videos" is all this can ever be, which is exactly what is wanted.
 *
 * Videos play in an embedded iframe rather than the site's own <video>: YouTube
 * serves no manifest a browser may attach to, so hls.js and dashjs are no use
 * here. The iframe is driven through the IFrame Player API and wrapped in the
 * live-TV player's own chrome, so the two players match; player.js itself is not
 * reused because every one of its controls talks to a <video> element.
 */

/* A channel id is always `UC` followed by 22 url-safe base64 characters. */
const YT_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

// videoId -> video, so a card click can find its metadata without embedding it.
const ytVideosById = new Map();

// Guards against a feed load landing after the user has navigated away.
let ytRenderToken = 0;

// The row as rendered, in order. Backs the player's "up next" carousel and the
// roll-on when a video ends.
let ytRowVideos = [];

/* --- Input -> channel id ---------------------------------------------------
 *
 * People paste whatever the address bar gave them, so accept the lot: a bare id,
 * /channel/UC..., an @handle, the legacy /c/ and /user/ paths, and even a link to
 * one of the channel's videos.
 */
function parseYouTubeInput(raw) {
    const input = String(raw || '').trim();
    if (!input) return null;

    if (YT_ID_RE.test(input)) return { kind: 'id', id: input };

    // A bare handle, typed without any surrounding URL.
    if (input.startsWith('@')) return { kind: 'page', url: `https://www.youtube.com/${input}` };

    /*
     * A single word with no dot and no slash is a handle typed without its @.
     * This has to come before the URL parse: `new URL('https://mkbhd')` succeeds
     * with `mkbhd` as the hostname, so left to the parser it would be rejected as
     * a non-YouTube host rather than recognised as a handle.
     */
    if (/^[A-Za-z0-9_-]{3,}$/.test(input)) {
        return { kind: 'page', url: `https://www.youtube.com/@${input}` };
    }

    let url;
    try {
        url = new URL(input.includes('://') ? input : `https://${input}`);
    } catch (e) {
        return null;
    }

    const host = url.hostname.replace(/^www\./, '');
    if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') return null;

    const direct = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})/);
    if (direct) return { kind: 'id', id: direct[1] };

    // /@handle, /c/name, /user/name and /watch?v= all end up the same way: fetch
    // the page and read the channel id out of it.
    return { kind: 'page', url: url.toString() };
}

function ytProxied(targetUrl) {
    return YOUTUBE.proxy + encodeURIComponent(targetUrl);
}

/*
 * Digs the channel id out of a fetched YouTube page.
 *
 * Order matters. On a channel page the canonical link is authoritative, while
 * the first `"channelId"` in the markup belongs to whatever channel the sidebar
 * happens to be recommending -- following that adds the wrong channel. On a
 * watch page there is no channel canonical, and there the first `"channelId"`
 * *is* the uploader, so it is the right fallback rather than the first choice.
 */
function extractChannelId(html) {
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/channel\/(UC[A-Za-z0-9_-]{22})/);
    if (canonical) return canonical[1];

    const embedded = html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/);
    return embedded ? embedded[1] : null;
}

async function resolveChannelId(input) {
    const parsed = parseYouTubeInput(input);
    if (!parsed) throw new Error('Not a YouTube channel link, @handle or UC… id.');
    if (parsed.kind === 'id') return parsed.id;

    const response = await fetch(ytProxied(parsed.url));
    if (response.status === 404) throw new Error('No such channel on YouTube.');
    if (!response.ok) throw new Error(`YouTube responded ${response.status}.`);

    const id = extractChannelId(await response.text());
    if (!id) throw new Error('Could not find a channel on that page.');
    return id;
}

/* --- Feeds ---------------------------------------------------------------- */

/* Returns the first direct child with this qualified tag name. */
function directChild(parent, tagName) {
    for (const child of parent.children) {
        if (child.tagName === tagName) return child;
    }
    return null;
}

function childText(parent, tagName) {
    const node = directChild(parent, tagName);
    return node ? node.textContent.trim() : '';
}

/*
 * The feed is namespaced Atom. Parsed as XML, `getElementsByTagName` matches on
 * the qualified name, so the `yt:` and `media:` prefixes are used verbatim --
 * which is why this never needs a namespace lookup table.
 */
function parseFeed(xmlText, channelId) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('Malformed feed');

    const root = doc.documentElement;
    if (!root || root.tagName !== 'feed') throw new Error('Not a YouTube feed');

    const channelName = childText(root, 'title') || 'YouTube';

    const videos = Array.from(root.getElementsByTagName('entry')).map(entry => {
        // `<id>` reads `yt:video:VIDEOID`, which needs no namespace handling.
        const rawId = childText(entry, 'id');
        const id = (childText(entry, 'yt:videoId') || rawId.replace(/^yt:video:/, '')).trim();
        if (!id) return null;

        const link = directChild(entry, 'link');
        const href = link ? link.getAttribute('href') || '' : '';

        const group = directChild(entry, 'media:group');
        const stats = group ? group.getElementsByTagName('media:statistics')[0] : null;

        return {
            id,
            channelId,
            channelName,
            title: childText(entry, 'title') || '(untitled)',
            published: childText(entry, 'published'),
            // hqdefault is 480x360 with letterbox bars; the card crops them off
            // with object-fit: cover, leaving a sharper image than mqdefault.
            thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            // Nothing in the feed marks a Short -- only the link it carries does.
            isShort: href.includes('/shorts/'),
            views: stats ? Number(stats.getAttribute('views')) || 0 : 0
        };
    }).filter(Boolean);

    return { channelName, videos };
}

/* --- Feed cache ---
 *
 * Without this every home render would re-fetch every channel through the
 * Worker. The feed only moves when someone uploads, so half an hour of staleness
 * costs nothing and keeps a page refresh free.
 */
function readFeedCache() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.youtubeCache));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
        return {};
    }
}

function writeFeedCache(cache) {
    try {
        localStorage.setItem(STORAGE_KEYS.youtubeCache, JSON.stringify(cache));
    } catch (e) {
        // A full quota is not worth failing the render over.
        console.warn('Could not cache YouTube feeds.', e);
    }
}

function dropFromFeedCache(channelId) {
    const cache = readFeedCache();
    delete cache[channelId];
    writeFeedCache(cache);
}

async function fetchChannelFeed(channelId, { force = false } = {}) {
    const cache = readFeedCache();
    const hit = cache[channelId];
    if (!force && hit && Date.now() - hit.at < YOUTUBE.cacheTtlMs) return hit.videos;

    const response = await fetch(ytProxied(YOUTUBE.feedBase + channelId));
    if (!response.ok) throw new Error(`Feed responded ${response.status}`);

    const { channelName, videos } = parseFeed(await response.text(), channelId);

    // Store the full feed -- the channel circles pick a random recent video from
    // it, which needs more depth than the row draws.
    cache[channelId] = { at: Date.now(), name: channelName, videos };
    writeFeedCache(cache);
    return videos;
}

/* Everything cached for a channel, newest first. */
function cachedChannelVideos(channelId) {
    const hit = readFeedCache()[channelId];
    return hit && Array.isArray(hit.videos) ? hit.videos : [];
}

/* Runs the feed fetches a few at a time: each one is a Worker request. */
async function fetchAllFeeds(channels, options) {
    const results = [];
    const queue = channels.slice();

    const worker = async () => {
        while (queue.length > 0) {
            const channel = queue.shift();
            try {
                const videos = await fetchChannelFeed(channel.id, options);
                results.push(...videos.slice(0, YOUTUBE.perChannel));
            } catch (e) {
                console.warn(`YouTube feed failed for ${channel.name || channel.id}`, e);
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(YOUTUBE.concurrency, channels.length) }, worker)
    );
    return results;
}

/* --- The home row --------------------------------------------------------- */

const byNewest = (a, b) => new Date(b.published) - new Date(a.published);

/*
 * Merges the channels into one row without letting the busiest one own it.
 *
 * Sorting the pooled videos by date alone does not work: a channel that uploads
 * every hour has its whole slice timestamped within the last few hours, so it
 * takes every slot at the front and a channel that posts weekly is pushed off
 * the end of the row entirely -- the opposite of what following it meant.
 *
 * So videos are dealt out in rounds, one per channel, and only sorted *within* a
 * round. Every channel is guaranteed its newest upload in the first round, its
 * second in the next, and so on, whatever its upload rate. The row still opens
 * with the newest video overall, because round one holds every channel's latest.
 */
function interleaveByChannel(videos) {
    const queues = new Map();
    for (const video of videos) {
        if (!queues.has(video.channelId)) queues.set(video.channelId, []);
        queues.get(video.channelId).push(video);
    }

    const pending = Array.from(queues.values());
    pending.forEach(queue => queue.sort(byNewest));

    const merged = [];
    while (pending.some(queue => queue.length > 0)) {
        const round = pending.filter(queue => queue.length > 0).map(queue => queue.shift());
        round.sort(byNewest);
        merged.push(...round);
    }
    return merged;
}

function relativeTime(iso) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';

    const minutes = Math.round((Date.now() - then) / 60000);
    if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    if (days < 31) return `${Math.round(days / 7)}w ago`;
    if (days < 365) return `${Math.round(days / 30)}mo ago`;
    return `${Math.round(days / 365)}y ago`;
}

function formatViews(count) {
    if (!count) return '';
    if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M views`;
    if (count >= 1e3) return `${Math.round(count / 1e3)}K views`;
    return `${count} views`;
}

function videoCaption(video) {
    const meta = [relativeTime(video.published), formatViews(video.views)].filter(Boolean).join(' \u00b7 ');
    return `
        ${video.isShort ? '<span class="yt-short-badge">SHORT</span>' : ''}
        <div class="yt-play"><i class="fas fa-play"></i></div>
        <div class="card-info">
            <div class="yt-title">${escapeHtml(video.title)}</div>
            <div class="yt-meta">
                <span class="yt-channel">${escapeHtml(video.channelName)}</span>
                ${meta ? `<span class="yt-age">${escapeHtml(meta)}</span>` : ''}
            </div>
        </div>`;
}

/*
 * A ranked card, in the shape Netflix uses for its Top 10: an oversized outlined
 * numeral with the thumbnail tucked against it. The rank is decoration, so it is
 * hidden from assistive tech -- the title already carries the meaning.
 */
function createTop10CardHtml(video, rank) {
    return `
    <div class="card yt-card yt-top10" data-yt-id="${escapeAttr(video.id)}">
        <span class="yt-rank${rank >= 10 ? ' wide' : ''}" aria-hidden="true">${rank}</span>
        <div class="yt-top10-thumb" style="background: ${getGradient(video.title)}">
            <img src="${escapeAttr(video.thumb)}" onerror="this.style.display='none'" loading="lazy"
                 alt="${escapeAttr(video.title)}">
            ${videoCaption(video)}
        </div>
    </div>`;
}

/*
 * Called from renderAllSections, straight after the favourites row. The section
 * is written synchronously so it holds its place in the page while the feeds are
 * still in flight; the cards drop in when they arrive.
 */
function renderYouTubeRow() {
    if (youtubeChannels.length === 0) return;

    const token = ++ytRenderToken;
    const rowId = 'row-youtube';

    document.getElementById('app-content').insertAdjacentHTML('beforeend', `
        <div class="section-title" id="yt-section-title">
            <i class="fab fa-youtube" style="color:#ff0000"></i> Top 10 on YouTube
            <button class="yt-refresh-btn" onclick="refreshYouTubeRow()" title="Refresh feeds">
                <i class="fas fa-rotate-right"></i>
            </button>
        </div>
        <div class="row-container" id="yt-row-container">
            <button class="scroll-btn left" data-scroll="-1" data-row="${rowId}"><i class="fas fa-chevron-left"></i></button>
            <div class="row yt-top10-row" id="${rowId}">
                <div class="yt-row-message"><i class="fas fa-circle-notch fa-spin"></i> Loading latest videos…</div>
            </div>
            <button class="scroll-btn right" data-scroll="1" data-row="${rowId}"><i class="fas fa-chevron-right"></i></button>
        </div>`);

    fillYouTubeRow(token, rowId, { force: false });
}

async function fillYouTubeRow(token, rowId, options) {
    let videos = [];
    try {
        videos = await fetchAllFeeds(youtubeChannels, options);
    } catch (e) {
        console.error(e);
    }

    // The user navigated away, or the home page was re-rendered underneath us.
    if (token !== ytRenderToken) return;
    const row = document.getElementById(rowId);
    if (!row || !row.isConnected) return;

    if (hideShorts) videos = videos.filter(v => !v.isShort);
    videos = interleaveByChannel(videos).slice(0, YOUTUBE.topCount);

    videos.forEach(v => ytVideosById.set(v.id, v));
    ytRowVideos = videos;

    if (videos.length === 0) {
        row.innerHTML = '<div class="yt-row-message">No videos found. Check the channels in your profile.</div>';
        return;
    }
    row.innerHTML = videos.map((v, i) => createTop10CardHtml(v, i + 1)).join('');
}

/* --- Channel circles ---
 *
 * One circle per followed channel, under the Top 10. Clicking it plays a random
 * recent upload from that channel rather than a specific one, so the row works
 * as a "give me something from them" control.
 */
function renderYouTubeChannelsRow() {
    if (youtubeChannels.length === 0) return;

    const rowId = 'row-yt-channels';
    document.getElementById('app-content').insertAdjacentHTML('beforeend', `
        <div class="section-title">My Channels</div>
        <div class="row-container">
            <button class="scroll-btn left" data-scroll="-1" data-row="${rowId}"><i class="fas fa-chevron-left"></i></button>
            <div class="row yt-circle-row" id="${rowId}">
                ${youtubeChannels.map(createChannelCircleHtml).join('')}
            </div>
            <button class="scroll-btn right" data-scroll="1" data-row="${rowId}"><i class="fas fa-chevron-right"></i></button>
        </div>`);

    ensureChannelAvatars();
}

function createChannelCircleHtml(channel) {
    const initial = (channel.name || '?').trim().charAt(0).toUpperCase();
    return `
    <div class="yt-circle" data-yt-channel="${escapeAttr(channel.id)}"
         title="Play something recent from ${escapeAttr(channel.name)}">
        <div class="yt-circle-img" style="background: ${getGradient(channel.name)}">
            ${channel.avatar
                ? `<img src="${escapeAttr(channel.avatar)}" alt="${escapeAttr(channel.name)}" loading="lazy" onerror="this.remove()">`
                : `<span class="yt-circle-initial">${escapeHtml(initial)}</span>`}
            <div class="yt-circle-overlay"><i class="fas fa-shuffle"></i></div>
        </div>
        <div class="yt-circle-name">${escapeHtml(channel.name)}</div>
    </div>`;
}

/*
 * Avatars are not in the feed, so each one costs a channel-page fetch. Done once
 * per channel and stored alongside the name, one at a time so a long list does
 * not fire a dozen multi-megabyte requests at the Worker at once.
 */
async function ensureChannelAvatars() {
    const queue = youtubeChannels.filter(c => !c.avatar);
    if (queue.length === 0) return;

    const worker = async () => {
        while (queue.length > 0) {
            const channel = queue.shift();
            try {
                const response = await fetch(ytProxied(`https://www.youtube.com/channel/${channel.id}`));
                if (!response.ok) continue;

                const avatar = extractChannelAvatar(await response.text());
                if (!avatar) continue;

                channel.avatar = avatar;
                saveYouTubeChannels();
                repaintChannelCircle(channel);
            } catch (e) {
                // The initial stands in perfectly well; not worth retrying here.
            }
        }
    };

    // A channel page is a couple of megabytes, so this stays deliberately narrow.
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
}

function extractChannelAvatar(html) {
    const og = html.match(/<meta property="og:image" content="([^"]+)"/);
    const embedded = html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/);
    const url = (og && og[1]) || (embedded && embedded[1]);
    // The page advertises a 900px avatar; the circle renders at ~96px.
    return url ? url.replace(/=s\d+-/, '=s176-') : null;
}

function repaintChannelCircle(channel) {
    const circle = document.querySelector(`.yt-circle[data-yt-channel="${channel.id}"] .yt-circle-img`);
    if (!circle || !channel.avatar) return;
    const initial = circle.querySelector('.yt-circle-initial');
    if (initial) initial.remove();
    if (circle.querySelector('img')) return;

    const img = document.createElement('img');
    img.src = channel.avatar;
    img.alt = channel.name;
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    circle.prepend(img);
}

/* --- Random play from one channel --- */

/* Uploads recent enough to be worth surfacing, newest first. */
function recentChannelVideos(channelId) {
    let videos = cachedChannelVideos(channelId);
    if (hideShorts) videos = videos.filter(v => !v.isShort);

    const cutoff = Date.now() - YOUTUBE.randomMaxAgeDays * 24 * 60 * 60 * 1000;
    const recent = videos.filter(v => new Date(v.published).getTime() >= cutoff);

    // A channel that posts rarely may have nothing inside the window at all;
    // its newest few beat showing the user an error.
    return recent.length > 0 ? recent : videos.slice(0, 5);
}

async function openRandomChannelVideo(channelId) {
    const channel = youtubeChannels.find(c => c.id === channelId);
    const name = channel ? channel.name : 'this channel';

    // The circle may be clicked before the row's feeds have landed.
    if (cachedChannelVideos(channelId).length === 0) {
        showToast(`Loading ${name}…`);
        try { await fetchChannelFeed(channelId); } catch (e) { /* reported below */ }
    }

    let pool = recentChannelVideos(channelId);
    if (pool.length === 0) {
        showToast(`No recent videos found for ${name}.`);
        return;
    }

    // Never serve the same video twice in a row while alternatives exist.
    if (ytCurrentVideo && pool.length > 1) pool = pool.filter(v => v.id !== ytCurrentVideo.id);

    const pick = pool[Math.floor(Math.random() * pool.length)];
    ytVideosById.set(pick.id, pick);
    openYouTubeVideo(pick.id, channelId);
}

/* The "next" button, and where a finished video goes in shuffle mode. */
function nextRandomChannelVideo() {
    if (ytShuffleChannel) openRandomChannelVideo(ytShuffleChannel);
}

/* Toolbar button: bypasses the cache and re-reads every feed. */
function refreshYouTubeRow() {
    const row = document.getElementById('row-youtube');
    if (!row) return;

    row.innerHTML = '<div class="yt-row-message"><i class="fas fa-circle-notch fa-spin"></i> Refreshing…</div>';
    fillYouTubeRow(++ytRenderToken, 'row-youtube', { force: true });
}

/* --- Video playback ---
 *
 * The video is an iframe -- YouTube publishes no manifest hls.js or dashjs could
 * attach to -- but it is driven through the IFrame Player API and dressed in the
 * live-TV player's own chrome (.video-modal, .player-overlay, .control-btn), so
 * both players look and behave alike. YouTube's native controls are switched off
 * (`controls: 0`) precisely so there is only ever one set of controls on screen.
 */

let ytPlayer = null;
let ytApiPromise = null;
let ytCurrentVideo = null;
let ytCaptionsOn = true;
let ytCaptionTimer = null;
// Set when playback came from a channel circle: the player then offers "next"
// and rolls on to another random upload from that same channel.
let ytShuffleChannel = null;

/* Loads the IFrame API once, on first play, rather than on every page load. */
function loadYouTubeApi() {
    if (ytApiPromise) return ytApiPromise;

    ytApiPromise = new Promise((resolve) => {
        if (window.YT && window.YT.Player) return resolve(window.YT);

        // The API calls this global when it is ready; there is no other hook.
        window.onYouTubeIframeAPIReady = () => resolve(window.YT);
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(script);
    });
    return ytApiPromise;
}

async function openYouTubeVideo(videoId, shuffleChannelId = null) {
    const video = ytVideosById.get(videoId) || null;
    ytCurrentVideo = video;

    // Opening a specific video (a card, the carousel) leaves shuffle mode.
    ytShuffleChannel = shuffleChannelId;
    document.getElementById('ytNextBtn').style.display = shuffleChannelId ? '' : 'none';

    document.getElementById('ytPlayerTitle').innerText = video ? video.title : 'YouTube';
    document.getElementById('ytExternalLink').href = YOUTUBE.watchBase + videoId;
    document.getElementById('youtubeModal').style.display = 'flex';
    setWatchTimerFloating(true);
    setYouTubeStatus('Loading…');

    flashYouTubeTopBar();
    hintArabicAudio();

    // A new video brings its own caption tracks; clear the previous verdict.
    clearTimeout(ytCaptionTimer);
    document.getElementById('ytCcBtn').classList.remove('unavailable');
    document.getElementById('ytCcBtn').classList.toggle('active', ytCaptionsOn);
    renderYouTubeCarousel();

    // The site player and this one must never sound at once.
    document.getElementById('hero-video-bg').muted = true;
    document.getElementById('heroMuteIcon').className = 'fas fa-volume-mute';

    const YT = await loadYouTubeApi();

    // Reuse the instance across videos: recreating the iframe each time would
    // re-handshake with YouTube and blank the player for a second.
    if (ytPlayer && ytPlayer.loadVideoById) {
        ytPlayer.loadVideoById(videoId);
        return;
    }

    ytPlayer = new YT.Player('ytFrame', {
        videoId,
        /*
         * The default host (www.youtube.com) is used deliberately rather than
         * youtube-nocookie.com: signed-in cookies travel with it, and a YouTube
         * account whose language is Arabic is the one thing that makes a dub
         * come up on its own.
         */
        playerVars: {
            autoplay: 1,
            /*
             * Left ON. The audio-track selector lives in YouTube's own settings
             * menu, and there is no other route to it: `setAudioTrack` exists on
             * YouTube's internal player, but the IFrame API's postMessage bridge
             * does not accept it from a cross-origin parent -- measured, the
             * track stays put. Switching these off took the Arabic dub away.
             */
            controls: 1,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3,  // no annotation cards over the picture
            cc_load_policy: 1,  // captions on from the first frame
            cc_lang_pref: YOUTUBE.captionLang,
            // UI language only; subtitles are set by cc_lang_pref above.
            hl: YOUTUBE.uiLang,
            origin: window.location.origin
        },
        events: {
            onReady: onYouTubePlayerReady,
            onStateChange: onYouTubePlayerState,
            onError: onYouTubePlayerError
        }
    });
}

function onYouTubePlayerReady(e) {
    e.target.playVideo();
    scheduleArabicCaptions();
}

function onYouTubePlayerState(e) {
    const YT = window.YT;
    if (e.data === YT.PlayerState.PLAYING) {
        setYouTubeStatus('');
        // A newly loaded video brings its own caption tracks with it.
        scheduleArabicCaptions();
    }
    if (e.data === YT.PlayerState.ENDED) {
        if (ytShuffleChannel) nextRandomChannelVideo();
        else playNextYouTubeVideo();
    }
}

/*
 * Embedding is the uploader's choice, and a refusal surfaces here rather than
 * anywhere the API can pre-empt. 101/150 are the "embedding disabled" codes.
 */
function onYouTubePlayerError(e) {
    const blocked = e.data === 101 || e.data === 150;
    setYouTubeStatus(blocked
        ? 'This video cannot be embedded. Use "Open on YouTube" below.'
        : `Playback error (${e.data}).`);
}

/* --- Arabic subtitles ---
 *
 * Caption tracks load lazily, a second or more after the player reports ready,
 * so a single attempt usually finds an empty tracklist. This retries until the
 * module answers, then stops.
 */
function scheduleArabicCaptions(attempt = 0) {
    clearTimeout(ytCaptionTimer);
    if (!ytCaptionsOn) return;

    /*
     * Give up after ~25s. Caption tracks can appear well over ten seconds after
     * playback starts, and a video that simply has none never reports any -- so
     * this has to be patient, and has to stop.
     */
    if (attempt > 24) {
        markCaptionsUnavailable();
        return;
    }

    ytCaptionTimer = setTimeout(() => {
        const result = applyArabicCaptions();
        if (result === 'pending') return scheduleArabicCaptions(attempt + 1);
        if (result === 'none') return markCaptionsUnavailable();
        // Applied: light the button back up in case a previous video had none.
        document.getElementById('ytCcBtn').classList.remove('unavailable');
        document.getElementById('ytCcBtn').classList.add('active');
    }, attempt === 0 ? 700 : 1000);
}

/*
 * Not every video has captions -- plenty are published with none at all, and
 * nothing on our side can conjure them. Say so on the button rather than leaving
 * it lit as though Arabic were on.
 */
function markCaptionsUnavailable() {
    const button = document.getElementById('ytCcBtn');
    if (!button) return;
    button.classList.remove('active');
    button.classList.add('unavailable');
}

function applyArabicCaptions() {
    if (!ytPlayer || !ytPlayer.getOption) return 'pending';

    try {
        ytPlayer.setOption('captions', 'reload', true);
        const tracks = ytPlayer.getOption('captions', 'tracklist') || [];
        if (tracks.length === 0) return 'pending';

        // A track the uploader actually published in Arabic always wins.
        const native = tracks.find(t => t.languageCode === YOUTUBE.captionLang);
        if (native) {
            ytPlayer.setOption('captions', 'track', native);
            return 'native';
        }

        /*
         * Otherwise have YouTube auto-translate. The translation only takes when
         * `translationLanguage` is attached to the *track object* and that object
         * is written back: setting it as a standalone option is accepted and then
         * silently ignored, which is why this is not a one-liner.
         */
        const current = ytPlayer.getOption('captions', 'track');
        const base = (current && current.languageCode)
            ? current
            : tracks.find(t => t.is_translateable) || tracks[0];
        if (!base) return 'none';

        base.translationLanguage = { languageCode: YOUTUBE.captionLang };
        ytPlayer.setOption('captions', 'track', base);
        return 'translated';
    } catch (err) {
        return 'pending';
    }
}

function toggleArabicCaptions() {
    if (!ytPlayer) return;
    ytCaptionsOn = !ytCaptionsOn;

    const button = document.getElementById('ytCcBtn');
    button.classList.toggle('active', ytCaptionsOn);

    if (ytCaptionsOn) {
        scheduleArabicCaptions();
        showToast('Arabic subtitles on');
    } else {
        try { ytPlayer.setOption('captions', 'track', {}); } catch (err) { /* already off */ }
        showToast('Subtitles off');
    }
}

/* --- Controls ---
 *
 * YouTube's bar owns volume, speed, quality, captions and fullscreen now, so
 * only what the keyboard shortcuts need is kept here. These API calls keep
 * working with `controls: 1`; `setAudioTrack` is the only one that does not.
 */
function toggleYouTubePlay() {
    if (!ytPlayer || !ytPlayer.getPlayerState) return;
    if (ytPlayer.getPlayerState() === window.YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
}

function seekYouTubeBy(seconds) {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return;
    ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() + seconds), true);
    showToast(`${seconds > 0 ? '+' : ''}${seconds}s`);
}

function toggleYouTubeFullscreen() {
    const wrapper = document.getElementById('ytWrapper');
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapper.requestFullscreen();
}

/* --- "Up next" carousel, mirroring the favourites carousel in the TV player --- */
function toggleYouTubeCarousel() {
    const carousel = document.getElementById('ytCarousel');
    const icon = document.getElementById('ytCarouselIcon');

    if (carousel.classList.contains('open')) {
        carousel.classList.remove('open');
        icon.className = 'fas fa-chevron-down';
        return;
    }
    renderYouTubeCarousel();
    carousel.classList.add('open');
    icon.className = 'fas fa-chevron-up';
}

function renderYouTubeCarousel() {
    const track = document.getElementById('ytCarouselList');
    track.innerHTML = '';

    if (ytRowVideos.length === 0) {
        track.innerHTML = '<div style="color:#aaa; width:100%; text-align:center;">No other videos loaded.</div>';
        return;
    }

    ytRowVideos.forEach(video => {
        const isActive = Boolean(ytCurrentVideo) && ytCurrentVideo.id === video.id;

        const card = document.createElement('div');
        card.className = `carousel-card ${isActive ? 'active' : ''}`;
        card.style.background = getGradient(video.title);
        card.innerHTML = `
            <img src="${escapeAttr(video.thumb)}" onerror="this.style.display='none'" loading="lazy" alt="${escapeAttr(video.title)}">
            <div class="carousel-card-info">
                <span class="carousel-name">${escapeHtml(video.title)}</span>
            </div>`;

        card.onclick = (e) => { e.stopPropagation(); openYouTubeVideo(video.id); };
        track.appendChild(card);

        if (isActive) {
            setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }), 100);
        }
    });
}

/* Rolls on to the next video in the row when one finishes. */
function playNextYouTubeVideo() {
    if (!ytCurrentVideo) return;
    const index = ytRowVideos.findIndex(v => v.id === ytCurrentVideo.id);
    const next = ytRowVideos[index + 1];
    if (next) openYouTubeVideo(next.id);
}

/* --- Open / close --- */
function closeYouTubeModal(e) {
    // Ignore clicks that bubbled up from inside the player chrome.
    if (e && e.target !== document.getElementById('youtubeModal')) return;

    // stopVideo, not just hiding the modal: a hidden iframe keeps playing audio.
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    clearTimeout(ytCaptionTimer);

    setYouTubeStatus('');
    document.getElementById('youtubeModal').style.display = 'none';
    setWatchTimerFloating(false);
    document.getElementById('ytCarousel').classList.remove('open');
    document.getElementById('ytCarouselIcon').className = 'fas fa-chevron-down';
    hideYouTubeTopBar();
    ytCurrentVideo = null;
    ytShuffleChannel = null;
    if (document.fullscreenElement) document.exitFullscreen();
}

function isYouTubeModalOpen() {
    const modal = document.getElementById('youtubeModal');
    return Boolean(modal) && modal.style.display === 'flex';
}

/* A one-line note under the title, matching the TV player's failover message. */
function setYouTubeStatus(message) {
    const el = document.getElementById('ytStatus');
    if (!el) return;
    el.innerText = message || '';
    el.classList.toggle('show', Boolean(message));
}

/*
 * Reveals our top bar on approach, and keeps it out of the way otherwise.
 *
 * It used to sit there permanently, and YouTube's settings menu -- where the
 * audio track is chosen -- opens upward from the bottom-right and reaches into
 * that band, so our bar covered the very control this player exists to expose.
 *
 * Proximity cannot be measured with mousemove here: the iframe swallows mouse
 * events, so the wrapper hears nothing at all once the pointer is over the
 * video. The bar is therefore its own hot zone -- an element at `opacity: 0`
 * still receives pointer events, so entering and leaving it is the signal.
 */
function initYouTubeTopBar() {
    const bar = document.querySelector('#ytOverlay .player-top');

    /*
     * `mouseleave` is the natural signal but cannot be relied on alone: crossing
     * from the bar straight into the iframe does not always deliver one, and the
     * bar then stays open over YouTube's controls -- measured. So every pointer
     * event on the bar also re-arms a timeout, and that is what actually
     * guarantees it goes away.
     */
    bar.addEventListener('mouseenter', showYouTubeTopBar);
    bar.addEventListener('mousemove', showYouTubeTopBar);
    bar.addEventListener('mouseleave', hideYouTubeTopBar);
}

let ytTopBarTimer = null;

function showYouTubeTopBar(holdMs = 1500) {
    document.getElementById('ytWrapper').classList.add('yt-show-top');
    clearTimeout(ytTopBarTimer);
    ytTopBarTimer = setTimeout(hideYouTubeTopBar, typeof holdMs === 'number' ? holdMs : 1500);
}

function hideYouTubeTopBar() {
    clearTimeout(ytTopBarTimer);
    document.getElementById('ytWrapper').classList.remove('yt-show-top');
}

/*
 * Shows the bar for a moment when a video opens, so the title and the way back
 * are seen at least once before the picture is left clear.
 */
function flashYouTubeTopBar() {
    showYouTubeTopBar(3500);
}

/*
 * Points the viewer at the audio-track menu, once per session.
 *
 * Nothing here can switch the dub, so the one useful thing to do is say where
 * the control is. Shown once so it does not nag on every video.
 */
let ytAudioHintShown = false;
function hintArabicAudio() {
    if (ytAudioHintShown) return;
    ytAudioHintShown = true;
    setTimeout(() => {
        if (!isYouTubeModalOpen()) return;
        setYouTubeStatus('For Arabic audio: YouTube\u2019s \u2699 menu \u2192 Audio track \u2192 العربية');
        setTimeout(() => setYouTubeStatus(''), 7000);
    }, 3500);
}

/* --- Profile modal -------------------------------------------------------- */

function openProfileModal() {
    document.getElementById('profileModal').style.display = 'flex';
    setYouTubeFormStatus('');
    document.getElementById('hideShortsPill').classList.toggle('on', hideShorts);
    refreshYouTubeChannelList();
}

function closeProfileModal(e) {
    if (e && e.target !== document.getElementById('profileModal')) return;
    document.getElementById('profileModal').style.display = 'none';
}

function setYouTubeFormStatus(message, kind = '') {
    const el = document.getElementById('youtubeFormStatus');
    if (!el) return;
    el.innerHTML = message || '';
    el.className = `yt-form-status${kind ? ' ' + kind : ''}${message ? ' show' : ''}`;
}

function refreshYouTubeChannelList() {
    const list = document.getElementById('youtubeChannelList');
    if (!list) return;

    if (youtubeChannels.length === 0) {
        list.innerHTML = '<div class="yt-empty">No channels yet. Add one above and their latest videos appear on the home page.</div>';
        return;
    }

    list.innerHTML = youtubeChannels.map(channel => `
        <div class="collection-item yt-channel-item">
            <div class="yt-channel-avatar" style="background: ${getGradient(channel.name)}">
                ${escapeHtml((channel.name || '?').trim().charAt(0).toUpperCase())}
            </div>
            <div class="yt-channel-text">
                <div class="yt-channel-name">${escapeHtml(channel.name)}</div>
                <a class="yt-channel-id" href="https://www.youtube.com/channel/${escapeAttr(channel.id)}"
                   target="_blank" rel="noopener">${escapeHtml(channel.id)}</a>
            </div>
            <button class="yt-remove-btn" data-yt-remove="${escapeAttr(channel.id)}" title="Remove channel">
                <i class="fas fa-trash"></i>
            </button>
        </div>`).join('');
}

async function addYouTubeChannel() {
    const input = document.getElementById('youtubeChannelInput');
    const button = document.getElementById('youtubeAddBtn');
    const raw = input.value.trim();
    if (!raw) return;

    button.disabled = true;
    setYouTubeFormStatus('<i class="fas fa-circle-notch fa-spin"></i> Looking up channel…');

    try {
        const id = await resolveChannelId(raw);

        if (youtubeChannels.some(c => c.id === id)) {
            setYouTubeFormStatus('That channel is already in your list.', 'warn');
            return;
        }

        // Reading the feed both proves the id is real and gives the channel its
        // display name -- the feed is the only place that name is available.
        dropFromFeedCache(id);
        await fetchChannelFeed(id, { force: true });
        const name = readFeedCache()[id]?.name || id;

        youtubeChannels.push({ id, name });
        saveYouTubeChannels();

        input.value = '';
        setYouTubeFormStatus(`Added ${escapeHtml(name)}.`, 'ok');
        refreshYouTubeChannelList();
        if (currentView === 'home') refreshCurrentView();
    } catch (e) {
        setYouTubeFormStatus(escapeHtml(e.message || 'Could not add that channel.'), 'error');
    } finally {
        button.disabled = false;
    }
}

function removeYouTubeChannel(id) {
    const channel = youtubeChannels.find(c => c.id === id);
    youtubeChannels = youtubeChannels.filter(c => c.id !== id);
    saveYouTubeChannels();
    dropFromFeedCache(id);

    refreshYouTubeChannelList();
    setYouTubeFormStatus(channel ? `Removed ${escapeHtml(channel.name)}.` : '', 'ok');
    if (currentView === 'home') refreshCurrentView();
}

function toggleHideShorts() {
    setHideShorts(!hideShorts);
    document.getElementById('hideShortsPill').classList.toggle('on', hideShorts);
    if (currentView === 'home') refreshCurrentView();
}

/* One delegated handler for the channel list, so ids never go into onclick. */
function initYouTube() {
    document.getElementById('youtubeChannelList').addEventListener('click', (e) => {
        const button = e.target.closest('[data-yt-remove]');
        if (button) removeYouTubeChannel(button.dataset.ytRemove);
    });
}
