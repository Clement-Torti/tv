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
 * here. That is why this does not reuse player.js.
 */

/* A channel id is always `UC` followed by 22 url-safe base64 characters. */
const YT_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

// videoId -> video, so a card click can find its metadata without embedding it.
const ytVideosById = new Map();

// Guards against a feed load landing after the user has navigated away.
let ytRenderToken = 0;

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
    videos.sort((a, b) => new Date(b.published) - new Date(a.published));
    videos = videos.slice(0, LIMITS.youtubeRow);

    videos.forEach(v => ytVideosById.set(v.id, v));

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
 * An iframe, not the site player: YouTube publishes no manifest for hls.js or
 * dashjs to attach to. Some uploads forbid embedding, so the header always
 * offers a way out to youtube.com.
 */
function openYouTubeVideo(videoId) {
    const video = ytVideosById.get(videoId);
    const frame = document.getElementById('youtubeFrame');

    document.getElementById('youtubeModalTitle').innerText = video ? video.title : 'YouTube';
    document.getElementById('youtubeModalLink').href = YOUTUBE.watchBase + videoId;
    frame.src = `${YOUTUBE.embedBase}${encodeURIComponent(videoId)}?autoplay=1&rel=0&modestbranding=1`;
    document.getElementById('youtubeModal').style.display = 'flex';
}

function closeYouTubeModal(e) {
    // Ignore clicks that bubbled up from inside the dialog.
    if (e && e.target !== document.getElementById('youtubeModal')) return;

    // Clearing the src is what actually stops playback; hiding the modal alone
    // leaves the audio running.
    document.getElementById('youtubeFrame').src = '';
    document.getElementById('youtubeModal').style.display = 'none';
}

function isYouTubeModalOpen() {
    const modal = document.getElementById('youtubeModal');
    return Boolean(modal) && modal.style.display === 'flex';
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
