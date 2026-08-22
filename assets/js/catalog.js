/*
 * Movies and Series catalogues.
 *
 * Both are the same scraper against the same site with a different listing path,
 * so they share one implementation driven by the CATALOGS descriptors below.
 */
const CATALOGS = {
    movies: {
        label: 'Movies',
        icon: 'fa-film',
        placeholder: 'Search PelisPedia...',
        listPath: '/peliculas/populares',
        linkHints: ['/pelicula/'],
        ids: {
            input: 'movieSearchInput',
            grid: 'movieGrid',
            loader: 'movieLoader',
            pagination: 'moviePagination',
            indicator: 'moviePageIndicator',
            prev: 'btnPrevMovie'
        }
    },
    series: {
        label: 'TV Series',
        icon: 'fa-tv',
        placeholder: 'Search Series...',
        listPath: '/series',
        linkHints: ['/serie/', '/tv/'],
        ids: {
            input: 'seriesSearchInput',
            grid: 'seriesGrid',
            loader: 'seriesLoader',
            pagination: 'seriesPagination',
            indicator: 'seriesPageIndicator',
            prev: 'btnPrevSeries'
        }
    }
};

const catalogState = {
    movies: { mode: 'POPULAR', page: 1, query: '' },
    series: { mode: 'POPULAR', page: 1, query: '' }
};

/* Entry points used by the navbar. */
function openMovies() { openCatalog('movies'); }
function openSeries() { openCatalog('series'); }

function openCatalog(key) {
    const catalog = CATALOGS[key];
    const ids = catalog.ids;

    currentView = key;
    currentSectionName = catalog.label;
    resetSearch();
    closeDropdown();
    useGridLayout();
    setSectionLabel(catalog.label);

    document.getElementById('app-content').innerHTML = `
        <div class="section-title"><i class="fas ${catalog.icon}"></i> ${catalog.label}</div>

        <div class="catalog-toolbar">
            <input type="text" id="${ids.input}" class="catalog-input" placeholder="${catalog.placeholder}"
                onkeypress="if(event.key === 'Enter') triggerCatalogSearch('${key}')">
            <button class="btn btn-play catalog-btn" onclick="triggerCatalogSearch('${key}')">
                <i class="fas fa-search"></i>
            </button>
            <button class="btn btn-info catalog-btn" onclick="resetCatalog('${key}')">Popular</button>
        </div>

        <div id="${ids.loader}" class="catalog-loader">
            <i class="fas fa-spinner fa-spin fa-2x"></i><br><br>Loading ${catalog.label}...
        </div>

        <div id="${ids.grid}" class="grid-container"></div>

        <div id="${ids.pagination}" class="catalog-pagination">
            <button class="btn btn-info" onclick="changeCatalogPage('${key}', -1)" id="${ids.prev}">Previous</button>
            <span id="${ids.indicator}" class="catalog-page">Page 1</span>
            <button class="btn btn-info" onclick="changeCatalogPage('${key}', 1)">Next</button>
        </div>`;

    fetchCatalog(key);
}

async function fetchCatalog(key) {
    const catalog = CATALOGS[key];
    const state = catalogState[key];
    const grid = document.getElementById(catalog.ids.grid);
    if (!grid) return; // The user navigated away mid-request.

    const loader = document.getElementById(catalog.ids.loader);
    const pagination = document.getElementById(catalog.ids.pagination);

    grid.innerHTML = '';
    loader.style.display = 'block';
    pagination.style.opacity = '0.5';
    pagination.style.pointerEvents = 'none';

    try {
        const doc = await fetchCatalogDocument(buildCatalogUrl(catalog, state));
        const items = scrapeCatalogItems(doc, catalog.linkHints)
            .map(extractCatalogItem)
            .filter(Boolean);

        if (items.length === 0) {
            grid.innerHTML = `<div class="catalog-message">No ${catalog.label.toLowerCase()} found.</div>`;
        } else {
            grid.innerHTML = items.map(createPosterCardHtml).join('');
        }

        document.getElementById(catalog.ids.indicator).innerText = `Page ${state.page}`;
        const prev = document.getElementById(catalog.ids.prev);
        prev.disabled = state.page === 1;
        prev.style.opacity = state.page === 1 ? 0.5 : 1;
    } catch (e) {
        console.error(e);
        grid.innerHTML = `<div class="catalog-message">Error loading content: ${escapeHtml(e.message)}</div>`;
    } finally {
        loader.style.display = 'none';
        pagination.style.opacity = '1';
        pagination.style.pointerEvents = 'auto';
        window.scrollTo(0, 0);
    }
}

