/* Card / row / grid rendering, delegated clicks, and lazy health verification. */

let healthObserver = null;
let hiddenBrokenCount = 0;

function createCardHtml(channel) {
    const logo = hasLogo(channel);
    const isFav = favoriteNames.includes(channel.name);
    const name = escapeHtml(channel.displayName);
    const health = channelHealth(channel);
    const backups = Math.max(0, (channel.urls || []).length - 1);

    return `
    <div class="card" data-channel-id="${escapeAttr(channel.id)}" data-health="${health}" style="background: ${getGradient(channel.name)}">
        ${logo
            ? `<img src="${escapeAttr(channel.logo)}" onerror="this.style.display='none'" loading="lazy" alt="${escapeAttr(channel.displayName)}" style="max-width:100%; object-fit:contain;">`
            : `<div class="card-fallback-title">${name}</div>`}
        <div class="card-info">
            <div class="card-actions">
                <div class="action-btn" data-action="collection" title="Add to section"><i class="fas fa-list"></i></div>
                <div class="action-btn" data-action="favorite" title="Favorite" style="${isFav ? 'background:white; color:red;' : ''}"><i class="${isFav ? 'fas' : 'far'} fa-heart"></i></div>
                <div class="action-btn" data-action="play" title="Play"><i class="fas fa-play"></i></div>
            </div>
            <div>
                <span class="badge-live">LIVE</span><span class="channel-name">${name}</span>
                ${backups > 0 ? `<span class="badge-backup" title="${backups} backup link${backups > 1 ? 's' : ''}">+${backups}</span>` : ''}
            </div>
        </div>
    </div>`;
}

function renderRow(title, channels, isFavRow = false) {
    if (channels.length === 0) return;
    const rowId = 'row-' + title.replace(/[^a-zA-Z0-9]/g, '-');
    const cards = channels.map(createCardHtml).join('');
    const heart = isFavRow ? '<i class="fas fa-heart" style="color:red"></i> ' : '';

    document.getElementById('app-content').insertAdjacentHTML('beforeend', `
        <div class="section-title">${heart}${escapeHtml(title)}</div>
        <div class="row-container">
            <button class="scroll-btn left" data-scroll="-1" data-row="${rowId}"><i class="fas fa-chevron-left"></i></button>
            <div class="row" id="${rowId}">${cards}</div>
            <button class="scroll-btn right" data-scroll="1" data-row="${rowId}"><i class="fas fa-chevron-right"></i></button>
        </div>`);

    observeCardHealth();
}

function renderGrid(title, channels) {
    const cards = channels.map(createCardHtml).join('');
    document.getElementById('app-content').innerHTML =
        `<div class="section-title">${escapeHtml(title)}</div><div class="grid-container">${cards}</div>`;
    observeCardHealth();
}

function scrollRow(rowId, direction) {
    const row = document.getElementById(rowId);
    if (row) row.scrollBy({ left: direction * 300, behavior: 'smooth' });
}

/* --- Lazy health verification ---
 *
 * Checking every channel up front would mean thousands of requests, so cards are
 * only verified once they scroll into view. A card whose every stream fails is
 * taken out of the listing, which is what keeps dead channels off the page.
 */
function observeCardHealth() {
    if (!('IntersectionObserver' in window)) return;

    if (!healthObserver) {
        healthObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                healthObserver.unobserve(entry.target);
                verifyCard(entry.target);
            }
        }, { rootMargin: '200px' });
    }

    document.querySelectorAll('.card[data-health="unknown"]').forEach(card => {
        healthObserver.observe(card);
    });

    scheduleHealthSweep();
}

/*
 * Cards on screen are verified first, but waiting for the user to scroll past
 * everything else would leave most of the listing unchecked -- and the whole
 * point of the filter is that broken channels are gone before they are clicked.
 * So once the visible cards are under way, sweep the rest of the rendered view
 * in the background, up to a bounded number of channels.
 */
let sweepTimer = null;
function scheduleHealthSweep() {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(runHealthSweep, HEALTH.sweepDelayMs);
}

