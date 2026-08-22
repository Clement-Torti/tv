/* Boot loader: pulls the sources, merges them, and hands the result to the UI. */

function updateProgressBar(percentage) {
    document.getElementById('progress-bar').style.width = percentage + '%';
}

async function loadChannelList() {
    try {
        updateProgressBar(15);
        const raw = await fetchAllSources();

        updateProgressBar(70);
        // Yield once so the progress bar paints before the merge blocks the thread.
        await new Promise(resolve => setTimeout(resolve, 0));
        const channels = mergeSources(raw);

        updateProgressBar(95);
        installChannels(channels);
    } catch (error) {
        console.error('Error loading channels:', error);
        showLoaderMessage('Failed to load channels.<br>Check internet connection.');
    }
}

function installChannels(channels) {
    updateProgressBar(100);
    setTimeout(() => { document.getElementById('progress-container').style.opacity = '0'; }, 1000);

    if (channels.length === 0) {
        showLoaderMessage('Sources returned 0 channels.');
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
