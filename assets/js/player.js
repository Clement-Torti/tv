/* Full-screen player: playback, controls, favourites carousel. */

let playerStream = null;
let lastVolume = 1.0;
let controlsTimeout;
let mouseTimer;

function openPlayer(channel) {
    currentChannel = channel;
    const video = document.getElementById('mainVideo');

    document.getElementById('playerTitle').innerText = channel.displayName;
    document.getElementById('videoModal').style.display = 'flex';
    setWatchTimerFloating(true);

    // Mute the hero so its audio never overlaps the player.
    document.getElementById('hero-video-bg').muted = true;
    document.getElementById('heroMuteIcon').className = 'fas fa-volume-mute';

    // Drop any previous stream before starting a new one.
    if (playerStream) { playerStream.destroy(); playerStream = null; }

    updateFavButtonState();
    renderPlayerCarousel();
    document.getElementById('playerCarousel').classList.add('open');
    document.getElementById('carouselToggleIcon').className = 'fas fa-chevron-down';

    // When a Chromecast session is live the TV owns playback: hand the stream
    // over and skip the local player, otherwise both would decode at once.
    const session = getCastSession();
    if (session) {
        syncVolumeUi(session.getVolume());
        loadMediaOnCast();
        return;
    }

    syncVolumeUi(video.volume);
    video.playbackRate = 1.0;
    document.getElementById('speedDisplay').innerText = '1.0x';
    updatePlayerIcons(false);

    playerStream = attachStream(video, channel, {
        ttmlDiv: document.getElementById('ttml-rendering-div'),
        onAttempt: (url, attempt, total) => {
            setPlayerStatus(attempt === 1
                ? 'Connecting…'
                : `Stream failed — trying backup ${attempt} of ${total}…`);
        },
        onPlaying: () => setPlayerStatus(''),
        onFatal: () => {
            setPlayerStatus('');
            // Nothing this channel offers works, so stop offering it.
            markChannelBroken(channel);
            showToast(`Stream unavailable: ${channel.displayName}`);
            closePlayer();
        }
    });
}

/* A one-line note under the player title, used while failing over. */
function setPlayerStatus(message) {
    const el = document.getElementById('playerStatus');
    if (!el) return;
    el.innerText = message || '';
    el.classList.toggle('show', Boolean(message));
}

function closePlayer() {
    const video = document.getElementById('mainVideo');
    video.pause();
    video.removeAttribute('src');
    video.load();

    if (playerStream) { playerStream.destroy(); playerStream = null; }

    setPlayerStatus('');
    document.getElementById('videoModal').style.display = 'none';
    setWatchTimerFloating(false);
    document.getElementById('playerCarousel').classList.remove('open');
    document.getElementById('carouselToggleIcon').className = 'fas fa-chevron-up';
    if (document.fullscreenElement) document.exitFullscreen();
}

function isPlayerOpen() {
    return document.getElementById('videoModal').style.display === 'flex';
}

/* --- Playback controls --- */
function togglePlay() {
    const video = document.getElementById('mainVideo');
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    updatePlayerIcons(video.paused);
}

function updatePlayerIcons(isPaused) {
    const icon = isPaused ? 'fas fa-play' : 'fas fa-pause';
    document.getElementById('centerPlayIcon').className = icon;
    document.getElementById('bottomPlayIcon').className = icon;
}

function adjustSpeed(delta) {
    const video = document.getElementById('mainVideo');
    const newSpeed = Math.round(Math.max(0.25, Math.min(4.0, video.playbackRate + delta)) * 100) / 100;
    video.playbackRate = newSpeed;
    document.getElementById('speedDisplay').innerText = newSpeed.toFixed(2) + 'x';
}

function seekBy(seconds) {
    const video = document.getElementById('mainVideo');
    if (!Number.isFinite(video.currentTime)) return;
    video.currentTime += seconds;
    showToast(`${seconds > 0 ? '+' : ''}${seconds}s`);
}

function toggleFullscreen() {
    const wrapper = document.getElementById('videoWrapper');
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapper.requestFullscreen();
}

async function togglePiP() {
    const video = document.getElementById('mainVideo');
    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
            await video.requestPictureInPicture();
        } else {
            showToast('Picture-in-Picture not supported');
        }
    } catch (error) {
        console.error('PiP error:', error);
    }
}

