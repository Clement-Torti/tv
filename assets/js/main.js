/* Bootstrap: wire the global listeners, then load the playlist. */

function initGlobalListeners() {
    window.addEventListener('scroll', () => {
        document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 20);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (isPlayerOpen()) closePlayer();
            if (isYouTubeModalOpen()) closeYouTubeModal();
            closeCollectionModal();
            closeProfileModal();
            return;
        }

        /*
         * YouTube's own controls are switched off, so this page owns the
         * keyboard for that player too -- the same keys, routed to it.
         */
        if (isYouTubeModalOpen()) {
            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    toggleYouTubePlay();
                    break;
                case 'f':
                case 'F':
                    toggleYouTubeFullscreen();
                    break;
                case 'c':
                case 'C':
                    toggleArabicCaptions();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    seekYouTubeBy(-5);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    seekYouTubeBy(5);
                    break;
            }
            return;
        }

        if (!isPlayerOpen()) return;

        switch (e.key) {
            case ' ':
                e.preventDefault();
                togglePlay();
                break;
            case 'f':
            case 'F':
                toggleFullscreen();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                seekBy(-5);
                break;
            case 'ArrowRight':
                e.preventDefault();
                seekBy(5);
                break;
        }
    });
}

function init() {
    initNavigation();
    initContentInteractions();
    initYouTube();
    initPlayerAutoHide();
    initYouTubePlayerAutoHide();
    initGlobalListeners();
    initWatchTimer();
    loadChannelList();
}

init();
