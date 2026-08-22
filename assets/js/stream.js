/*
 * One place for "turn a channel URL into a playing <video>".
 *
 * Both the hero background and the main player go through here, so the proxy
 * handling, DASH/HLS selection and the HTTPS fallback only exist once.
 */
function attachStream(video, channel, options = {}) {
    const { onFatal = () => {}, ttmlDiv = null, hlsConfig = {} } = options;

    const originalUrl = channel.url;
    let usingProxy = needsProxy(originalUrl);
    let triedDirectHttps = false;
    let hls = null;
    let dash = null;

    if (isDashStream(originalUrl)) {
        dash = dashjs.MediaPlayer().create();
        dash.initialize(video, toPlayableUrl(originalUrl), true);
        if (ttmlDiv) dash.attachTTMLRenderingDiv(ttmlDiv);
        dash.on(dashjs.MediaPlayer.events.ERROR, (e) => onFatal(e));
    } else if (window.Hls && Hls.isSupported()) {
        hls = new Hls({
            enableWorker: true,
            manifestLoadingTimeOut: 15000,
            fragLoadingTimeOut: 15000,
            ...hlsConfig,
            xhrSetup: makeProxyXhrSetup(() => originalUrl, () => usingProxy)
        });

        hls.loadSource(toPlayableUrl(originalUrl));
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));

        hls.on(Hls.Events.ERROR, (event, data) => {
            if (!data.fatal) return;

            // The proxy fails often enough that trying the origin over HTTPS is
            // worth one attempt before giving up on the channel.
            if (usingProxy && !triedDirectHttps) {
                triedDirectHttps = true;
                usingProxy = false;
                hls.loadSource(originalUrl.replace('http://', 'https://'));
                return;
            }
            onFatal(data);
        });
    } else {
        // Safari and other browsers with native HLS.
        video.src = toPlayableUrl(originalUrl);
        video.play().catch(() => {});
        video.addEventListener('error', () => onFatal(video.error), { once: true });
    }

    return {
        destroy() {
            if (hls) { hls.destroy(); hls = null; }
            if (dash) { dash.reset(); dash = null; }
        }
    };
}
