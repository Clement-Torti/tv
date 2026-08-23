/*
 * One place for "turn a channel into a playing <video>".
 *
 * A channel carries several candidate URLs (see sources.js). This walks them in
 * order and moves to the next one whenever a candidate fails, which is what
 * makes a channel with backup links far more likely to play than its first URL
 * alone. Every outcome is fed back to health.js, so a failure seen here also
 * removes the channel from the listing.
 *
 * A candidate only counts as working once the video element actually decodes
 * media. `MANIFEST_PARSED` is not enough: a playlist can download cleanly and
 * then serve segments that 404, and trusting it would cache a broken stream as
 * good for hours. Nothing at all is emitted in that case, hence the watchdog.
 *
 * There is deliberately no CORS proxy in this path: the public proxies this app
 * used to rely on now answer 403 or hang, so a proxied attempt only burned a
 * timeout that a direct attempt on the next candidate could spend usefully.
 */
// Any of these means real media reached the element; see watchCandidate below.
const CONFIRMING_EVENTS = ['loadeddata', 'canplay', 'playing'];

function attachStream(video, channel, options = {}) {
    const {
        onFatal = () => {},
        onPlaying = () => {},
        onAttempt = () => {},
        ttmlDiv = null,
        hlsConfig = {}
    } = options;

    const urls = orderedCandidates(channel);
    let index = -1;
    let hls = null;
    let dash = null;
    let destroyed = false;
    let pending = null;

    function teardown() {
        if (pending) { pending.cancel(); pending = null; }
        if (hls) { hls.destroy(); hls = null; }
        if (dash) { dash.reset(); dash = null; }
    }

    function advance() {
        teardown();
        if (destroyed) return;

        index++;
        if (index >= urls.length) {
            // Every candidate has now been recorded as broken, so the channel
            // itself counts as broken.
            onFatal();
            return;
        }
        onAttempt(urls[index], index + 1, urls.length);
        start(urls[index]);
    }

    /*
     * Waits for the first real sign of playback.
     *
     * Several signals are accepted because no single one is dependable. `playing`
     * needs autoplay to be permitted; `canplay` needs enough buffered data to
     * start, which some live streams take a long time to reach even while
     * decoding correctly. `loadeddata` (a first frame exists) and hls.js's
     * FRAG_LOADED (a media segment actually arrived) are earlier and just as
     * conclusive. What is *not* accepted is MANIFEST_PARSED: a playlist can
     * download perfectly and then serve nothing but 404s.
     */
    function watchCandidate(url) {
        let done = false;
        const confirm = () => finish(true);

        const detach = () => {
            clearTimeout(timer);
            for (const ev of CONFIRMING_EVENTS) video.removeEventListener(ev, confirm);
        };

        function finish(ok) {
            if (done || destroyed) return;
            done = true;
            detach();
            reportPlaybackResult(url, ok);
            if (ok) onPlaying(url);
            else advance();
        }

        const timer = setTimeout(() => finish(false), HEALTH.playbackTimeoutMs);
        for (const ev of CONFIRMING_EVENTS) video.addEventListener(ev, confirm);

        return {
            confirm: () => finish(true),
            fail: () => finish(false),
            cancel: () => { done = true; detach(); }
        };
    }

    function start(url) {
        // Bound to this attempt: `pending` moves on when a candidate is dropped,
        // so a late event from a torn-down player must not settle the new one.
        const watcher = watchCandidate(url);
        pending = watcher;
        const failNow = () => watcher.fail();

        // Verdicts stay keyed by the channel's real URL; only the request goes
        // through the proxy, and only when the URL is plain HTTP.
        const src = playableUrl(url);

        if (isDashStream(url)) {
            dash = dashjs.MediaPlayer().create();
            dash.initialize(video, src, true);
            if (ttmlDiv) dash.attachTTMLRenderingDiv(ttmlDiv);
            dash.on(dashjs.MediaPlayer.events.ERROR, failNow);
            return;
        }

        if (window.Hls && Hls.isSupported()) {
            hls = new Hls({
                enableWorker: true,
                manifestLoadingTimeOut: 12000,
                fragLoadingTimeOut: 12000,
                ...hlsConfig
            });
            hls.loadSource(src);
            hls.attachMedia(video);
            // Parsing the manifest only means it is worth waiting for frames.
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            // A segment that actually arrived proves the stream carries media.
            hls.on(Hls.Events.FRAG_LOADED, () => watcher.confirm());
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) failNow();
            });
            return;
        }

        // Safari and other browsers with native HLS.
        video.src = src;
        video.play().catch(() => {});
        video.addEventListener('error', failNow, { once: true });
    }

    advance();

    return {
        destroy() {
            destroyed = true;
            teardown();
        },
        currentUrl() {
            return urls[index] || null;
        },
        remainingCandidates() {
            return Math.max(0, urls.length - index - 1);
        }
    };
}

/*
 * Candidates worth attempting, best first. URLs already known to be broken are
 * dropped -- unless that would leave nothing, in which case they are tried
 * anyway rather than refusing to play a channel the user explicitly opened.
 */
function orderedCandidates(channel) {
    const urls = channel.urls || [];
    const fresh = urls.filter(url => getVerdict(url) !== 'dead');
    const pool = fresh.length > 0 ? fresh : urls;

    // A URL already proven good goes first; sort is stable, so the source
    // ranking decides everything else.
    return pool.slice().sort((a, b) => scoreUrl(a) - scoreUrl(b));
}

function scoreUrl(url) {
    return getVerdict(url) === 'ok' ? 0 : 1;
}
