/* Favourites and user-defined collections ("My Sections"). */

/* --- Favourites --- */
function isFavorite(channel) {
    return Boolean(channel) && favoriteNames.includes(channel.name);
}

function toggleFavoriteForChannel(channel) {
    if (!channel) return;

    const index = favoriteNames.indexOf(channel.name);
    const adding = index === -1;
    if (adding) favoriteNames.push(channel.name);
    else favoriteNames.splice(index, 1);
    saveFavorites();

    if (currentChannel && currentChannel.name === channel.name) updateFavButtonState();
    showToast(adding ? `Added to favorites: ${channel.displayName}` : `Removed from favorites: ${channel.displayName}`);

    // The favourites view and the home row must drop/gain the entry; every other
    // view only needs the one card repainted, which keeps the scroll position.
    if (currentView === 'favorites' || currentView === 'home') refreshCurrentView();
    else repaintCardFavorite(channel);

    if (document.getElementById('videoModal').style.display === 'flex') renderPlayerCarousel();
}

/* Player button — acts on the channel currently playing. */
function toggleFavorite() {
    toggleFavoriteForChannel(currentChannel);
}

function repaintCardFavorite(channel) {
    const card = document.querySelector(`.card[data-channel-id="${channel.id}"]`);
    if (!card) return;
    const btn = card.querySelector('[data-action="favorite"]');
    if (!btn) return;
    const fav = isFavorite(channel);
    btn.style.cssText = fav ? 'background:white; color:red;' : '';
    btn.querySelector('i').className = `${fav ? 'fas' : 'far'} fa-heart`;
}

function updateFavButtonState() {
    const btn = document.getElementById('favBtn');
    if (!btn) return;
    const fav = isFavorite(currentChannel);
    btn.classList.toggle('active', fav);
    btn.querySelector('i').className = `${fav ? 'fas' : 'far'} fa-heart`;
}

/* --- Collections --- */
function createNewSection() {
    const input = document.getElementById('newSectionInput');
    const name = input.value.trim();
    if (!name) return;

    customSections.push({ id: 'sec_' + Date.now(), name, channels: [] });
    saveCustomSections();
    input.value = '';
    updateDropdownMenu(currentSectionName || 'Home');
    refreshCollectionModal();
    showToast(`Section "${name}" created`);
}

function deleteSection(id) {
    if (!confirm('Delete this section?')) return;

    const wasCurrent = currentView === 'custom' && currentSectionId === id;
    customSections = customSections.filter(s => s.id !== id);
    saveCustomSections();

    if (wasCurrent) renderAllSections();
    else refreshCurrentView();

    if (targetCollectionChannel) refreshCollectionModal();
}

function openCollectionModalForCurrent() {
    if (currentChannel) openCollectionModal(currentChannel);
}

function openCollectionModal(channel) {
    targetCollectionChannel = channel;
    document.getElementById('collectionTargetName').innerText = `Add "${channel.displayName}" to:`;
    document.getElementById('collectionModal').style.display = 'flex';
    refreshCollectionModal();
}

function closeCollectionModal(e) {
    // Ignore clicks that bubbled up from inside the dialog.
    if (e && e.target !== document.getElementById('collectionModal')) return;

    document.getElementById('collectionModal').style.display = 'none';
    targetCollectionChannel = null;

    // A collection currently on screen may have gained or lost channels.
    if (currentView === 'custom') refreshCurrentView();
}

function refreshCollectionModal() {
    const list = document.getElementById('collectionList');
    list.innerHTML = '';
    if (!targetCollectionChannel) return;

    if (customSections.length === 0) {
        list.innerHTML = '<div style="color:#666; padding:10px; text-align:center;">No custom sections.<br>Create one above.</div>';
        return;
    }

    customSections.forEach(sec => {
        const isPresent = sec.channels.includes(targetCollectionChannel.name);
        const item = document.createElement('div');
        item.className = 'collection-item';
        item.innerHTML = `<input type="checkbox" class="checkbox-custom" ${isPresent ? 'checked' : ''}><span></span>`;
        item.querySelector('span').innerText = sec.name;

        item.onclick = (e) => {
            const checkbox = item.querySelector('input');
            if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
            toggleChannelInSection(sec.id, checkbox.checked);
        };
        list.appendChild(item);
    });
}

function toggleChannelInSection(sectionId, isAdding) {
    const section = customSections.find(s => s.id === sectionId);
    if (!section || !targetCollectionChannel) return;

    const name = targetCollectionChannel.name;
    if (isAdding) {
        if (!section.channels.includes(name)) section.channels.push(name);
    } else {
        section.channels = section.channels.filter(n => n !== name);
    }
    saveCustomSections();
}
