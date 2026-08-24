/*
 * Watch-session stopwatch.
 *
 * Counts wall-clock time the way a stopwatch does: `accumulatedMs` holds the
 * time banked by earlier runs, and a running timer adds the time since
 * `startedAt` on top. Only the banked total is persisted -- a reload comes back
 * paused rather than silently crediting the minutes the page was closed.
 */

let watchAccumulatedMs = 0;
let watchStartedAt = 0;
let watchTicker = null;

function initWatchTimer() {
    const stored = Number(localStorage.getItem(STORAGE_KEYS.watchTimer));
    watchAccumulatedMs = Number.isFinite(stored) && stored > 0 ? stored : 0;
    renderWatchTimer();
}

function isWatchTimerRunning() {
    return watchStartedAt > 0;
}

function watchElapsedMs() {
    return watchAccumulatedMs + (isWatchTimerRunning() ? Date.now() - watchStartedAt : 0);
}

function toggleWatchTimer() {
    if (isWatchTimerRunning()) pauseWatchTimer();
    else startWatchTimer();
}

function startWatchTimer() {
    if (isWatchTimerRunning()) return;
    watchStartedAt = Date.now();
    // Sub-second interval so the displayed second never lags behind by a full tick.
    watchTicker = setInterval(renderWatchTimer, 500);
    renderWatchTimer();
}

function pauseWatchTimer() {
    if (!isWatchTimerRunning()) return;
    watchAccumulatedMs = watchElapsedMs();
    watchStartedAt = 0;
    clearInterval(watchTicker);
    watchTicker = null;
    saveWatchTimer();
    renderWatchTimer();
}

function resetWatchTimer() {
    const wasRunning = isWatchTimerRunning();
    clearInterval(watchTicker);
    watchTicker = null;
    watchAccumulatedMs = 0;
    watchStartedAt = 0;
    saveWatchTimer();
    renderWatchTimer();
    if (wasRunning) showToast('Timer reset');
}

function saveWatchTimer() {
    localStorage.setItem(STORAGE_KEYS.watchTimer, String(Math.round(watchAccumulatedMs)));
}

/* mm:ss, widening to h:mm:ss only once there is an hour to show. */
function formatWatchDuration(ms) {
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0
        ? `${hours}:${pad(minutes)}:${pad(seconds)}`
        : `${pad(minutes)}:${pad(seconds)}`;
}

function renderWatchTimer() {
    const pill = document.getElementById('watchTimer');
    if (!pill) return;

    const running = isWatchTimerRunning();
    document.getElementById('watchTimerTime').innerText = formatWatchDuration(watchElapsedMs());
    document.getElementById('watchTimerIcon').className = running ? 'fas fa-pause' : 'fas fa-play';

    pill.classList.toggle('running', running);
    const toggle = pill.querySelector('.watch-timer-toggle');
    toggle.title = running ? 'Pause timer' : 'Start timer';
    toggle.setAttribute('aria-label', toggle.title);
}

/* Lifts the pill above the player modal, which otherwise covers the navbar. */
function setWatchTimerFloating(floating) {
    const pill = document.getElementById('watchTimer');
    if (pill) pill.classList.toggle('floating', Boolean(floating));
}

/* Banking the elapsed time on the way out keeps a refresh from losing it. */
window.addEventListener('beforeunload', () => {
    if (isWatchTimerRunning()) {
        watchAccumulatedMs = watchElapsedMs();
        saveWatchTimer();
    }
});
