/*
 * One place for "turn a channel into a playing <video>".
 *
 * A channel carries several candidate URLs (see sources.js). This walks them in
 * order and moves to the next one whenever a stream fails fatally, which is what
 * makes a channel with backup links far more likely to play than its first URL
 * alone. Every outcome is fed back to health.js, so a failure seen here also
 * removes the channel from the listing.
 *
 * There is deliberately no CORS proxy in this path: the public proxies this app
 * used to rely on now answer 403 or hang, so a proxied attempt only burned a
 * timeout that a direct attempt on the next candidate could spend usefully.
 */
function attachStream(video, channel, options = {}) {
    const {
        onFatal = () => {},
        onPlaying = () => {},
        ttmlDiv = null,
        hlsConfig = {}
    } = options;

    const urls = orderedCandidates(channel);
    let index = -1;
    let hls = null;
    let dash = null;
    let destroyed = false;

    function teardown() {
        if (hls) { hls.destroy(); hls = null; }
        if (dash) { dash.reset(); dash = null; }
    }

    function advance() {
        teardown();
        if (destroyed) return;

        index++;
        if (index >= urls.length) {
            onFatal();
            return;
        }
        start(urls[index]);
    }

    function succeeded(url) {
        if (destroyed) return;
        reportPlaybackResult(url, true);
        onPlaying(url);
    }

    function failed(url) {
        if (destroyed) return;
        reportPlaybackResult(url, false);
        advance();
    }

    function start(url) {
        if (isDashStream(url)) {
            dash = dashjs.MediaPlayer().create();
            dash.initialize(video, url, true);
            if (ttmlDiv) dash.attachTTMLRenderingDiv(ttmlDiv);
            dash.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => succeeded(url));
            dash.on(dashjs.MediaPlayer.events.ERROR, () => failed(url));
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
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                succeeded(url);
                video.play().catch(() => {});
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) failed(url);
            });
            return;
        }

        // Safari and other browsers with native HLS.
        video.src = url;
        video.play().catch(() => {});
        const onLoaded = () => { cleanupNative(); succeeded(url); };
        const onError = () => { cleanupNative(); failed(url); };
        const cleanupNative = () => {
            video.removeEventListener('loadedmetadata', onLoaded);
            video.removeEventListener('error', onError);
        };
        video.addEventListener('loadedmetadata', onLoaded, { once: true });
        video.addEventListener('error', onError, { once: true });
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

    // A URL already proven good goes first.
    return pool.slice().sort((a, b) => scoreUrl(a) - scoreUrl(b));
}

function scoreUrl(url) {
    return getVerdict(url) === 'ok' ? 0 : 1;
}
