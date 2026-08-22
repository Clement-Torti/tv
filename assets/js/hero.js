/* Hero banner: plays a muted random channel as the background video. */

let heroStream = null;
let heroChannel = null;
let heroPool = [];
let heroFailures = 0;

// Give up cycling after this many consecutive dead streams.
const HERO_MAX_FAILURES = 5;

function initHero() {
    const favs = allChannels.filter(c => favoriteNames.includes(c.name));
    heroPool = favs.length > 0 ? favs : allChannels;
    heroFailures = 0;
    if (heroPool.length > 0) playHeroRandom(heroPool);
}

/* "Random" button — re-rolls within the pool the hero was seeded with. */
function playRandom() {
    heroFailures = 0;
    if (heroPool.length > 0) playHeroRandom(heroPool);
}

function playHeroChannel() {
    if (heroChannel) openPlayer(heroChannel);
}

function toggleHeroMute() {
    const video = document.getElementById('hero-video-bg');
    video.muted = !video.muted;
    document.getElementById('heroMuteIcon').className = video.muted ? 'fas fa-volume-mute' : 'fas fa-volume-up';
}

function playHeroRandom(pool) {
    if (heroStream) { heroStream.destroy(); heroStream = null; }
    if (pool.length === 0) return;

    heroChannel = pickDifferent(pool, heroChannel);
    document.getElementById('hero-title').innerText = heroChannel.displayName;

    const video = document.getElementById('hero-video-bg');
    video.muted = true;
    document.getElementById('heroMuteIcon').className = 'fas fa-volume-mute';

    heroStream = attachStream(video, heroChannel, {
        hlsConfig: { lowLatencyMode: true },
        onFatal: () => {
            // Dead stream: quietly move on to another channel.
            if (heroStream) { heroStream.destroy(); heroStream = null; }
            if (pool.length < 2 || ++heroFailures > HERO_MAX_FAILURES) return;
            setTimeout(() => playHeroRandom(pool), 1000);
        }
    });
}

/* Random pick that avoids repeating the channel already on screen. */
function pickDifferent(pool, current) {
    const random = () => pool[Math.floor(Math.random() * pool.length)];
    if (pool.length === 1 || !current) return random();

    // Bounded retries: a pool of duplicates must not spin forever.
    for (let i = 0; i < 10; i++) {
        const pick = random();
        if (pick.url !== current.url) return pick;
    }
    return random();
}
