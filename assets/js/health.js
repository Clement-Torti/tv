/*
 * Stream health.
 *
 * A channel is checked by fetching one of its manifests. That single request
 * answers both questions that matter: is the stream reachable, and does it send
 * the CORS header hls.js needs? Measured over 300 iptv-org streams, 75% return a
 * valid manifest but only 57% also allow cross-origin reads -- so a stream that
 * plays fine in VLC still fails here, and reachability alone is not enough.
 *
 * Verdicts are cached in localStorage, so a returning visitor gets a clean list
 * before anything is rendered instead of watching it clean itself up again.
 */

let verdicts = loadVerdicts();
let verdictsDirty = false;
let saveTimer = null;

function loadVerdicts() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.verdicts));
        if (!raw || typeof raw !== 'object') return {};

        // Turning the proxy on or off changes the answer for every http://
        // stream, so those cached verdicts can no longer be trusted.
        if (raw.__proxy !== (STREAM_PROXY || '')) {
            for (const url of Object.keys(raw)) {
                if (url.startsWith('http://')) delete raw[url];
            }
        }
        delete raw.__proxy;
        return raw;
    } catch (e) {
        console.warn('Corrupt stream-health cache, starting fresh.', e);
        return {};
    }
}

/* Writes are batched: verification produces a lot of small updates. */
function scheduleVerdictSave() {
    verdictsDirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (verdictsDirty) saveVerdicts();
    }, 2000);
}

function saveVerdicts() {
    verdictsDirty = false;
    const entries = Object.entries(verdicts);

    // Keep the cache bounded, dropping the oldest verdicts first.
    if (entries.length > HEALTH.maxCached) {
        entries.sort((a, b) => b[1].at - a[1].at);
        verdicts = {};
        for (const [url, verdict] of entries.slice(0, HEALTH.maxCached)) verdicts[url] = verdict;
    }

    try {
        // __proxy is stored alongside, never kept in the in-memory map.
        localStorage.setItem(STORAGE_KEYS.verdicts,
            JSON.stringify({ ...verdicts, __proxy: STREAM_PROXY || '' }));
    } catch (e) {
        // Out of quota: the cache is an optimisation, so drop it and carry on.
        console.warn('Could not persist stream health cache.', e);
        verdicts = {};
    }
}

/* --- Verdict lookups --- */

/* 'ok' | 'dead' | null when unknown or too old to trust. */
function getVerdict(url) {
    const verdict = verdicts[url];
    if (!verdict) return null;
    if (Date.now() - verdict.at > HEALTH.ttlMs) return null;
    return verdict.ok ? 'ok' : 'dead';
}

function recordVerdict(url, ok) {
    verdicts[url] = { ok: ok ? 1 : 0, at: Date.now() };
    scheduleVerdictSave();
}

/*
 * 'ok'      at least one URL is known to work
 * 'dead'    every URL we would try has been checked and failed
 * 'unknown' not checked yet
 */
function channelHealth(channel) {
    const urls = candidateUrls(channel);
    let checked = 0;
    for (const url of urls) {
        const verdict = getVerdict(url);
        if (verdict === 'ok') return 'ok';
        if (verdict === 'dead') checked++;
    }
    return checked === urls.length && urls.length > 0 ? 'dead' : 'unknown';
}

function candidateUrls(channel) {
    return (channel.urls || []).slice(0, HEALTH.maxUrlsPerChannel);
}

/* The URL to hand the player: a known-good one if we have it, else the best guess. */
function bestUrl(channel) {
    const urls = channel.urls || [];
    for (const url of urls) if (getVerdict(url) === 'ok') return url;
    for (const url of urls) if (getVerdict(url) !== 'dead') return url;
    return urls[0] || null;
}

/* --- Probing --- */

async function probeUrl(url, timeoutMs = HEALTH.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(playableUrl(url), { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) return false;

        const body = (await response.text()).trimStart();
        // Accept an HLS playlist or a DASH manifest; anything else is not a stream.
        return body.startsWith('#EXTM3U') || body.includes('<MPD');
    } catch (e) {
        // A CORS rejection lands here as a TypeError, which is exactly the
        // failure the player would hit, so it counts as broken.
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/* --- Bounded queue --- */

const verifyQueue = [];
const queued = new Set();
let activeProbes = 0;

/*
 * Schedules `channel` for verification. `onSettled(health)` fires once its
 * health is known. Channels already checked resolve immediately.
 */
function enqueueVerification(channel, onSettled) {
    const known = channelHealth(channel);
    if (known !== 'unknown') {
        onSettled(known);
        return;
    }
    if (queued.has(channel.name)) return;

    queued.add(channel.name);
    verifyQueue.push({ channel, onSettled });
    pumpVerifyQueue();
}

function pumpVerifyQueue() {
    while (activeProbes < HEALTH.concurrency && verifyQueue.length > 0) {
        const job = verifyQueue.shift();
        activeProbes++;
        verifyChannel(job.channel)
            .then((health) => job.onSettled(health))
            .catch(() => job.onSettled('unknown'))
            .finally(() => {
                activeProbes--;
                queued.delete(job.channel.name);
                pumpVerifyQueue();
            });
    }
}

/* Probes a channel's URLs in order and stops at the first one that works. */
async function verifyChannel(channel) {
    const urls = candidateUrls(channel);
    if (urls.length === 0) return 'dead';

    for (const url of urls) {
        const cached = getVerdict(url);
        if (cached === 'ok') return 'ok';
        if (cached === 'dead') continue;

        const ok = await probeUrl(url);
        recordVerdict(url, ok);
        if (ok) return 'ok';
    }
    return 'dead';
}

/* Playback told us the truth, which beats any probe: record it. */
function reportPlaybackResult(url, ok) {
    recordVerdict(url, ok);
}

function healthStats() {
    let ok = 0;
    let dead = 0;
    for (const url in verdicts) {
        if (getVerdict(url) === 'ok') ok++;
        else if (getVerdict(url) === 'dead') dead++;
    }
    return { ok, dead, cached: ok + dead };
}
