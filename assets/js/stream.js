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
     * Waits for the first real sign of playback. `canplay` is used rather than
     * `playing` because it does not depend on autoplay being permitted: it means
     * frames were decoded, which is exactly the question being asked.
     */
    function watchCandidate(url) {
        let done = false;
        const confirm = () => finish(true);

        const detach = () => {
            clearTimeout(timer);
            video.removeEventListener('canplay', confirm);
            video.removeEventListener('playing', confirm);
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
        video.addEventListener('canplay', confirm);
        video.addEventListener('playing', confirm);

        return {
            fail: () => finish(false),
            cancel: () => { done = true; detach(); }
        };
    }

    function start(url) {
        pending = watchCandidate(url);
        const failNow = () => { if (pending) pending.fail(); };

        if (isDashStream(url)) {
            dash = dashjs.MediaPlayer().create();
            dash.initialize(video, url, true);
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
            hls.loadSource(url);
            hls.attachMedia(video);
            // Parsing the manifest only means it is worth waiting for frames.
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) failNow();
            });
            return;
        }

        // Safari and other browsers with native HLS.
        video.src = url;
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
