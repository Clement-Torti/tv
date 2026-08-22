/* Navigation: search box, section dropdown and the top-level views. */

/* --- Search box --- */
function toggleSearchBox() {
    const box = document.getElementById('searchBox');
    const input = document.getElementById('searchInput');
    box.classList.toggle('active');
    if (box.classList.contains('active')) input.focus();
    else if (input.value === '') input.blur();
}

function resetSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchBox').classList.remove('active');
    currentSearchQuery = '';
}

function handleSearch(query) {
    if (!query) {
        // Only fall back home if the search view is what is on screen.
        if (currentView === 'search') renderAllSections();
        return;
    }

    currentView = 'search';
    currentSearchQuery = query;
    updateDropdownMenu('Search');
    useGridLayout();

    const lowerQ = query.toLowerCase();
    let results = allChannels.filter(c =>
        c.name.toLowerCase().includes(lowerQ) ||
        c.displayName.toLowerCase().includes(lowerQ)
    );
    if (results.length > LIMITS.searchResults) results = results.slice(0, LIMITS.searchResults);

    if (results.length > 0) renderGrid(`Results: "${query}"`, results);
    else renderEmptyState('Search', 'No results.');
}

/* --- Dropdown --- */
function toggleDropdown() {
    document.getElementById('navDropdownMenu').classList.toggle('show');
}

function closeDropdown() {
    document.getElementById('navDropdownMenu').classList.remove('show');
}

function updateDropdownMenu(activeName = 'Home') {
    const isActive = name => (name === activeName ? ' active' : '');
    const parts = [
        `<div class="nav-item${isActive('Home')}" data-nav="home">Home</div>`,
        '<div class="nav-divider"></div>',
        `<div class="nav-item${isActive('My Favorites')}" data-nav="favorites">My Favorites</div>`
    ];

    if (customSections.length > 0) {
        parts.push('<div class="nav-header">My Sections</div>');
        customSections.forEach(sec => {
            parts.push(
                `<div class="nav-item${isActive(sec.name)}">` +
                `<span data-nav="custom" data-id="${escapeAttr(sec.id)}" style="flex-grow:1">${escapeHtml(sec.name)}</span>` +
                `<span class="delete-section-btn" data-nav="delete" data-id="${escapeAttr(sec.id)}"><i class="fas fa-trash"></i></span>` +
                '</div>'
            );
        });
    }

    parts.push('<div class="nav-divider"></div><div class="nav-header">Categories</div>');
    STANDARD_SECTIONS.concat(['Other']).forEach(sec => {
        parts.push(`<div class="nav-item${isActive(sec)}" data-nav="section" data-name="${escapeAttr(sec)}">${escapeHtml(sec)}</div>`);
    });

    document.getElementById('navDropdownMenu').innerHTML = parts.join('');
    setSectionLabel(activeName === 'Home' ? 'TV' : activeName);
}

function setSectionLabel(label) {
    const el = document.getElementById('currentSectionLabel');
    if (el) el.innerText = label;
}

/* One delegated handler for the whole dropdown, so section names never have to
   be escaped into inline onclick attributes. */
function initNavigation() {
    document.getElementById('navDropdownMenu').addEventListener('click', (e) => {
        const target = e.target.closest('[data-nav]');
        if (!target) return;

        const { nav, id, name } = target.dataset;
        if (nav === 'delete') {
            e.stopPropagation();
            deleteSection(id);
            return;
        }

        closeDropdown();
        resetSearch();
        if (nav === 'home') renderAllSections();
        else if (nav === 'favorites') renderFavorites();
        else if (nav === 'custom') filterByCustomSection(id);
        else if (nav === 'section') filterBySection(name);
    });

    // Close the dropdown when clicking anywhere outside of it.
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.nav-dropdown-container')) closeDropdown();
    });

    // Collapse the search field once it loses focus while empty.
    document.addEventListener('click', (e) => {
        const box = document.getElementById('searchBox');
        const input = document.getElementById('searchInput');
        if (!box.contains(e.target) && input.value === '') box.classList.remove('active');
    });
}