/* --- Volume (local player and Chromecast) --- */
function syncVolumeUi(volume) {
    document.getElementById('volumeSlider').value = volume;
    updateVolumeIcon(volume);
}

function handleVolumeSlide(value) {
    const vol = parseFloat(value);

    const session = getCastSession();
    if (session) {
        session.setVolume(vol);
        updateVolumeIcon(vol);
        return;
    }

    const video = document.getElementById('mainVideo');
    if (video) {
        video.volume = vol;
        video.muted = (vol === 0);
    }
    updateVolumeIcon(vol);
}

function toggleMute() {
    const slider = document.getElementById('volumeSlider');
    const currentVol = parseFloat(slider.value);

    if (currentVol > 0) {
        lastVolume = currentVol;
        slider.value = 0;
        handleVolumeSlide(0);
    } else {
        const target = lastVolume > 0 ? lastVolume : 0.5;
        slider.value = target;
        handleVolumeSlide(target);
    }
}

function updateVolumeIcon(vol) {
    const icon = document.getElementById('volumeIcon');
    if (vol === 0) icon.className = 'fas fa-volume-mute';
    else if (vol < 0.5) icon.className = 'fas fa-volume-down';
    else icon.className = 'fas fa-volume-up';
}

/* --- Overlay auto-hide --- */
function togglePlayerControls() {
    const overlay = document.getElementById('playerOverlay');
    if (window.innerWidth > 768) return;

    if (overlay.classList.contains('show-mobile')) {
        overlay.classList.remove('show-mobile');
        return;
    }

    overlay.classList.add('show-mobile');
    clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => {
        if (!document.getElementById('mainVideo').paused) overlay.classList.remove('show-mobile');
    }, 2000);
}

function initPlayerAutoHide() {
    document.getElementById('videoWrapper').addEventListener('mousemove', () => {
        if (window.innerWidth <= 768) return;

        const wrapper = document.getElementById('videoWrapper');
        const overlay = document.getElementById('playerOverlay');
        wrapper.style.cursor = 'default';
        overlay.style.opacity = '1';

        clearTimeout(mouseTimer);
        mouseTimer = setTimeout(() => {
            if (document.getElementById('mainVideo').paused) return;
            overlay.style.opacity = '0';
            wrapper.style.cursor = 'none';
        }, 2000);
    });
}

/* --- Favourites carousel --- */
function togglePlayerCarousel() {
    const carousel = document.getElementById('playerCarousel');
    const icon = document.getElementById('carouselToggleIcon');

    if (carousel.classList.contains('open')) {
        carousel.classList.remove('open');
        icon.className = 'fas fa-chevron-up';
        return;
    }

    renderPlayerCarousel();
    carousel.classList.add('open');
    icon.className = 'fas fa-chevron-down';
}

function renderPlayerCarousel() {
    const track = document.getElementById('playerCarouselList');
    track.innerHTML = '';

    const favoriteChannels = allChannels.filter(c => favoriteNames.includes(c.name));
    if (favoriteChannels.length === 0) {
        track.innerHTML = '<div style="color:#aaa; width:100%; text-align:center;">No favorites found. Add some <i class="far fa-heart"></i></div>';
        return;
    }

    favoriteChannels.forEach(channel => {
        const isActive = Boolean(currentChannel) && currentChannel.name === channel.name;
        const logo = hasLogo(channel);

        const card = document.createElement('div');
        card.className = `carousel-card ${isActive ? 'active' : ''}`;
        card.style.background = getGradient(channel.name);
        card.innerHTML = `
            ${logo ? `<img src="${escapeAttr(channel.logo)}" onerror="this.style.display='none'" loading="lazy" alt="${escapeAttr(channel.displayName)}" style="max-width:100%; object-fit:contain;">` : ''}
            <div class="carousel-card-info" style="${logo ? 'display:none' : ''}">
                <span class="carousel-name">${escapeHtml(channel.displayName)}</span>
            </div>`;

        card.onclick = (e) => {
            e.stopPropagation();
            openPlayer(channel);
        };

        track.appendChild(card);

        if (isActive) {
            setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }), 100);
        }
    });
}

/* --- Channel removal --- */
function removeCurrentChannel(confirmAction) {
    if (!currentChannel) return;
    if (confirmAction && !confirm('Remove this channel?')) return;

    const removedName = currentChannel.name;
    setChannels(allChannels.filter(c => c.name !== removedName));
    closePlayer();
    refreshCurrentView();
}
