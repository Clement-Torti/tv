/* Bootstrap: wire the global listeners, then load the playlist. */

function initGlobalListeners() {
    window.addEventListener('scroll', () => {
        document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 20);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (isPlayerOpen()) closePlayer();
            closeCollectionModal();
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
    initPlayerAutoHide();
    initGlobalListeners();
    loadChannelList();
}

init();
