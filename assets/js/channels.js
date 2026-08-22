/* Fetching and parsing the M3U playlist. */

function updateProgressBar(percentage) {
    document.getElementById('progress-bar').style.width = percentage + '%';
}

async function fetchRepository() {
    try {
        updateProgressBar(30);
        const response = await fetch(REPO_URL);
        if (!response.ok) throw new Error('Network response was not ok');

        updateProgressBar(60);
        const text = await response.text();

        updateProgressBar(80);
        loadChannels(parseM3U(text).concat(HARDCODED_CHANNELS));
    } catch (error) {
        console.error('Error fetching repository:', error);
        showLoaderMessage('Failed to load channels.<br>Check internet connection.');
    }
}

/*
 * Parses `#EXTINF` blocks into channel objects.
 * `name` is the raw playlist name and acts as the persistence key (favourites,
 * collections); `displayName` is cleaned up and de-duplicated for the UI.
 */
function parseM3U(data) {
    const lines = data.split('\n');
    const channels = [];
    const usedDisplayNames = {};
    let currentItem = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (line.startsWith('#EXTINF:')) {
            const info = line.substring(8);
            const rawName = extractExtinfTitle(info);
            if (!rawName) continue;

            const logoMatch = line.match(/tvg-logo="([^"]*)"/);
            const groupMatch = line.match(/group-title="([^"]*)"/);

            // Drop trailing "(HD)" / "[1080p]" style qualifiers from the label.
            let cleanName = rawName.replace(/(\s*[\(\[][^\)\]]*[\)\]])+/g, '').trim() || rawName;

            usedDisplayNames[cleanName] = (usedDisplayNames[cleanName] || 0) + 1;
            const occurrence = usedDisplayNames[cleanName];

            currentItem = {
                name: rawName,
                displayName: occurrence > 1 ? `${cleanName} ${occurrence}` : cleanName,
                logo: logoMatch ? logoMatch[1] : '',
                groups: [groupMatch ? groupMatch[1] : 'Other'],
                url: ''
            };
        } else if (line.startsWith('http') && currentItem) {
            currentItem.url = line;
            channels.push(currentItem);
            currentItem = null;
        }
    }

    return channels;
}

/*
 * `#EXTINF:<duration> <attributes>,<title>`
 *
 * The title is everything after the first comma that is not inside a quoted
 * attribute value, so both commas in attributes and commas or quotes in the
 * channel name itself survive.
 */
function extractExtinfTitle(info) {
    let inQuotes = false;
    for (let i = 0; i < info.length; i++) {
        const char = info[i];
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) return info.slice(i + 1).trim();
    }
    return info.trim();
}

function loadChannels(channels) {
    updateProgressBar(100);
    setTimeout(() => { document.getElementById('progress-container').style.opacity = '0'; }, 1000);

    if (channels.length === 0) {
        showLoaderMessage('Provider returned 0 channels.');
        return;
    }

    setChannels(channels);
    document.getElementById('skeleton-loader').style.display = 'none';
    updateDropdownMenu();
    renderAllSections();
    initHero();
}

function showLoaderMessage(html) {
    document.getElementById('skeleton-loader').innerHTML =
        `<div style="text-align:center; padding-top:200px; color:white;">${html}</div>`;
}
