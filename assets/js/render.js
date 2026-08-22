/* Card / row / grid rendering plus the delegated click handling for #app-content. */

function createCardHtml(channel) {
    const logo = hasLogo(channel);
    const isFav = favoriteNames.includes(channel.name);
    const name = escapeHtml(channel.displayName);

    return `
    <div class="card" data-channel-id="${escapeAttr(channel.id)}" style="background: ${getGradient(channel.name)}">
        ${logo
            ? `<img src="${escapeAttr(channel.logo)}" onerror="this.style.display='none'" loading="lazy" alt="${escapeAttr(channel.displayName)}" style="max-width:100%; object-fit:contain;">`
            : `<div class="card-fallback-title">${name}</div>`}
        <div class="card-info">
            <div class="card-actions">
                <div class="action-btn" data-action="collection" title="Add to section"><i class="fas fa-list"></i></div>
                <div class="action-btn" data-action="favorite" title="Favorite" style="${isFav ? 'background:white; color:red;' : ''}"><i class="${isFav ? 'fas' : 'far'} fa-heart"></i></div>
                <div class="action-btn" data-action="play" title="Play"><i class="fas fa-play"></i></div>
            </div>
            <div><span class="badge-live">LIVE</span><span class="channel-name">${name}</span></div>
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
}

function renderGrid(title, channels) {
    const cards = channels.map(createCardHtml).join('');
    document.getElementById('app-content').innerHTML =
        `<div class="section-title">${escapeHtml(title)}</div><div class="grid-container">${cards}</div>`;
}

function scrollRow(rowId, direction) {
    const row = document.getElementById(rowId);
    if (row) row.scrollBy({ left: direction * 300, behavior: 'smooth' });
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