function buildCatalogUrl(catalog, state) {
    if (state.mode === 'SEARCH') {
        const pageParam = state.page > 1 ? `&page=${state.page}` : '';
        return `${CATALOG_BASE_URL}/search?s=${encodeURIComponent(state.query)}${pageParam}`;
    }
    const pageParam = state.page > 1 ? `?page=${state.page}` : '';
    return `${CATALOG_BASE_URL}${catalog.listPath}${pageParam}`;
}

async function fetchCatalogDocument(targetUrl) {
    const response = await fetch(CATALOG_PROXY + encodeURIComponent(targetUrl));
    if (!response.ok) throw new Error('Proxy error');

    const data = await response.json();
    if (!data.contents) throw new Error('No data');

    return new DOMParser().parseFromString(data.contents, 'text/html');
}

/* The source markup varies, so try the known containers before falling back
   to "any link wrapping an image that looks like a title page". */
function scrapeCatalogItems(doc, linkHints) {
    let items = Array.from(doc.querySelectorAll('article'));
    if (items.length > 0) return items;

    items = Array.from(doc.querySelectorAll('li.movie, .result-item'));
    if (items.length > 0) return items;

    return Array.from(doc.querySelectorAll('a'))
        .filter(a => a.querySelector('img') && linkHints.some(hint => a.getAttribute('href')?.includes(hint)));
}

function extractCatalogItem(element) {
    const linkTag = element.tagName === 'A' ? element : element.querySelector('a');
    const imgTag = element.querySelector('img');
    if (!linkTag || !imgTag) return null;

    let link = linkTag.getAttribute('href');
    if (!link) return null;
    if (!link.startsWith('http')) link = CATALOG_BASE_URL + link;

    // The document comes from DOMParser and is never laid out, so innerText is
    // unavailable here — textContent is the only reliable read.
    let poster = imgTag.getAttribute('data-src') || imgTag.getAttribute('src') || '';
    if (poster && !poster.startsWith('http')) poster = CATALOG_BASE_URL + poster;

    const titleNode = element.querySelector('h2, h3, .title');
    const title = (titleNode ? titleNode.textContent : '').trim() || imgTag.getAttribute('alt') || 'Untitled';
    const yearNode = element.querySelector('.year, .date');
    const year = (yearNode ? yearNode.textContent : '').trim();

    return { title, poster, link, year };
}

function createPosterCardHtml(item) {
    return `
    <div class="card" data-href="${escapeAttr(item.link)}" style="background: ${getGradient(item.title)}">
        <img src="${escapeAttr(item.poster)}" onerror="this.style.opacity='0.1'" loading="lazy"
             alt="${escapeAttr(item.title)}" style="width:100%; height:100%; object-fit:cover;">
        <div class="card-info">
            <div class="poster-meta">
                <span class="channel-name">${escapeHtml(item.title)}</span>
                <span class="poster-year">${escapeHtml(item.year)}</span>
            </div>
        </div>
    </div>`;
}

/* --- Controls --- */
function triggerCatalogSearch(key) {
    const query = document.getElementById(CATALOGS[key].ids.input).value.trim();
    if (!query) return;
    Object.assign(catalogState[key], { mode: 'SEARCH', query, page: 1 });
    fetchCatalog(key);
}

function resetCatalog(key) {
    document.getElementById(CATALOGS[key].ids.input).value = '';
    Object.assign(catalogState[key], { mode: 'POPULAR', query: '', page: 1 });
    fetchCatalog(key);
}

function changeCatalogPage(key, delta) {
    const newPage = catalogState[key].page + delta;
    if (newPage < 1) return;
    catalogState[key].page = newPage;
    fetchCatalog(key);
}
