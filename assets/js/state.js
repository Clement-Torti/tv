/* Shared mutable state plus its localStorage persistence. */

let allChannels = [];

// id -> channel, so the DOM can reference channels by id instead of
// embedding serialised JSON in onclick attributes.
const channelsById = new Map();

let favoriteNames = readStore(STORAGE_KEYS.favorites, []);
let customSections = readStore(STORAGE_KEYS.sections, []);

// Which view is on screen: home | category | custom | favorites | search | movies | series
let currentView = 'home';
let currentSearchQuery = '';
let currentSectionName = '';
let currentSectionId = '';

let currentChannel = null;
let targetCollectionChannel = null;

function readStore(key, fallback) {
    try {
        const raw = JSON.parse(localStorage.getItem(key));
        return Array.isArray(raw) ? raw : fallback;
    } catch (e) {
        console.warn(`Corrupt localStorage entry "${key}", resetting.`, e);
        return fallback;
    }
}

function saveFavorites() {
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(favoriteNames));
}

function saveCustomSections() {
    localStorage.setItem(STORAGE_KEYS.sections, JSON.stringify(customSections));
}

/* Registers the channel list and gives every entry a stable id. */
function setChannels(channels) {
    allChannels = channels;
    channelsById.clear();
    allChannels.forEach((channel, index) => {
        channel.id = 'ch' + index;
        channelsById.set(channel.id, channel);
    });
}

function getChannelById(id) {
    return channelsById.get(id) || null;
}
