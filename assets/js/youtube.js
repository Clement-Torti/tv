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
    const kept = videos.slice(0, YOUTUBE.perChannel);

    cache[channelId] = { at: Date.now(), name: channelName, videos: kept };
    writeFeedCache(cache);
    return kept;
}

/* Runs the feed fetches a few at a time: each one is a Worker request. */
async function fetchAllFeeds(channels, options) {
    const results = [];
    const queue = channels.slice();

    const worker = async () => {
        while (queue.length > 0) {
            const channel = queue.shift();
            try {
                results.push(...await fetchChannelFeed(channel.id, options));
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

function createVideoCardHtml(video) {
    const meta = [relativeTime(video.published), formatViews(video.views)].filter(Boolean).join(' · ');

    return `
    <div class="card yt-card" data-yt-id="${escapeAttr(video.id)}" style="background: ${getGradient(video.title)}">
        <img src="${escapeAttr(video.thumb)}" onerror="this.style.display='none'" loading="lazy"
             alt="${escapeAttr(video.title)}">
        ${video.isShort ? '<span class="yt-short-badge">SHORT</span>' : ''}
        <div class="yt-play"><i class="fas fa-play"></i></div>
        <div class="card-info">
            <div class="yt-title">${escapeHtml(video.title)}</div>
            <div class="yt-meta">
                <span class="yt-channel">${escapeHtml(video.channelName)}</span>
                ${meta ? `<span class="yt-age">${escapeHtml(meta)}</span>` : ''}
            </div>
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
            <i class="fab fa-youtube" style="color:#ff0000"></i> Latest on YouTube
            <button class="yt-refresh-btn" onclick="refreshYouTubeRow()" title="Refresh feeds">
                <i class="fas fa-rotate-right"></i>
            </button>
        </div>
        <div class="row-container" id="yt-row-container">
            <button class="scroll-btn left" data-scroll="-1" data-row="${rowId}"><i class="fas fa-chevron-left"></i></button>
            <div class="row" id="${rowId}">
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
    videos = interleaveByChannel(videos).slice(0, LIMITS.youtubeRow);

    videos.forEach(v => ytVideosById.set(v.id, v));
    ytRowVideos = videos;

    if (videos.length === 0) {
        row.innerHTML = '<div class="yt-row-message">No videos found. Check the channels in your profile.</div>';
        return;
    }
    row.innerHTML = videos.map(createVideoCardHtml).join('');
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
let ytProgressTimer = null;
let ytCaptionsOn = true;
let ytLastVolume = 1;
let ytMouseTimer = null;
let ytCaptionTimer = null;

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

async function openYouTubeVideo(videoId) {
    const video = ytVideosById.get(videoId) || null;
    ytCurrentVideo = video;

    document.getElementById('ytPlayerTitle').innerText = video ? video.title : 'YouTube';
    document.getElementById('ytExternalLink').href = YOUTUBE.watchBase + videoId;
    document.getElementById('youtubeModal').style.display = 'flex';
    setWatchTimerFloating(true);
    setYouTubeStatus('Loading…');

    // A new video brings its own caption tracks; clear the previous verdict.
    clearTimeout(ytCaptionTimer);
    document.getElementById('ytCcBtn').classList.remove('unavailable');
    document.getElementById('ytCcBtn').classList.toggle('active', ytCaptionsOn);
    renderYouTubeCarousel();
    document.getElementById('ytCarousel').classList.add('open');
    document.getElementById('ytCarouselIcon').className = 'fas fa-chevron-down';

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
        playerVars: {
            autoplay: 1,
            controls: 0,        // our overlay is the only control surface
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            iv_load_policy: 3,  // no annotation cards over the picture
            cc_load_policy: 1,  // captions on from the first frame
            cc_lang_pref: YOUTUBE.captionLang,
            // Arabic UI, and the strongest signal available that this viewer
            // wants the Arabic audio track where the uploader published one.
            hl: YOUTUBE.captionLang,
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
    syncYouTubeVolumeUi(e.target.getVolume() / 100);
    scheduleArabicCaptions();
}

function onYouTubePlayerState(e) {
    const YT = window.YT;
    const playing = e.data === YT.PlayerState.PLAYING;
    updateYouTubeIcons(!playing);

    if (playing) {
        setYouTubeStatus('');
        startYouTubeProgress();
        // A newly loaded video brings its own caption tracks with it.
        scheduleArabicCaptions();
    } else {
        stopYouTubeProgress();
    }
    if (e.data === YT.PlayerState.ENDED) playNextYouTubeVideo();
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

/* --- Controls --- */
function toggleYouTubePlay() {
    if (!ytPlayer || !ytPlayer.getPlayerState) return;
    const playing = ytPlayer.getPlayerState() === window.YT.PlayerState.PLAYING;
    if (playing) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
    updateYouTubeIcons(playing);
}

function updateYouTubeIcons(isPaused) {
    const icon = isPaused ? 'fas fa-play' : 'fas fa-pause';
    document.getElementById('ytCenterIcon').className = icon;
    document.getElementById('ytBottomIcon').className = icon;
}

function seekYouTubeBy(seconds) {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return;
    ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() + seconds), true);
    showToast(`${seconds > 0 ? '+' : ''}${seconds}s`);
}

function seekYouTubeToPercent(value) {
    if (!ytPlayer || !ytPlayer.getDuration) return;
    const duration = ytPlayer.getDuration();
    if (duration > 0) ytPlayer.seekTo((Number(value) / 1000) * duration, true);
}

function adjustYouTubeSpeed(delta) {
    if (!ytPlayer || !ytPlayer.getPlaybackRate) return;
    /*
     * Unlike a <video>, YouTube only accepts rates from a fixed list, so the
     * request is snapped to the nearest one it offers.
     */
    const rates = ytPlayer.getAvailablePlaybackRates() || [1];
    const target = ytPlayer.getPlaybackRate() + delta;
    const nearest = rates.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
    ytPlayer.setPlaybackRate(nearest);
    document.getElementById('ytSpeedDisplay').innerText = nearest.toFixed(2) + 'x';
}

function handleYouTubeVolume(value) {
    if (!ytPlayer || !ytPlayer.setVolume) return;
    const volume = parseFloat(value);
    ytPlayer.setVolume(volume * 100);
    if (volume === 0) ytPlayer.mute(); else ytPlayer.unMute();
    updateYouTubeVolumeIcon(volume);
}

function toggleYouTubeMute() {
    const slider = document.getElementById('ytVolumeSlider');
    const current = parseFloat(slider.value);

    if (current > 0) {
        ytLastVolume = current;
        slider.value = 0;
        handleYouTubeVolume(0);
    } else {
        const target = ytLastVolume > 0 ? ytLastVolume : 0.5;
        slider.value = target;
        handleYouTubeVolume(target);
    }
}

function syncYouTubeVolumeUi(volume) {
    document.getElementById('ytVolumeSlider').value = volume;
    updateYouTubeVolumeIcon(volume);
}

function updateYouTubeVolumeIcon(volume) {
    const icon = document.getElementById('ytVolumeIcon');
    if (volume === 0) icon.className = 'fas fa-volume-mute';
    else if (volume < 0.5) icon.className = 'fas fa-volume-down';
    else icon.className = 'fas fa-volume-up';
}

function toggleYouTubeFullscreen() {
    const wrapper = document.getElementById('ytWrapper');
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapper.requestFullscreen();
}

/* --- Progress --- */
function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

function startYouTubeProgress() {
    stopYouTubeProgress();
    ytProgressTimer = setInterval(() => {
        if (!ytPlayer || !ytPlayer.getDuration) return;
        const duration = ytPlayer.getDuration();
        const elapsed = ytPlayer.getCurrentTime();
        if (!duration) return;

        const slider = document.getElementById('ytProgress');
        // Leave the slider alone while it is being dragged.
        if (document.activeElement !== slider) slider.value = (elapsed / duration) * 1000;
        slider.style.setProperty('--yt-progress', `${(elapsed / duration) * 100}%`);
        document.getElementById('ytElapsed').innerText = formatClock(elapsed);
        document.getElementById('ytDuration').innerText = formatClock(duration);
    }, 500);
}

function stopYouTubeProgress() {
    clearInterval(ytProgressTimer);
    ytProgressTimer = null;
}

/* --- "Up next" carousel, mirroring the favourites carousel in the TV player --- */
function toggleYouTubeCarousel() {
    const carousel = document.getElementById('ytCarousel');
    const icon = document.getElementById('ytCarouselIcon');

    if (carousel.classList.contains('open')) {
        carousel.classList.remove('open');
        icon.className = 'fas fa-chevron-up';
        return;
    }
    renderYouTubeCarousel();
    carousel.classList.add('open');
    icon.className = 'fas fa-chevron-down';
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
    stopYouTubeProgress();
    clearTimeout(ytCaptionTimer);

    setYouTubeStatus('');
    document.getElementById('youtubeModal').style.display = 'none';
    setWatchTimerFloating(false);
    document.getElementById('ytCarousel').classList.remove('open');
    document.getElementById('ytCarouselIcon').className = 'fas fa-chevron-up';
    ytCurrentVideo = null;
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

/* Mirrors togglePlayerControls: on desktop the overlay is hover-driven. */
function toggleYouTubeControls() {
    const overlay = document.getElementById('ytOverlay');
    if (window.innerWidth > 768) return;
    overlay.classList.toggle('show-mobile');
}

function initYouTubePlayerAutoHide() {
    document.getElementById('ytWrapper').addEventListener('mousemove', () => {
        if (window.innerWidth <= 768) return;

        const wrapper = document.getElementById('ytWrapper');
        const overlay = document.getElementById('ytOverlay');
        wrapper.style.cursor = 'default';
        overlay.style.opacity = '1';

        clearTimeout(ytMouseTimer);
        ytMouseTimer = setTimeout(() => {
            if (!ytPlayer || !ytPlayer.getPlayerState) return;
            if (ytPlayer.getPlayerState() !== window.YT.PlayerState.PLAYING) return;
            overlay.style.opacity = '0';
            wrapper.style.cursor = 'none';
        }, 2000);
    });
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
