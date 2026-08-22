/* Chromecast support. The sender SDK calls __onGCastApiAvailable when it loads. */

function getCastSession() {
    if (!window.cast || !cast.framework) return null;
    return cast.framework.CastContext.getInstance().getCurrentSession() || null;
}

window['__onGCastApiAvailable'] = function (isAvailable) {
    if (!isAvailable) return;

    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });

    const castBtn = document.getElementById('castBtn');
    if (castBtn) castBtn.style.display = 'inline-block';

    // Picking up an already-running session lets channel switching keep casting.
    context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
        if (event.sessionState === cast.framework.SessionState.SESSION_STARTED) {
            showToast('Connected to TV');
            if (currentChannel) loadMediaOnCast();
        } else if (event.sessionState === cast.framework.SessionState.SESSION_ENDED) {
            showToast('Disconnected from TV');
        }
    });
};

function triggerChromecast() {
    if (!window.cast || !cast.framework) {
        showToast('Chromecast unavailable');
        return;
    }

    const context = cast.framework.CastContext.getInstance();
    // With a session running this opens the native stop/control dialog instead.
    context.requestSession().then(
        () => { if (!getCastSession()) return; loadMediaOnCast(); },
        (err) => { console.error('Cast error:', err); }
    );
}

function loadMediaOnCast() {
    const session = getCastSession();
    if (!session || !currentChannel) return;

    // Hand the receiver whichever candidate is known to work.
    const url = bestUrl(currentChannel);
    if (!url) { showToast('No playable stream for this channel'); return; }

    const contentType = isDashStream(url) ? 'application/dash+xml' : 'application/vnd.apple.mpegurl';
    const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);

    const metadata = new chrome.cast.media.GenericMediaMetadata();
    metadata.title = currentChannel.displayName;
    if (currentChannel.logo) metadata.images = [{ url: currentChannel.logo }];
    mediaInfo.metadata = metadata;

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.autoplay = true;

    session.loadMedia(request).then(
        () => {
            showToast('Playing on TV: ' + currentChannel.displayName);
            const localVideo = document.getElementById('mainVideo');
            if (localVideo) {
                localVideo.pause();
                updatePlayerIcons(true);
            }
        },
        (errorCode) => showToast('Cast failed. Error code: ' + errorCode)
    );
}