/* --- Layout helpers --- */
function useGridLayout() {
    document.getElementById('hero').classList.add('hidden');
    const content = document.getElementById('app-content');
    content.classList.remove('section-home');
    content.classList.add('section-grid');
    return content;
}

function useHomeLayout() {
    document.getElementById('hero').classList.remove('hidden');
    const content = document.getElementById('app-content');
    content.classList.remove('section-grid');
    content.classList.add('section-home');
    content.innerHTML = '';
    return content;
}

function renderEmptyState(title, message) {
    document.getElementById('app-content').innerHTML =
        `<div class="section-title">${escapeHtml(title)}</div><div style="padding:20px">${message}</div>`;
}

/* --- Views --- */
function renderAllSections() {
    currentView = 'home';
    currentSectionName = '';
    currentSectionId = '';
    updateDropdownMenu('Home');
    useHomeLayout();

    const favs = allChannels.filter(c => favoriteNames.includes(c.name));
    if (favs.length > 0) renderRow('My Favorites', favs, true);

    customSections.forEach(sec => {
        const secChannels = allChannels.filter(c => sec.channels.includes(c.name));
        if (secChannels.length > 0) renderRow(sec.name, secChannels);
    });

    STANDARD_SECTIONS.forEach(section => {
        const sectionChannels = allChannels.filter(c => channelMatchesSection(c, section));
        if (sectionChannels.length > 0) renderRow(section, sectionChannels);
    });

    const otherChannels = allChannels.filter(c => !isCategorised(c));
    if (otherChannels.length > 0) {
        const subset = otherChannels.slice().sort(() => 0.5 - Math.random()).slice(0, LIMITS.discoverRow);
        renderRow('Discover', subset);
    }
}

function filterBySection(sectionName) {
    currentView = 'category';
    currentSectionName = sectionName;
    updateDropdownMenu(sectionName);
    useGridLayout();

    let sectionChannels;
    if (sectionName === 'Other') {
        sectionChannels = allChannels.filter(c => !isCategorised(c)).slice(0, LIMITS.otherSection);
    } else {
        sectionChannels = allChannels.filter(c => channelMatchesSection(c, sectionName));
    }

    if (sectionChannels.length > 0) renderGrid(sectionName, sectionChannels);
    else renderEmptyState(sectionName, 'No channels found.');
}

function filterByCustomSection(id) {
    const section = customSections.find(s => s.id === id);
    if (!section) return renderAllSections();

    currentView = 'custom';
    currentSectionId = id;
    currentSectionName = section.name;
    updateDropdownMenu(section.name);
    useGridLayout();

    const channels = allChannels.filter(c => section.channels.includes(c.name));
    if (channels.length > 0) renderGrid(section.name, channels);
    else renderEmptyState(section.name, 'Section empty. Add channels via player.');
}

function renderFavorites() {
    currentView = 'favorites';
    currentSectionName = 'My Favorites';
    updateDropdownMenu('My Favorites');
    useGridLayout();

    const favs = allChannels.filter(c => favoriteNames.includes(c.name));
    if (favs.length > 0) renderGrid('My Favorites', favs);
    else renderEmptyState('My Favorites', 'No favorites yet.');
}

/* Re-renders whatever view is currently on screen. */
function refreshCurrentView() {
    switch (currentView) {
        case 'search': return handleSearch(currentSearchQuery);
        case 'favorites': return renderFavorites();
        case 'custom': return filterByCustomSection(currentSectionId);
        case 'category': return filterBySection(currentSectionName);
        case 'movies': return openMovies();
        case 'series': return openSeries();
        default: return renderAllSections();
    }
}

function channelMatchesSection(channel, section) {
    const needle = section.toLowerCase();
    return channel.groups.some(g => g && g.toLowerCase().includes(needle));
}

function isCategorised(channel) {
    return STANDARD_SECTIONS.some(section => channelMatchesSection(channel, section));
}