function runHealthSweep() {
    const pending = document.querySelectorAll('.card[data-health="unknown"]');
    let budget = HEALTH.sweepLimit;

    for (const card of pending) {
        if (budget-- <= 0) break;
        verifyCard(card);
    }
}

function verifyCard(card) {
    const channel = getChannelById(card.dataset.channelId);
    if (!channel) return;

    enqueueVerification(channel, (health) => {
        // The card may have been replaced by a re-render in the meantime.
        if (!card.isConnected) return;
        card.dataset.health = health;

        if (health === 'dead' && hideBroken && !favoriteNames.includes(channel.name)) {
            removeCardFromView(card);
            hiddenBrokenCount++;
        }
        updateHealthChip();
    });
}

/*
 * Playback just proved a channel does not work, which is better evidence than
 * any probe. Take it out of the listing so going back does not show it again.
 */
function markChannelBroken(channel) {
    if (!channel) return;
    if (favoriteNames.includes(channel.name)) return;  // the user chose to keep these

    let removed = 0;
    document.querySelectorAll(`.card[data-channel-id="${channel.id}"]`).forEach(card => {
        card.dataset.health = 'dead';
        if (hideBroken) { removeCardFromView(card); removed++; }
    });

    if (removed > 0) {
        hiddenBrokenCount += removed;
        updateHealthChip();
    }
}

function removeCardFromView(card) {
    const row = card.parentElement;
    card.remove();

    // A row or grid emptied by removals should not leave a dangling heading.
    if (!row || row.querySelector('.card')) return;
    const container = row.classList.contains('row') ? row.closest('.row-container') : row;
    const title = container ? container.previousElementSibling : null;
    if (title && title.classList.contains('section-title')) title.remove();
    if (container) container.remove();
}

/* A quiet progress readout, so the list visibly cleaning itself is explainable. */
function updateHealthChip() {
    let chip = document.getElementById('healthChip');
    if (!chip) {
        chip = document.createElement('div');
        chip.id = 'healthChip';
        chip.className = 'health-chip';
        document.body.appendChild(chip);
    }

    const pending = verifyQueue.length + activeProbes;
    if (pending > 0) {
        chip.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Checking streams… <b>${hiddenBrokenCount}</b> hidden`;
        chip.classList.add('show');
        return;
    }

    if (hiddenBrokenCount > 0) {
        chip.innerHTML = `<i class="fas fa-eye-slash"></i> <b>${hiddenBrokenCount}</b> broken channel${hiddenBrokenCount > 1 ? 's' : ''} hidden`;
        chip.classList.add('show');
        clearTimeout(chip._hideTimer);
        chip._hideTimer = setTimeout(() => chip.classList.remove('show'), 4000);
    } else {
        chip.classList.remove('show');
    }
}

/*
 * A single listener on the (never replaced) #app-content element covers every
 * card, row button and catalogue poster, so re-rendering never has to rebind.
 */
function initContentInteractions() {
    document.getElementById('app-content').addEventListener('click', (e) => {
        const scroller = e.target.closest('[data-scroll]');
        if (scroller) {
            scrollRow(scroller.dataset.row, Number(scroller.dataset.scroll));
            return;
        }

        // A YouTube card opens the embedded player, not a channel stream.
        const ytCard = e.target.closest('.card[data-yt-id]');
        if (ytCard) {
            openYouTubeVideo(ytCard.dataset.ytId);
            return;
        }

        // Catalogue posters (Movies / Series) just open the source page.
        const external = e.target.closest('.card[data-href]');
        if (external) {
            window.open(external.dataset.href, '_blank', 'noopener');
            return;
        }

        const card = e.target.closest('.card[data-channel-id]');
        if (!card) return;
        const channel = getChannelById(card.dataset.channelId);
        if (!channel) return;

        const action = e.target.closest('[data-action]');
        if (action && action.dataset.action === 'collection') {
            openCollectionModal(channel);
            return;
        }
        if (action && action.dataset.action === 'favorite') {
            toggleFavoriteForChannel(channel);
            return;
        }
        openPlayer(channel);
    });
}
