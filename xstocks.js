// -- State --
let watchlists = [];
let activeWatchlistId = null;
let quotes = [];
let selectedSymbol = null;
let currentTab = 'watchlist';
// historyCache holds yfinance chart data for the entire session. Keyed by `${symbol}_${period}`.
// Shape: { data, fetchedDate } where fetchedDate is local YYYY-MM-DD.
// Never cleared on watchlist/symbol switches — the cache is symbol+period-scoped, so other
// entries are still valid. The Refresh button overwrites the current entry. Stale entries
// (fetched on a previous weekday) trigger an auto-refetch on access.
let historyCache = {};
// Analysis-tab caches, keyed by symbol, same { data, fetchedDate } shape and staleness
// rules as historyCache. Split because the options panel is a much slower fetch and loads
// separately from the fast panels.
let analysisCache = {};
let optionsCache = {};
let chartPeriod = '1y';
let sortCol = 'symbol';
let sortAsc = true;
let tickerClickAction = 'yahoo';
// Auto-refresh settings — only used to populate the Settings form. The actual scheduling
// happens in Python; JS doesn't manage any timer for this.
let autoRefreshEnabled = false;
let autoRefreshTime = '17:00';
// Custom From DB mode state — global, persists across symbol switches within a session
let customStartDate = null;
let customEndDate = null;

// Multi (comparison) mode state — Chart tab only.
// multiMode: whether the comparison basket is active. Shared across the Chart (overlaid
// % lines) and Analysis (side-by-side columns) tabs; News/Earnings suspend it to single.
// multiSelected: symbols in the comparison, in selection order — order drives color assignment.
// Both reset on watchlist switch and are pruned when a selected symbol leaves the watchlist.
let multiMode = false;
let multiSelected = [];
// Categorical palette for Multi mode. Indexed by selection order (MULTI_COLORS[i]).
// Deliberately avoids --green/--red, which carry up/down meaning elsewhere in the app.
// Multi-select is capped at this length (currently 8).
const MULTI_COLORS = [
    '#6c8cff', '#e8a838', '#4dd0c0', '#e0719c',
    '#9b7ede', '#8fce5a', '#f0883e', '#5ac8e8',
];

// -- Helpers --
function setHeaderButtonsDisabled(disabled) {
    document.getElementById('refreshBtn').disabled = disabled;
    document.getElementById('settingsBtn').disabled = disabled;
}

function tickerUrl(symbol) {
    const s = encodeURIComponent(symbol);
    return tickerClickAction === 'google'
        ? `https://www.google.com/search?q=${s}+stock`
        : `https://finance.yahoo.com/quote/${s}/`;
}

// Local-time YYYY-MM-DD (not UTC) — staleness is defined in the user's calendar day.
function todayLocalYMD() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// A cache entry is stale if it was fetched on a previous calendar day AND today is a weekday.
// Weekend access of a Friday cache returns false (no new data could have been published
// over the weekend). Doesn't account for market holidays — one unnecessary fetch on a
// holiday is the acceptable cost of not maintaining a calendar.
function isCacheStale(cached) {
    if (!cached || !cached.fetchedDate) return true;
    const today = todayLocalYMD();
    if (cached.fetchedDate >= today) return false;
    const dow = new Date().getDay(); // 0=Sun, 6=Sat
    return dow !== 0 && dow !== 6;
}

// -- Init --
async function init() {
    const cfg = await app.call('get_config');
    tickerClickAction = cfg.ticker_click_action || 'yahoo';
    autoRefreshEnabled = !!cfg.auto_refresh_enabled;
    autoRefreshTime = cfg.auto_refresh_time || '17:00';
    if (!cfg.has_api_key) {
        showSetup();
        return;
    }
    watchlists = await app.call('get_watchlists');
    if (watchlists.length === 0) {
        showAddWatchlist();
        return;
    }
    activeWatchlistId = watchlists[0].id;
    document.getElementById('tabBar').style.display = 'flex';
    await loadQuotes();
}

// -- API Key Setup --
function showSetup() {
    setHeaderButtonsDisabled(true);
    document.getElementById('tabBar').style.display = 'none';
    document.getElementById('content').innerHTML = `
        <div class="setup">
            <h2>Welcome to xstocks</h2>
            <p>Enter your Finnhub API key to get started. Get a free key at
               <strong>finnhub.io</strong></p>
            <input type="text" id="apiKeyInput" placeholder="Your Finnhub API key">
            <button class="btn primary" onclick="saveApiKey()">Save & Continue</button>
        </div>
    `;
}

async function saveApiKey() {
    const key = document.getElementById('apiKeyInput').value;
    if (!key.trim()) return;
    await app.call('set_api_key', { key });
    watchlists = await app.call('get_watchlists');
    if (watchlists.length === 0) {
        showAddWatchlist();
    } else {
        activeWatchlistId = watchlists[0].id;
        document.getElementById('tabBar').style.display = 'flex';
        await loadQuotes();
    }
}

// -- Add Watchlist Form --
function showAddWatchlist() {
    setHeaderButtonsDisabled(true);
    document.getElementById('tabBar').style.display = watchlists.length > 0 ? 'flex' : 'none';
    const el = document.getElementById('content');
    el.innerHTML = `
        <div class="setup">
            <h2>Add a New Watchlist</h2>
            <input type="text" id="watchlistNameInput" placeholder="Watchlist Name"
                   onkeydown="if(event.key==='Enter') document.getElementById('watchlistTickersInput').focus()">
            <input type="text" id="watchlistTickersInput" placeholder="Tickers: AAPL, AMZN, GOOG, ..."
                   onkeydown="if(event.key==='Enter') submitAddWatchlist()">
            <div class="form-actions">
                <button class="btn primary" onclick="submitAddWatchlist()">Add</button>
                ${watchlists.length > 0 ? '<button class="btn" onclick="cancelAddWatchlist()">Cancel</button>' : ''}
            </div>
        </div>
    `;
}

async function submitAddWatchlist() {
    const name = document.getElementById('watchlistNameInput').value.trim();
    const tickers = document.getElementById('watchlistTickersInput').value.trim();
    if (!name || !tickers) return;

    setStatus('Creating watchlist...');
    try {
        const data = await app.call('add_watchlist', { name, tickers });
        if (data.status === 'name_exists') {
            setStatus('Watchlist Name Already Exists');
            return;
        }
        if (data.status === 'ticker_not_found') {
            setStatus('Invalid Tickers: ' + data.invalid_tickers.join(', '));
            return;
        }
        watchlists = data.watchlists;
        activeWatchlistId = data.watchlist.id;
        document.getElementById('tabBar').style.display = 'flex';
        applyQuoteData(data);
        if (data.invalid_tickers && data.invalid_tickers.length > 0) {
            setStatus('Invalid Tickers: ' + data.invalid_tickers.join(', '));
        }
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

function cancelAddWatchlist() {
    renderCurrentTab();
}

// -- Reorder Watchlists --
// Working copy mutated by user; not committed to DB until submit.
let reorderState = [];
let inReorderView = false;

function showReorderWatchlists() {
    inReorderView = true;
    setHeaderButtonsDisabled(true);
    reorderState = watchlists.map(w => ({ id: w.id, name: w.name }));
    renderReorderView();
}

function renderReorderView() {
    // Guard: deferred blur-renders shouldn't resurrect the view after cancel
    if (!inReorderView) return;
    const el = document.getElementById('content');
    const rows = reorderState.map((w, idx) => `
        <div class="reorder-row">
            <button class="btn reorder-btn" onclick="reorderMoveUp(${w.id})" title="Move up">↑</button>
            <button class="btn reorder-btn" onclick="reorderMoveDown(${w.id})" title="Move down">↓</button>
            <input type="text" class="reorder-pos" value="${idx + 1}"
                   data-id="${w.id}"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();reorderCommitInput(this,false);}"
                   onblur="reorderCommitInput(this,true)">
            <span class="reorder-name">${escapeHtml(w.name)}</span>
        </div>
    `).join('');

    el.innerHTML = `
        <div class="setup">
            <h2>Reorder Watchlists</h2>
            <div class="reorder-list">${rows}</div>
            <div class="form-actions">
                <button class="btn primary" onclick="submitReorderWatchlists()">Update</button>
                <button class="btn" onclick="renderCurrentTab()">Cancel</button>
            </div>
        </div>
    `;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function reorderMoveUp(id) {
    const idx = reorderState.findIndex(w => w.id === id);
    if (idx === -1) return;
    const n = reorderState.length;
    if (idx === 0) {
        const [item] = reorderState.splice(0, 1);
        reorderState.push(item);
    } else {
        [reorderState[idx - 1], reorderState[idx]] = [reorderState[idx], reorderState[idx - 1]];
    }
    renderReorderView();
}

function reorderMoveDown(id) {
    const idx = reorderState.findIndex(w => w.id === id);
    if (idx === -1) return;
    const n = reorderState.length;
    if (idx === n - 1) {
        const [item] = reorderState.splice(n - 1, 1);
        reorderState.unshift(item);
    } else {
        [reorderState[idx], reorderState[idx + 1]] = [reorderState[idx + 1], reorderState[idx]];
    }
    renderReorderView();
}

function reorderCommitInput(inputEl, fromBlur) {
    const id = parseInt(inputEl.dataset.id, 10);
    const oldIdx = reorderState.findIndex(w => w.id === id);
    if (oldIdx === -1) return;
    const raw = inputEl.value.trim();
    const n = reorderState.length;

    // Validate: must be a clean integer string, in range 1..n, and different from current
    const looksClean = /^\d+$/.test(raw);
    const parsed = parseInt(raw, 10);
    const valid = looksClean && parsed >= 1 && parsed <= n && parsed !== oldIdx + 1;

    if (valid) {
        const newIdx = parsed - 1;
        const [item] = reorderState.splice(oldIdx, 1);
        reorderState.splice(newIdx, 0, item);
    }

    // From blur: defer so any pending click (Move Up/Down, Update, Cancel) fires
    // first on the still-existing DOM. From Enter: render immediately.
    if (fromBlur) {
        setTimeout(renderReorderView, 0);
    } else {
        renderReorderView();
    }
}

async function submitReorderWatchlists() {
    const orderedIds = reorderState.map(w => w.id);
    try {
        const data = await app.call('reorder_watchlists', { ordered_ids: orderedIds });
        watchlists = data.watchlists;
        renderCurrentTab();
        setStatus('Watchlists reordered');
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

// -- Settings --
function showSettings() {
    setHeaderButtonsDisabled(true);
    const el = document.getElementById('content');
    el.innerHTML = `
        <div class="setup">
            <h2>Settings</h2>
            <p>Set method for what to do when stock ticker is clicked in the watchlist:</p>
            <div class="settings-options">
                <label class="settings-option">
                    <input type="radio" name="tickerClickAction" value="yahoo"
                           ${tickerClickAction === 'yahoo' ? 'checked' : ''}>
                    Go to Yahoo Finance
                </label>
                <label class="settings-option">
                    <input type="radio" name="tickerClickAction" value="google"
                           ${tickerClickAction === 'google' ? 'checked' : ''}>
                    Do Google search
                </label>
            </div>
            <hr class="settings-hr">
            <div class="settings-row">
                <label class="settings-option">
                    <input type="checkbox" id="autoRefreshCheckbox"
                           ${autoRefreshEnabled ? 'checked' : ''}
                           onchange="onAutoRefreshToggle(this.checked)">
                    Automatically refresh data at
                </label>
                <input type="time" id="autoRefreshTimeInput" class="time-input"
                       value="${escapeHtml(autoRefreshTime)}"
                       ${autoRefreshEnabled ? '' : 'disabled'}
                       style="${autoRefreshEnabled ? '' : 'opacity:0.4'}">
            </div>
            <div class="form-actions">
                <button class="btn primary" onclick="submitSettings()">Save</button>
                <button class="btn" onclick="renderCurrentTab()">Cancel</button>
            </div>
        </div>
    `;
}

function onAutoRefreshToggle(checked) {
    const timeInput = document.getElementById('autoRefreshTimeInput');
    timeInput.disabled = !checked;
    timeInput.style.opacity = checked ? '' : '0.4';
}

async function submitSettings() {
    const choice = document.querySelector('input[name="tickerClickAction"]:checked');
    if (!choice) return;
    const tickerVal = choice.value;
    const checkbox = document.getElementById('autoRefreshCheckbox');
    const timeInput = document.getElementById('autoRefreshTimeInput');
    const enabled = checkbox.checked;
    const time = timeInput.value || '17:00';
    try {
        await app.call('set_settings', {
            ticker_click_action: tickerVal,
            auto_refresh_enabled: enabled,
            auto_refresh_time: time,
        });
        tickerClickAction = tickerVal;
        autoRefreshEnabled = enabled;
        autoRefreshTime = time;
        renderCurrentTab();
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

// -- Edit Watchlist --
function showEditWatchlist() {
    const wl = watchlists.find(w => w.id === activeWatchlistId);
    if (!wl) return;

    setHeaderButtonsDisabled(true);

    const currentTickers = quotes.map(q => q.symbol).sort().join(', ');

    const el = document.getElementById('content');
    el.innerHTML = `
        <div class="setup">
            <h2>Edit ${wl.name}</h2>
            <input type="text" id="watchlistNameInput" placeholder="Watchlist Name" value="${wl.name}"
                   onkeydown="if(event.key==='Enter') document.getElementById('watchlistTickersInput').focus()">
            <input type="text" id="watchlistTickersInput" placeholder="Tickers: AAPL, AMZN, GOOG, ..." value="${currentTickers}"
                   onkeydown="if(event.key==='Enter') submitEditWatchlist()">
            <div class="form-actions">
                <button class="btn primary" onclick="submitEditWatchlist()">Update</button>
                <button class="btn" onclick="renderCurrentTab()">Cancel</button>
                <button class="btn danger" onclick="deleteWatchlist()">Delete</button>
            </div>
        </div>
    `;
}

async function submitEditWatchlist() {
    const name = document.getElementById('watchlistNameInput').value.trim();
    const tickers = document.getElementById('watchlistTickersInput').value.trim();
    if (!name || !tickers) return;

    setStatus('Updating watchlist...');
    try {
        const data = await app.call('update_watchlist', {
            watchlist_id: activeWatchlistId, name, tickers
        });
        if (data.status === 'name_exists') {
            setStatus('Watchlist Name Already Exists');
            return;
        }
        if (data.status === 'ticker_not_found') {
            setStatus('Invalid Tickers: ' + data.invalid_tickers.join(', '));
            return;
        }
        watchlists = data.watchlists;
        activeWatchlistId = data.watchlist.id;
        applyQuoteData(data);
        if (data.invalid_tickers && data.invalid_tickers.length > 0) {
            setStatus('Invalid Tickers: ' + data.invalid_tickers.join(', '));
        }
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

async function deleteWatchlist() {
    const wl = watchlists.find(w => w.id === activeWatchlistId);
    if (!wl) return;
    if (!confirm(`Are You Sure You Want to Delete This Watchlist?`)) return;

    try {
        const data = await app.call('delete_watchlist', { watchlist_id: activeWatchlistId });
        watchlists = data.watchlists;
        if (watchlists.length > 0) {
            activeWatchlistId = watchlists[0].id;
            selectedSymbol = null;
            await loadQuotes();
        } else {
            activeWatchlistId = null;
            quotes = [];
            selectedSymbol = null;
            showAddWatchlist();
            setStatus('Ready');
            document.getElementById('statusTime').textContent = '';
        }
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

// -- Load cached quotes --
async function loadQuotes() {
    setStatus('Loading...');
    try {
        const data = await app.call('get_quotes', { watchlist_id: activeWatchlistId });
        applyQuoteData(data);
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

// -- Context-specific refresh --
async function handleRefresh(event) {
    if (!activeWatchlistId) return;

    // Shift-click → bulk refresh across all watchlists, regardless of current tab.
    if (event && event.shiftKey) {
        setHeaderButtonsDisabled(true);
        setStatus('Bulk refreshing all watchlists...');
        try {
            const result = await app.call('bulk_refresh_quotes');
            // Reload the active watchlist's quotes from cache (data was just written)
            const data = await app.call('get_quotes', { watchlist_id: activeWatchlistId });
            applyQuoteData(data);
            setStatus(`Bulk refreshed ${result.watchlists_refreshed} watchlist${result.watchlists_refreshed === 1 ? '' : 's'} (${result.symbols_fetched} symbol${result.symbols_fetched === 1 ? '' : 's'})`);
        } catch (e) {
            setStatus('Error: ' + e.message);
        }
        setHeaderButtonsDisabled(false);
        return;
    }

    setHeaderButtonsDisabled(true);
    try {
        if (currentTab === 'watchlist') {
            setStatus('Fetching quotes...');
            const data = await app.call('refresh_quotes', { watchlist_id: activeWatchlistId });
            applyQuoteData(data);
        } else if (currentTab === 'chart' && multiMode) {
            if (multiSelected.length === 0) {
                setHeaderButtonsDisabled(false);
                return;
            }
            setStatus(`Refreshing ${multiSelected.length} ticker${multiSelected.length === 1 ? '' : 's'}...`);
            await Promise.all(multiSelected.map(async sym => {
                const data = await app.call('get_history', { symbol: sym, period: chartPeriod });
                historyCache[`${sym}_${chartPeriod}`] = { data, fetchedDate: todayLocalYMD() };
            }));
            renderCurrentTab();
            setStatus('Refreshed');
        } else if (currentTab === 'chart' && selectedSymbol) {
            if (chartPeriod === 'custom_db') {
                setStatus(`Loading ${selectedSymbol} from DB...`);
                // No cache to invalidate; renderChart will re-query the DB.
                renderCurrentTab();
                setStatus('Refreshed');
            } else {
                const cacheKey = `${selectedSymbol}_${chartPeriod}`;
                setStatus(`Loading ${selectedSymbol} history...`);
                const data = await app.call('get_history', { symbol: selectedSymbol, period: chartPeriod });
                historyCache[cacheKey] = { data, fetchedDate: todayLocalYMD() };
                renderCurrentTab();
                setStatus(data.length < 2 ? 'Not enough data for this period' : 'Refreshed');
            }
        } else if (currentTab === 'analysis' && multiMode) {
            multiSelected.forEach(s => { delete analysisCache[s]; delete optionsCache[s]; });
            renderCurrentTab();
        } else if (currentTab === 'analysis' && selectedSymbol) {
            // Drop both caches for this symbol so renderAnalysis re-fetches fast + options.
            delete analysisCache[selectedSymbol];
            delete optionsCache[selectedSymbol];
            renderCurrentTab();
        }
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
    setHeaderButtonsDisabled(false);
}

// -- Apply quote data to state and UI --
function applyQuoteData(data) {
    quotes = data.quotes;
    // Reset selected symbol if it's not in the current quotes
    if (!selectedSymbol || !quotes.find(q => q.symbol === selectedSymbol)) {
        selectedSymbol = quotes.length > 0 ? quotes[0].symbol : null;
    }
    // Prune any multi-selected symbols no longer in the watchlist; drop out of multi if emptied.
    if (multiSelected.length) {
        multiSelected = multiSelected.filter(s => quotes.find(q => q.symbol === s));
        if (multiSelected.length === 0) multiMode = false;
    }
    renderCurrentTab();
    updateStatusBar(data.status, data.timestamp);
}

// -- Watchlist switching --
function handleWatchlistChange(value) {
    if (value === '__add__') {
        showAddWatchlist();
        return;
    }
    if (value === '__reorder__') {
        showReorderWatchlists();
        return;
    }
    activeWatchlistId = parseInt(value);
    selectedSymbol = null;
    multiMode = false;
    multiSelected = [];
    loadQuotes();
}

function cycleWatchlist(delta) {
    if (watchlists.length <= 1) return;
    const currentIdx = watchlists.findIndex(w => w.id === activeWatchlistId);
    if (currentIdx === -1) return;
    const newIdx = (currentIdx + delta + watchlists.length) % watchlists.length;
    handleWatchlistChange(String(watchlists[newIdx].id));
}

function prevWatchlist() { cycleWatchlist(-1); }
function nextWatchlist() { cycleWatchlist(1); }

// Watchlist navigation controls — shared by all four tabs.
// 'labeled' variant: [◀ Prev][Next ▶], used on the Watchlist tab (which already has a dropdown elsewhere on the row).
// 'compact' variant: [◀][dropdown][▶], used on the Chart/News/Earnings tabs. Dropdown contains only real
//                    watchlists — no Add/Reorder sentinels.
// All controls disable (via `disabled` attr + opacity:0.4 fallback for Qt WebEngine) when only one watchlist exists.
function renderWatchlistNav(variant) {
    const navDisabled = watchlists.length <= 1;
    const navAttr = navDisabled ? 'disabled' : '';
    const opacityStyle = navDisabled ? 'opacity:0.4' : '';

    if (variant === 'labeled') {
        return `
            <button class="btn" style="margin-left:auto;${opacityStyle}" ${navAttr} onclick="prevWatchlist()">◀ Prev</button>
            <button class="btn" style="${opacityStyle}" ${navAttr} onclick="nextWatchlist()">Next ▶</button>
        `;
    }

    // compact
    const options = watchlists.map(w =>
        `<option value="${w.id}" ${w.id === activeWatchlistId ? 'selected' : ''}>${w.name}</option>`
    ).join('');
    return `
        <button class="chart-btn" style="${opacityStyle}" ${navAttr} onclick="prevWatchlist()">◀</button>
        <select class="watchlist-nav-select" style="${opacityStyle}" ${navAttr}
                onchange="handleWatchlistChange(this.value)">${options}</select>
        <button class="chart-btn" style="${opacityStyle}" ${navAttr} onclick="nextWatchlist()">▶</button>
    `;
}

// Builds the symbol-selection row shared by the Chart, News, and Earnings tabs:
// symbol buttons in a left-hand group that wraps across rows, with the compact
// watchlist nav pinned to the top-right (positioning handled by .symbol-row CSS,
// not by the nav's own margin). `rerender` is the name of the calling tab's
// render function, invoked on symbol click to redraw that tab for the new symbol.
//
// `opts.multi` (Chart tab only) appends the trailing "Multi" button and, while
// multiMode is active, switches the symbol buttons from single-select (set
// selectedSymbol + rerender) to multi-toggle (add/remove from multiSelected).
// Chart and Analysis pass {multi:true} (so the Multi button shows and the basket is
// shared); News/Earnings never pass it, so they stay single-select even when
// multiMode is suspended in the background.
function renderSymbolRow(rerender, opts) {
    const multi = opts && opts.multi;
    const symBtns = quotes.map(sq => {
        let active, onclick;
        if (multi && multiMode) {
            active = multiSelected.includes(sq.symbol) ? 'active' : '';
            onclick = `toggleMultiSymbol('${sq.symbol}')`;
        } else {
            active = sq.symbol === selectedSymbol ? 'active' : '';
            onclick = `selectedSymbol='${sq.symbol}'; ${rerender}(document.getElementById('content'))`;
        }
        return `<button class="chart-btn ${active}" onclick="${onclick}">${sq.symbol}</button>`;
    }).join('');

    const multiBtn = multi
        ? `<button class="chart-btn ${multiMode ? 'active' : ''}" onclick="toggleMultiMode()">Multi</button>`
        : '';

    return `
        <div class="symbol-row">
            <div class="symbol-group">${symBtns}${multiBtn}</div>
            <div class="symbol-nav">${renderWatchlistNav('compact')}</div>
        </div>
    `;
}

// Enter/exit multi (comparison) mode. Entering seeds the set with the current
// single selection; exiting points selectedSymbol at the first member so the
// other tabs land somewhere sensible. Custom From DB is single-symbol-only, so
// entering multi from that period falls back to 1y.
function toggleMultiMode() {
    if (multiMode) {
        multiMode = false;
        if (multiSelected.length > 0 && !multiSelected.includes(selectedSymbol)) {
            selectedSymbol = multiSelected[0];
        }
    } else {
        multiMode = true;
        if (chartPeriod === 'custom_db') chartPeriod = '1y';
        multiSelected = selectedSymbol ? [selectedSymbol] : [];
    }
    renderCurrentTab();
}

// Toggle one symbol's membership in the comparison set. Capped at MULTI_COLORS.length
// so every series keeps a distinct color; past the cap the click is a no-op with a
// status note rather than recycling hues into ambiguity.
function toggleMultiSymbol(sym) {
    const i = multiSelected.indexOf(sym);
    if (i >= 0) {
        multiSelected.splice(i, 1);
    } else {
        if (multiSelected.length >= MULTI_COLORS.length) {
            setStatus(`Multi-select limit is ${MULTI_COLORS.length} tickers`);
            return;
        }
        multiSelected.push(sym);
    }
    renderCurrentTab();
}

// -- Tabs --
function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    renderCurrentTab();
}

function renderCurrentTab() {
    inReorderView = false;
    setHeaderButtonsDisabled(false);
    const el = document.getElementById('content');
    switch (currentTab) {
        case 'watchlist': renderWatchlist(el); break;
        case 'chart': renderChart(el); break;
        case 'news': renderNews(el); break;
        case 'earnings': renderEarnings(el); break;
        case 'analysis': renderAnalysis(el); break;
    }
}

// -- Watchlist --
function sortBy(col) {
    if (sortCol === col) {
        sortAsc = !sortAsc;
    } else {
        sortCol = col;
        sortAsc = true;
    }
    renderCurrentTab();
}

function renderWatchlist(el) {
    // Build watchlist dropdown
    const options = watchlists.map(w =>
        `<option value="${w.id}" ${w.id === activeWatchlistId ? 'selected' : ''}>${w.name}</option>`
    ).join('');

    // Sort a copy
    let sorted = [...quotes];
    if (sortCol) {
        sorted.sort((a, b) => {
            const av = a[sortCol], bv = b[sortCol];
            if (typeof av === 'string') {
                return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
            }
            return sortAsc ? av - bv : bv - av;
        });
    }

    const arrow = col => {
        if (sortCol !== col) return '';
        return sortAsc ? ' ▲' : ' ▼';
    };

    let rows = sorted.map(q => {
        const cls = q.change >= 0 ? 'positive' : 'negative';
        const sign = q.change >= 0 ? '+' : '';
        const selected = q.symbol === selectedSymbol ? 'selected' : '';
        return `<tr class="${selected}" onclick="selectSymbol('${q.symbol}')">
            <td class="symbol-cell"><a href="${tickerUrl(q.symbol)}" target="_blank">${q.symbol}</a></td>
            <td class="price-cell">$${q.price.toFixed(2)}</td>
            <td class="${cls}">${sign}${q.change.toFixed(2)}</td>
            <td class="${cls}">${sign}${q.pct_change.toFixed(2)}%</td>
            <td class="price-cell">$${q.open.toFixed(2)}</td>
            <td class="price-cell">$${q.high.toFixed(2)}</td>
            <td class="price-cell">$${q.low.toFixed(2)}</td>
            <td><button class="remove-btn" onclick="event.stopPropagation(); removeTicker('${q.symbol}')" title="Remove">&times;</button></td>
        </tr>`;
    }).join('');

    el.innerHTML = `
        <div class="add-bar">
            <select id="watchlistSelect" onchange="handleWatchlistChange(this.value)">
                ${options}
                <option value="__add__">+ Add Watchlist</option>
                ${watchlists.length > 1 ? '<option value="__reorder__">Reorder Watchlists</option>' : ''}
            </select>
            <input type="text" id="addTickerInput" placeholder="Add ticker..."
                   oninput="const b=document.getElementById('addTickerBtn'); const d=!this.value.trim(); b.disabled=d; b.style.opacity=d?'0.4':'1'"
                   onkeydown="if(event.key==='Enter') addTicker()">
            <button class="btn" id="addTickerBtn" onclick="addTicker()" disabled style="opacity:0.4">Add</button>
            <button class="btn" onclick="showEditWatchlist()">Edit</button>
            ${renderWatchlistNav('labeled')}
        </div>
        <table class="watchlist-table">
            <thead><tr>
                <th class="sortable" onclick="sortBy('symbol')">Symbol${arrow('symbol')}</th>
                <th class="sortable" onclick="sortBy('price')">Price${arrow('price')}</th>
                <th class="sortable" onclick="sortBy('change')">Change${arrow('change')}</th>
                <th class="sortable" onclick="sortBy('pct_change')">%${arrow('pct_change')}</th>
                <th>Open</th><th>High</th><th>Low</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function selectSymbol(sym) {
    selectedSymbol = sym;
    renderCurrentTab();
}

async function addTicker() {
    const input = document.getElementById('addTickerInput');
    const sym = input.value.trim().toUpperCase();
    if (!sym) return;
    setStatus('Adding ticker...');
    setHeaderButtonsDisabled(true);
    try {
        const data = await app.call('add_ticker', { watchlist_id: activeWatchlistId, symbol: sym });
        input.value = '';
        document.getElementById('addTickerBtn').disabled = true;
        document.getElementById('addTickerBtn').style.opacity = '0.4';
        if (data.status === 'ticker_exists' || data.status === 'ticker_not_found') {
            setStatus(data.status === 'ticker_exists' ? 'Ticker Already In Watchlist' : 'Ticker Not Found');
        } else {
            applyQuoteData(data);
        }
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
    setHeaderButtonsDisabled(false);
}

async function removeTicker(sym) {
    if (!confirm(`Do you want to remove ${sym}?`)) return;
    try {
        const data = await app.call('remove_ticker', { watchlist_id: activeWatchlistId, symbol: sym });
        if (selectedSymbol === sym) {
            selectedSymbol = data.quotes.length > 0 ? data.quotes[0].symbol : null;
        }
        applyQuoteData(data);
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

// -- Chart --
async function renderChart(el) {
    if (multiMode) return renderChartMulti(el);

    if (!selectedSymbol) {
        el.innerHTML = '<div class="loading">Select a ticker first</div>';
        return;
    }

    const q = quotes.find(q => q.symbol === selectedSymbol);

    const periods = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'];
    const periodBtns = periods.map(p =>
        `<button class="chart-btn ${p === chartPeriod ? 'active' : ''}"
                 onclick="changeChartPeriod('${p}')">${p}</button>`
    ).join('') +
    `<button class="chart-btn ${chartPeriod === 'custom_db' ? 'active' : ''}"
             onclick="changeChartPeriod('custom_db')">Custom From DB</button>`;

    const symRow = renderSymbolRow('renderChart', { multi: true });

    // Fetch data based on mode
    let data;
    let postStatus; // What to show in the status bar after render completes
    if (chartPeriod === 'custom_db') {
        // First activation this session: query the DB for the symbol's date range
        if (!customStartDate || !customEndDate) {
            el.innerHTML = `<div class="loading"><span class="spinner"></span>Loading ${selectedSymbol} from DB...</div>`;
            setStatus(`Loading ${selectedSymbol} from DB...`);
            const range = await app.call('get_db_date_range', { symbol: selectedSymbol });
            if (!range.first || !range.last) {
                // No data for this symbol — render empty form, let user pick dates anyway
                customStartDate = '';
                customEndDate = '';
            } else {
                customStartDate = range.first;
                customEndDate = range.last;
            }
        }
        if (customStartDate && customEndDate) {
            el.innerHTML = `<div class="loading"><span class="spinner"></span>Loading ${selectedSymbol} from DB...</div>`;
            setStatus(`Loading ${selectedSymbol} from DB...`);
            data = await app.call('get_history_from_db', {
                symbol: selectedSymbol,
                start_date: customStartDate,
                end_date: customEndDate,
            });
        } else {
            data = [];
        }
        postStatus = 'From DB';
    } else {
        const cacheKey = `${selectedSymbol}_${chartPeriod}`;
        const cached = historyCache[cacheKey];
        const stale = isCacheStale(cached);
        if (cached && !stale) {
            data = cached.data;
            postStatus = 'Cached';
        } else {
            el.innerHTML = `<div class="loading"><span class="spinner"></span>${cached ? 'Updating' : 'Loading'} ${selectedSymbol}...</div>`;
            setStatus(`${cached ? 'Updating' : 'Loading'} ${selectedSymbol}...`);
            data = await app.call('get_history', { symbol: selectedSymbol, period: chartPeriod });
            historyCache[cacheKey] = { data, fetchedDate: todayLocalYMD() };
            postStatus = cached ? 'Updated' : 'Cached';
        }
    }

    // Compute header price + change.
    // In yfinance modes: current quote price vs first close in history.
    // In DB mode: last close in range vs first close in range (header reflects the displayed chart).
    let changeHtml = '';
    if (chartPeriod === 'custom_db') {
        if (data.length >= 1) {
            const firstClose = data[0].close;
            const lastClose = data[data.length - 1].close;
            const periodChange = lastClose - firstClose;
            const periodPct = firstClose ? (periodChange / firstClose) * 100 : 0;
            const cls = periodChange >= 0 ? 'positive' : 'negative';
            const sign = periodChange >= 0 ? '+' : '';
            changeHtml = `<span class="price">$${lastClose.toFixed(2)}</span>
                          <span class="change ${cls}">${sign}${periodChange.toFixed(2)} (${sign}${periodPct.toFixed(2)}%)</span>`;
        }
    } else if (q && data.length >= 1) {
        const firstClose = data[0].close;
        const periodChange = q.price - firstClose;
        const periodPct = (periodChange / firstClose) * 100;
        const cls = periodChange >= 0 ? 'positive' : 'negative';
        const sign = periodChange >= 0 ? '+' : '';
        changeHtml = `<span class="price">$${q.price.toFixed(2)}</span>
                      <span class="change ${cls}">${sign}${periodChange.toFixed(2)} (${sign}${periodPct.toFixed(2)}%)</span>`;
    } else if (q) {
        changeHtml = `<span class="price">$${q.price.toFixed(2)}</span>`;
    }

    // Date range row, only in custom_db mode
    const dateRangeRow = chartPeriod === 'custom_db' ? `
        <div class="date-range-row">
            <span class="date-range-label">Date Range:</span>
            <input type="date" class="date-input" id="customStartInput"
                   value="${customStartDate || ''}"
                   onchange="onCustomDateChange('start', this.value)">
            <span class="date-range-sep">to</span>
            <input type="date" class="date-input" id="customEndInput"
                   value="${customEndDate || ''}"
                   onchange="onCustomDateChange('end', this.value)">
        </div>
    ` : '';

    el.innerHTML = `
        <div class="detail-header">
            <h2>${selectedSymbol}</h2>
            ${changeHtml}
        </div>
        ${symRow}
        <div class="chart-controls">${periodBtns}</div>
        ${dateRangeRow}
        <div class="chart-container">
            <canvas id="priceChart"></canvas>
            <canvas id="chartOverlay"></canvas>
        </div>
    `;

    setStatus(postStatus);
    drawChart(data);
    if (data.length < 2) {
        setStatus(chartPeriod === 'custom_db' ? 'No data in this date range' : 'Not enough data for this period');
    } else {
        initChartOverlay(data);
    }
}

function changeChartPeriod(p) {
    // Custom From DB is single-symbol-only for now; selecting it drops out of multi.
    if (p === 'custom_db' && multiMode) {
        multiMode = false;
        if (multiSelected.length > 0) selectedSymbol = multiSelected[0];
    }
    chartPeriod = p;
    renderChart(document.getElementById('content'));
}

function onCustomDateChange(field, value) {
    // HTML5 date input gives empty string when cleared; treat as no-op revert.
    if (!value) {
        renderChart(document.getElementById('content'));
        return;
    }
    if (field === 'start') {
        customStartDate = value;
    } else {
        customEndDate = value;
    }
    // Guard against start > end — silently swap so the range query still works.
    if (customStartDate && customEndDate && customStartDate > customEndDate) {
        [customStartDate, customEndDate] = [customEndDate, customStartDate];
    }
    renderChart(document.getElementById('content'));
}

function drawChart(data) {
    const canvas = document.getElementById('priceChart');
    if (!canvas || data.length < 2) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width - 32;
    canvas.height = rect.height - 32;

    const W = canvas.width, H = canvas.height;
    const pad = { top: 10, right: 10, bottom: 30, left: 60 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;

    const closes = data.map(d => d.close);
    const minP = Math.min(...closes) * 0.995;
    const maxP = Math.max(...closes) * 1.005;
    const range = maxP - minP || 1;

    const x = i => pad.left + (i / (data.length - 1)) * cW;
    const y = v => pad.top + (1 - (v - minP) / range) * cH;

    ctx.clearRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = '#2e3241';
    ctx.lineWidth = 0.5;
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
        const gy = pad.top + (i / gridLines) * cH;
        ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(W - pad.right, gy); ctx.stroke();
        const val = maxP - (i / gridLines) * range;
        ctx.fillStyle = '#8b8fa3';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('$' + val.toFixed(2), pad.left - 8, gy + 4);
    }

    // Date labels
    const labelCount = Math.min(6, data.length);
    ctx.textAlign = 'center';
    for (let i = 0; i < labelCount; i++) {
        const idx = Math.floor(i / (labelCount - 1) * (data.length - 1));
        const d = data[idx];
        ctx.fillStyle = '#8b8fa3';
        const parts = d.date.split('-');
        const label = parseInt(parts[1]) + '/' + parseInt(parts[2]) + '/' + parts[0];
        ctx.fillText(label, x(idx), H - 6);
    }

    // Price line
    const isUp = closes[closes.length - 1] >= closes[0];
    ctx.strokeStyle = isUp ? '#4caf82' : '#e05555';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    data.forEach((d, i) => {
        if (i === 0) ctx.moveTo(x(i), y(d.close));
        else ctx.lineTo(x(i), y(d.close));
    });
    ctx.stroke();

    // Fill
    ctx.lineTo(x(data.length - 1), pad.top + cH);
    ctx.lineTo(x(0), pad.top + cH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
    const baseColor = isUp ? '76,175,130' : '224,85,85';
    grad.addColorStop(0, `rgba(${baseColor},0.15)`);
    grad.addColorStop(1, `rgba(${baseColor},0.0)`);
    ctx.fillStyle = grad;
    ctx.fill();
}

// -- Chart Overlay (crosshair + tooltip) --
function initChartOverlay(data) {
    const base = document.getElementById('priceChart');
    const overlay = document.getElementById('chartOverlay');
    if (!base || !overlay) return;

    overlay.width = base.width;
    overlay.height = base.height;

    const W = base.width, H = base.height;
    const pad = { top: 10, right: 10, bottom: 30, left: 60 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;

    const closes = data.map(d => d.close);
    const minP = Math.min(...closes) * 0.995;
    const maxP = Math.max(...closes) * 1.005;
    const range = maxP - minP || 1;

    const xPos = i => pad.left + (i / (data.length - 1)) * cW;
    const yPos = v => pad.top + (1 - (v - minP) / range) * cH;

    const container = overlay.parentElement;

    container.addEventListener('mousemove', e => {
        const rect = overlay.getBoundingClientRect();
        const mx = e.clientX - rect.left;

        // Map mouse X to nearest data index
        const ratio = (mx - pad.left) / cW;
        const idx = Math.round(ratio * (data.length - 1));
        if (idx < 0 || idx >= data.length) {
            clearOverlay(overlay);
            return;
        }

        const point = data[idx];
        const px = xPos(idx);
        const py = yPos(point.close);

        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        // Dotted vertical line (point to x-axis)
        ctx.strokeStyle = '#8b8fa3';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, pad.top + cH);
        ctx.stroke();

        // Dotted horizontal line (point to y-axis)
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(pad.left, py);
        ctx.stroke();
        ctx.setLineDash([]);

        // Point dot
        ctx.fillStyle = '#6c8cff';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();

        // Tooltip
        // point.date is "YYYY-MM-DD" from yfinance or "YYYY-MM-DDTHH:MM:SS" from DB.
        // Detect the ISO timestamp form and show time-of-day; that matters for DB
        // mode where multiple points can land on the same date.
        const hasTime = point.date.includes('T');
        const datePart = point.date.split('T')[0];
        const dParts = datePart.split('-');
        let dateStr = parseInt(dParts[1]) + '/' + parseInt(dParts[2]) + '/' + dParts[0];
        if (hasTime) {
            const timePart = point.date.split('T')[1].split(/[.+-]/)[0]; // strip ms / tz
            const [hh, mm] = timePart.split(':');
            const h24 = parseInt(hh);
            const ampm = h24 >= 12 ? 'PM' : 'AM';
            const h12 = h24 % 12 || 12;
            dateStr += ' ' + h12 + ':' + mm + ' ' + ampm;
        }
        const priceStr = '$' + point.close.toFixed(2);
        // Volume is null in DB mode (DB doesn't store it); show em-dash placeholder.
        const volStr = 'Vol: ' + (point.volume == null ? '—' : point.volume.toLocaleString());
        const lines = [dateStr, priceStr, volStr];

        ctx.font = '11px -apple-system, sans-serif';
        const lineHeight = 15;
        const tipPad = 8;
        const tipW = Math.max(...lines.map(l => ctx.measureText(l).width)) + tipPad * 2;
        const tipH = lines.length * lineHeight + tipPad * 2 - 4;

        // Position tooltip so it doesn't go off-canvas
        let tipX = px + 12;
        let tipY = py - tipH / 2;
        if (tipX + tipW > W - pad.right) tipX = px - tipW - 12;
        if (tipY < pad.top) tipY = pad.top;
        if (tipY + tipH > pad.top + cH) tipY = pad.top + cH - tipH;

        // Tooltip background
        ctx.fillStyle = 'rgba(26, 29, 39, 0.92)';
        ctx.beginPath();
        ctx.roundRect(tipX, tipY, tipW, tipH, 4);
        ctx.fill();
        ctx.strokeStyle = '#2e3241';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Tooltip text
        ctx.fillStyle = '#e1e4ed';
        ctx.textAlign = 'left';
        lines.forEach((line, i) => {
            ctx.fillText(line, tipX + tipPad, tipY + tipPad + 8 + i * lineHeight);
        });
    });

    container.addEventListener('mouseleave', () => {
        clearOverlay(overlay);
    });
}

function clearOverlay(overlay) {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
}

// -- Multi (comparison) chart --
// Overlays several tickers on one chart, each normalized to % change from its own
// first point in the period (own-start anchor). yfinance periods only. Reuses the
// per-symbol+period historyCache; fetches only the misses, in parallel.
async function renderChartMulti(el) {
    const periods = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'];
    const periodBtns = periods.map(p =>
        `<button class="chart-btn ${p === chartPeriod ? 'active' : ''}"
                 onclick="changeChartPeriod('${p}')">${p}</button>`
    ).join('') +
    `<button class="chart-btn ${chartPeriod === 'custom_db' ? 'active' : ''}"
             onclick="changeChartPeriod('custom_db')">Custom From DB</button>`;

    const symRow = renderSymbolRow('renderChart', { multi: true });
    const headerHtml = `<div class="detail-header"><h2>Multiple Selection</h2></div>`;
    const controlsHtml = `${headerHtml}${symRow}<div class="chart-controls">${periodBtns}</div>`;

    if (multiSelected.length === 0) {
        el.innerHTML = `${controlsHtml}<div class="loading">Select one or more tickers to compare</div>`;
        setStatus('Multiple Selection');
        return;
    }

    // Cache-first: fetch only the symbols that are missing or stale, in parallel.
    const toFetch = multiSelected.filter(sym => {
        const c = historyCache[`${sym}_${chartPeriod}`];
        return !c || isCacheStale(c);
    });
    if (toFetch.length) {
        el.innerHTML = `${controlsHtml}<div class="loading"><span class="spinner"></span>Loading ${toFetch.length} ticker${toFetch.length === 1 ? '' : 's'}...</div>`;
        setStatus(`Loading ${toFetch.length} ticker${toFetch.length === 1 ? '' : 's'}...`);
        try {
            await Promise.all(toFetch.map(async sym => {
                const data = await app.call('get_history', { symbol: sym, period: chartPeriod });
                historyCache[`${sym}_${chartPeriod}`] = { data, fetchedDate: todayLocalYMD() };
            }));
        } catch (e) {
            setStatus('Error: ' + e.message);
        }
    }

    // Build normalized series. Color is assigned by position in multiSelected.
    const series = multiSelected.map((sym, i) => {
        const raw = (historyCache[`${sym}_${chartPeriod}`] || {}).data || [];
        const base = raw.length ? raw[0].close : null;
        const points = raw.map(d => ({
            date: d.date,
            close: d.close,
            pct: base ? (d.close / base - 1) * 100 : 0,
        }));
        return { symbol: sym, color: MULTI_COLORS[i], points };
    }).filter(s => s.points.length > 0);

    // Legend: symbol in its line color + endpoint % (= where the line ends, by design).
    const legendHtml = series.map(s => {
        const last = s.points[s.points.length - 1].pct;
        const sign = last >= 0 ? '+' : '';
        return `<span class="legend-item" style="color:${s.color}">${s.symbol} ${sign}${last.toFixed(1)}%</span>`;
    }).join('');

    el.innerHTML = `
        ${headerHtml}
        ${symRow}
        <div class="chart-controls">${periodBtns}</div>
        <div class="chart-legend">${legendHtml}</div>
        <div class="chart-container">
            <canvas id="priceChart"></canvas>
            <canvas id="chartOverlay"></canvas>
        </div>
    `;

    // Need >= 2 distinct dates across the union to draw any line.
    const dateSet = new Set();
    series.forEach(s => s.points.forEach(p => dateSet.add(p.date)));
    if (series.length === 0 || dateSet.size < 2) {
        setStatus('Not enough data for this period');
        return;
    }

    setStatus(toFetch.length ? 'Updated' : 'Cached');
    drawMultiChart(series);
    initMultiChartOverlay(series);
}

// Compute the shared time domain (X) and normalized % domain (Y) for a set of series.
// Factored out so the draw pass and the overlay pass map coordinates identically.
function multiChartDomain(series, geom) {
    let tMin = Infinity, tMax = -Infinity, pMin = Infinity, pMax = -Infinity;
    series.forEach(s => s.points.forEach(p => {
        const t = new Date(p.date).getTime();
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
        if (p.pct < pMin) pMin = p.pct;
        if (p.pct > pMax) pMax = p.pct;
    }));
    // Own-start anchoring means every series starts at 0%, so 0 is naturally in range;
    // clamp defensively anyway so the 0% baseline is always on-canvas.
    if (pMin > 0) pMin = 0;
    if (pMax < 0) pMax = 0;
    const pad = (pMax - pMin) || 1;
    pMin -= pad * 0.05;
    pMax += pad * 0.05;
    const range = pMax - pMin || 1;
    const { left, top, cW, cH } = geom;
    return {
        tMin, tMax, pMin, pMax, range,
        x: t => left + (tMax === tMin ? 0 : (t - tMin) / (tMax - tMin)) * cW,
        y: v => top + (1 - (v - pMin) / range) * cH,
    };
}

function drawMultiChart(series) {
    const canvas = document.getElementById('priceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width - 32;
    canvas.height = rect.height - 32;

    const W = canvas.width, H = canvas.height;
    const pad = { top: 10, right: 10, bottom: 30, left: 60 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;

    const dom = multiChartDomain(series, { left: pad.left, top: pad.top, cW, cH });
    if (dom.tMax === dom.tMin) return;

    ctx.clearRect(0, 0, W, H);

    // Grid lines + % labels
    ctx.strokeStyle = '#2e3241';
    ctx.lineWidth = 0.5;
    ctx.font = '11px -apple-system, sans-serif';
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
        const gy = pad.top + (i / gridLines) * cH;
        ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(W - pad.right, gy); ctx.stroke();
        const val = dom.pMax - (i / gridLines) * dom.range;
        ctx.fillStyle = '#8b8fa3';
        ctx.textAlign = 'right';
        ctx.fillText((val >= 0 ? '+' : '') + val.toFixed(1) + '%', pad.left - 8, gy + 4);
    }

    // 0% baseline — break-even reference, dashed and slightly stronger than the grid.
    const zy = dom.y(0);
    ctx.strokeStyle = '#3a3f50';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad.left, zy); ctx.lineTo(W - pad.right, zy); ctx.stroke();
    ctx.setLineDash([]);

    // Date labels (date-based, evenly spaced across the time domain).
    // Timestamps come from UTC-midnight date strings, so read them back in UTC to
    // avoid a one-day shift in negative-offset timezones.
    const labelCount = 6;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8b8fa3';
    for (let i = 0; i < labelCount; i++) {
        const t = dom.tMin + (i / (labelCount - 1)) * (dom.tMax - dom.tMin);
        const d = new Date(t);
        const label = (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
        ctx.fillText(label, dom.x(t), H - 6);
    }

    // Series lines — no gradient fill in multi (overlapping fills muddy the chart).
    ctx.lineWidth = 1.5;
    series.forEach(s => {
        ctx.strokeStyle = s.color;
        ctx.beginPath();
        s.points.forEach((p, i) => {
            const px = dom.x(new Date(p.date).getTime());
            const py = dom.y(p.pct);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        });
        ctx.stroke();
    });
}

// Unified crosshair + tooltip for multi mode: snap to the nearest date in the union
// of all series' dates, then show every series' value at-or-before that date
// (carry-forward / step semantics, matching the DB "price was X as of T" model).
// A series with no point at-or-before the cursor (cursor left of its first point)
// shows "—" and gets no dot.
function initMultiChartOverlay(series) {
    const base = document.getElementById('priceChart');
    const overlay = document.getElementById('chartOverlay');
    if (!base || !overlay) return;

    overlay.width = base.width;
    overlay.height = base.height;

    const W = base.width, H = base.height;
    const pad = { top: 10, right: 10, bottom: 30, left: 60 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;

    const dom = multiChartDomain(series, { left: pad.left, top: pad.top, cW, cH });

    // Union of all dates as sorted timestamps (snap target for the crosshair).
    const tsSet = new Set();
    series.forEach(s => s.points.forEach(p => tsSet.add(new Date(p.date).getTime())));
    const unionTs = Array.from(tsSet).sort((a, b) => a - b);

    // Per-series points sorted ascending for carry-forward lookups.
    const sPts = series.map(s => ({
        symbol: s.symbol,
        color: s.color,
        pts: s.points
            .map(p => ({ t: new Date(p.date).getTime(), close: p.close, pct: p.pct }))
            .sort((a, b) => a.t - b.t),
    }));

    const container = overlay.parentElement;

    container.addEventListener('mousemove', e => {
        const rect = overlay.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        if (mx < pad.left || mx > W - pad.right) { clearOverlay(overlay); return; }

        // Mouse X -> timestamp -> nearest union date
        const tRaw = dom.tMin + ((mx - pad.left) / cW) * (dom.tMax - dom.tMin);
        let snapped = unionTs[0], bestD = Infinity;
        for (const t of unionTs) {
            const d = Math.abs(t - tRaw);
            if (d < bestD) { bestD = d; snapped = t; }
        }

        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        const px = dom.x(snapped);

        // Vertical crosshair
        ctx.strokeStyle = '#8b8fa3';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(px, pad.top); ctx.lineTo(px, pad.top + cH); ctx.stroke();
        ctx.setLineDash([]);

        // Carry-forward value per series (last point with t <= snapped)
        const rows = sPts.map(s => {
            let chosen = null;
            for (const p of s.pts) {
                if (p.t <= snapped) chosen = p;
                else break;
            }
            return { symbol: s.symbol, color: s.color, point: chosen };
        });

        // Dot on each series at its carried value
        rows.forEach(r => {
            if (!r.point) return;
            ctx.fillStyle = r.color;
            ctx.beginPath();
            ctx.arc(px, dom.y(r.point.pct), 3.5, 0, Math.PI * 2);
            ctx.fill();
        });

        // Tooltip: date header, then one "SYMBOL  +pct% ($price)" row per series.
        // pct is the carried point's cumulative change from the period start (= the
        // line's height at the crosshair); price is that same point's close, so the
        // two never disagree. Missing point (cursor left of the series' start) → "—".
        // snapped is a UTC-midnight timestamp; read it back in UTC (see drawMultiChart).
        const d = new Date(snapped);
        const dateStr = (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
        const valStrs = rows.map(r => {
            if (!r.point) return '—';
            const sign = r.point.pct >= 0 ? '+' : '';
            return `${sign}${r.point.pct.toFixed(1)}% ($${r.point.close.toFixed(2)})`;
        });

        ctx.font = '11px -apple-system, sans-serif';
        const lineHeight = 15;
        const tipPad = 8;
        const colGap = 12;
        const symW = Math.max(...rows.map(r => ctx.measureText(r.symbol).width));
        const valW = Math.max(...valStrs.map(v => ctx.measureText(v).width));
        const bodyW = symW + colGap + valW;
        const dateW = ctx.measureText(dateStr).width;
        const tipW = Math.max(dateW, bodyW) + tipPad * 2;
        const tipH = (rows.length + 1) * lineHeight + tipPad * 2 - 4;

        let tipX = px + 12;
        let tipY = pad.top;
        if (tipX + tipW > W - pad.right) tipX = px - tipW - 12;
        if (tipX < pad.left) tipX = pad.left + 2;
        if (tipY + tipH > pad.top + cH) tipY = pad.top + cH - tipH;

        ctx.fillStyle = 'rgba(26, 29, 39, 0.92)';
        ctx.beginPath(); ctx.roundRect(tipX, tipY, tipW, tipH, 4); ctx.fill();
        ctx.strokeStyle = '#2e3241';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Date header
        ctx.fillStyle = '#e1e4ed';
        ctx.textAlign = 'left';
        ctx.fillText(dateStr, tipX + tipPad, tipY + tipPad + 8);

        // Rows: symbol (colored) in the left column, "+pct% ($price)" left-aligned
        // at a fixed column so rows stay tidy.
        rows.forEach((r, i) => {
            const ry = tipY + tipPad + 8 + (i + 1) * lineHeight;
            ctx.fillStyle = r.color;
            ctx.fillText(r.symbol, tipX + tipPad, ry);
            ctx.fillStyle = '#e1e4ed';
            ctx.fillText(valStrs[i], tipX + tipPad + symW + colGap, ry);
        });
    });

    container.addEventListener('mouseleave', () => {
        clearOverlay(overlay);
    });
}

// -- News --
async function renderNews(el) {
    if (!selectedSymbol) {
        el.innerHTML = '<div class="loading">Select a ticker first</div>';
        return;
    }

    const symRow = renderSymbolRow('renderNews');

    el.innerHTML = `
        ${symRow}
        <div class="loading"><span class="spinner"></span>Loading news for ${selectedSymbol}...</div>
    `;

    try {
        const news = await app.call('get_news', { symbol: selectedSymbol });
        let newsHtml = '';
        if (news.length === 0) {
            newsHtml = '<div class="loading">No recent news found</div>';
        } else {
            newsHtml = news.map(n => {
                const date = n.datetime ? new Date(n.datetime * 1000).toLocaleDateString() : '';
                return `<div class="news-item">
                    <div class="news-headline"><a href="${n.url}" target="_blank">${n.headline}</a></div>
                    <div class="news-meta">${n.source} &middot; ${date}</div>
                    ${n.summary ? `<div class="news-summary">${n.summary.slice(0, 200)}${n.summary.length > 200 ? '...' : ''}</div>` : ''}
                </div>`;
            }).join('');
        }

        el.innerHTML = `
            ${symRow}
            ${newsHtml}
        `;
    } catch (e) {
        el.innerHTML = `
            ${symRow}
            <div class="loading">Error loading news: ${e.message}</div>
        `;
    }
}

// -- Earnings --
async function renderEarnings(el) {
    if (!selectedSymbol) {
        el.innerHTML = '<div class="loading">Select a ticker first</div>';
        return;
    }

    const symRow = renderSymbolRow('renderEarnings');

    el.innerHTML = `
        ${symRow}
        <div class="loading"><span class="spinner"></span>Loading earnings for ${selectedSymbol}...</div>
    `;

    try {
        const earnings = await app.call('get_earnings', { symbol: selectedSymbol });
        let earningsHtml = '';
        if (earnings.length === 0) {
            earningsHtml = '<div class="loading">No earnings data found</div>';
        } else {
            const rows = earnings.map(e => {
                const surprise = e.surprise_pct != null ? e.surprise_pct.toFixed(2) : '-';
                const cls = e.surprise != null ? (e.surprise >= 0 ? 'positive' : 'negative') : '';
                const sign = e.surprise != null && e.surprise >= 0 ? '+' : '';
                return `<tr>
                    <td>${e.period}</td>
                    <td>${e.actual != null ? '$' + e.actual.toFixed(2) : '-'}</td>
                    <td>${e.estimate != null ? '$' + e.estimate.toFixed(2) : '-'}</td>
                    <td class="${cls}">${e.surprise != null ? sign + '$' + e.surprise.toFixed(2) : '-'}</td>
                    <td class="${cls}">${surprise !== '-' ? sign + surprise + '%' : '-'}</td>
                </tr>`;
            }).join('');

            earningsHtml = `
                <table class="earnings-table">
                    <thead><tr>
                        <th>Period</th><th>Actual EPS</th><th>Estimate</th>
                        <th>Surprise</th><th>Surprise %</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            `;
        }

        el.innerHTML = `
            ${symRow}
            ${earningsHtml}
        `;
    } catch (e) {
        el.innerHTML = `
            ${symRow}
            <div class="loading">Error loading earnings: ${e.message}</div>
        `;
    }
}

// -- Analysis --
// Single-symbol tab (like News/Earnings) on selectedSymbol. Two-stage load: get_analysis
// fills the fast panels (technicals/analyst/valuation) + initial highlights immediately;
// get_options_analysis fills the slower options panel and appends its highlights after.
// Both cache per-symbol with the same staleness rules as the chart history cache.

// ANALYSIS_GLOSSARY: plain-language, deliberately descriptive (never advice) explanations
// for each panel's metrics. Rendered into a hidden .pan-info block that the header's info
// button toggles open. Static content — no backend, no state object; collapse-on-switch is
// free because renderAnalysis rebuilds the panels' DOM (uncollapsed) on every symbol change.
const ANALYSIS_GLOSSARY = {
    technicals: {
        lead: 'These describe how the price is <em>moving</em> &mdash; its trend and momentum &mdash; not whether the stock is cheap or expensive.',
        items: [
            { term: 'Price vs 50- and 200-day moving average',
              def: 'A moving average smooths out daily noise by averaging the closing price over a window of trading days &mdash; 50 days (about 2.5 months) tracks the medium-term trend, 200 days (about 10 months) the long-term one. We show today&rsquo;s price as a percent above or below each line. Example: +14% vs the 200-day means the stock trades 14% higher than its average over the past ~10 months, which is a sign of an uptrend. A price below both lines points the other way.' },
            { term: 'RSI (14)',
              def: 'Relative Strength Index &mdash; a momentum gauge from 0 to 100 built from how large recent up-days were versus down-days (over 14 days). Above about 70 is commonly called &ldquo;overbought&rdquo; (the price has risen fast and far); below 30 &ldquo;oversold.&rdquo; Think of it as a speedometer, not a price tag: a high reading says the move has been quick, not that the stock is worth more.' },
            { term: 'Beta',
              def: 'How much the stock tends to move when the overall market moves. A beta of 1.0 means it typically moves in step with the market; 1.5 means it tends to swing about 50% more (both up and down); 0.5 means about half as much. Higher beta is a bumpier ride.' },
            { term: 'Relative strength vs SPY (3mo)',
              def: 'The stock&rsquo;s return over the past three months minus the S&amp;P 500&rsquo;s, using the SPY index fund as the market stand-in. +5% means the stock beat the index by 5 percentage points over that span; a negative number means it lagged. A quick &ldquo;is this keeping up with the market&rdquo; check.' },
            { term: '52-week range',
              def: 'The span between the lowest and highest price over the past year, with a marker for where today&rsquo;s price sits inside it. 84% means the price is near the top of its yearly range; 10% would mean near the bottom. Context for whether you&rsquo;re looking at a stock near its highs or its lows.' },
        ],
    },
    analyst: {
        lead: 'A summary of what the professional analysts who cover this company currently think. These are opinions, and they are often wrong &mdash; one input, not a verdict.',
        items: [
            { term: 'Consensus',
              def: 'The average of all covering analysts&rsquo; ratings, as a label (Strong Buy through Sell) and a number. The number runs 1 to 5, where 1 is the most bullish (Strong Buy) and 5 the most bearish (Strong Sell) &mdash; so a 2.0 means the average analyst rates it a &ldquo;Buy.&rdquo;' },
            { term: 'Buy / Hold / Sell',
              def: 'How the individual ratings break down; the bar shows the proportions. Lots of Buys and few Sells is a bullish consensus; a wall of Holds means analysts are largely on the fence.' },
            { term: 'Mean target',
              def: 'The average of analysts&rsquo; 12-month price targets &mdash; where, on average, they expect the stock to be trading a year from now.' },
            { term: 'Implied upside',
              def: 'How far the mean target sits above (or below) today&rsquo;s price, as a percent. +16% means the average target is 16% higher than the current price. This is just arithmetic on the targets above, not a promise the price will get there.' },
            { term: 'Target range',
              def: 'The lowest and highest individual price targets. A wide spread (say $190 to $270) means analysts strongly disagree about where the stock is headed.' },
        ],
    },
    valuation: {
        lead: 'These gauge how expensive the stock is relative to the company&rsquo;s actual business, and how financially sturdy that business is. &ldquo;Expensive&rdquo; isn&rsquo;t automatically bad &mdash; faster-growing companies usually cost more.',
        items: [
            { term: 'Forward P/E',
              def: 'Price-to-earnings using next year&rsquo;s <em>expected</em> profit. It answers: how many dollars are you paying for each dollar of annual earnings? A forward P/E of 30 means $30 of share price for every $1 of profit the company is expected to earn per share next year. Higher generally means the market expects faster growth and is paying up for it.' },
            { term: 'Trailing P/E',
              def: 'The same idea but using the last 12 months of <em>actual reported</em> earnings instead of forecasts. Comparing the two hints at expected growth: if forward is well below trailing, profits are expected to rise.' },
            { term: 'PEG',
              def: 'P/E divided by the expected earnings growth rate &mdash; a way to judge whether a high P/E is justified by fast growth. As a rough rule of thumb, around 1.0 is often considered fairly priced for its growth; well above 2 suggests you&rsquo;re paying a lot even after accounting for growth.' },
            { term: 'Price / sales',
              def: 'Share price relative to the company&rsquo;s revenue per share. Useful for companies that aren&rsquo;t very profitable yet (where P/E is misleading or meaningless), since revenue exists even when earnings don&rsquo;t.' },
            { term: 'Gross margin',
              def: 'Of every dollar of sales, how much is left after the direct cost of making the product, as a percent. 46% means 46 cents of each sales dollar remains to cover everything else (R&amp;D, marketing) and profit. Higher usually signals pricing power or an efficient product.' },
            { term: 'Debt / equity',
              def: 'How much the company is funded by borrowed money versus owners&rsquo; money (shareholder equity). 1.5x means $1.50 of debt for every $1 of equity. Debt can amplify returns but adds risk, especially if earnings wobble. (Yahoo reports this oddly as a percent like 150; we convert it to the 1.5x form.)' },
            { term: 'FCF yield',
              def: 'Free cash flow &mdash; the actual cash the business throws off after running and investing in itself &mdash; as a percent of the company&rsquo;s total market value. 3.4% is loosely comparable to a bond&rsquo;s yield: how much real cash the business generates per dollar you&rsquo;d pay for the whole company.' },
        ],
    },
    options: {
        lead: 'Options are contracts to buy (calls) or sell (puts) the stock at a set price by a set date. Traders use them to bet on direction or to hedge, so the options market is a window into how the crowd is positioned. This is sentiment, not a signal &mdash; and sentiment is often wrong.',
        items: [
            { term: 'Put/call (volume)',
              def: 'Today&rsquo;s activity: put contracts traded divided by call contracts. Below 1 means more calls than puts changed hands (upside-leaning activity); above 1 means put-heavy. Loosely, low reads as bullish-leaning flow, high as bearish or lots of hedging.' },
            { term: 'Put/call ($-weighted)',
              def: 'The same ratio, but weighted by the dollars actually spent on each contract rather than just the count. This keeps a flood of cheap lottery-ticket options from dominating the picture &mdash; it reflects where real money went.' },
            { term: 'Put/call (open interest)',
              def: 'Open interest is the number of contracts currently outstanding (open positions), not just today&rsquo;s trades. This ratio shows the standing positioning in the name &mdash; bets still on the table, rather than today&rsquo;s churn.' },
            { term: 'IV (30d) vs realized',
              def: 'Implied volatility (IV) is how much price movement the options market is pricing in for roughly the next 30 days &mdash; the &ldquo;expected&rdquo; turbulence baked into option prices. Realized volatility is how much the stock has actually moved recently. When IV sits well above realized, options are relatively expensive (the market expects more movement than there&rsquo;s been); below, relatively cheap.' },
            { term: 'IV skew (10% OTM)',
              def: 'Compares the implied volatility of a downside put (about 10% below today&rsquo;s price) with an upside call (about 10% above). When puts carry higher IV &mdash; a positive skew &mdash; downside protection is in greater demand and pricier, a sign of fear or hedging. (A simple proxy for the more formal &ldquo;delta skew.&rdquo;)' },
            { term: 'Max pain',
              def: 'The strike price at which the largest dollar value of options would expire worthless &mdash; the price causing the most aggregate &ldquo;pain&rdquo; to option buyers at expiration. There&rsquo;s a long-standing theory that prices drift toward this level near expiry; it&rsquo;s debated, so treat it as a point of interest, not a prediction.' },
            { term: 'Open interest by strike (chart)',
              def: 'How many call (blue) and put (orange) contracts are open at each strike price near the current price. Tall bars mark strikes where a lot of positioning has piled up &mdash; these can act as informal magnets or barriers. The dashed lines mark today&rsquo;s price and the max-pain strike.' },
            { term: 'IV rank',
              def: 'Where today&rsquo;s implied volatility sits versus this stock&rsquo;s own IV history that the app has logged. 38% means current IV is higher than it&rsquo;s been on 38% of recorded days &mdash; middling. Because it&rsquo;s measured against the stock&rsquo;s own past, it only becomes meaningful once enough days accumulate (it reads &ldquo;building&rdquo; until then).' },
        ],
    },
};

// Inline SVG icons — the app loads no icon webfont, so analysis-tab icons are drawn as
// self-contained SVG (themed via currentColor, works offline). Tabler-style: 24x24 viewBox,
// no fill, stroke = currentColor. svgIcon(name, cls) is a drop-in for the old <i class="ti">.
const ICONS = {
    'info-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M11 12h1v4h1"/>',
    'chart-line': '<path d="M4 4v16h16"/><path d="M7 14l3 -3l3 2l4 -5"/>',
    'users': '<circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4 -4h3"/><path d="M16 3.5a4 4 0 0 1 0 7"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
    'report-money': '<circle cx="12" cy="12" r="9"/><path d="M14.8 9a2 2 0 0 0 -1.8 -1h-2a2 2 0 1 0 0 4h2a2 2 0 1 1 0 4h-2a2 2 0 0 1 -1.8 -1"/><path d="M12 6v2"/><path d="M12 16v2"/>',
    'scale': '<path d="M7 20l10 0"/><path d="M6 6l6 -1l6 1"/><path d="M12 3l0 17"/><path d="M9 12l-3 -6l-3 6a3 3 0 0 0 6 0"/><path d="M21 12l-3 -6l-3 6a3 3 0 0 0 6 0"/>',
    'trending-up': '<path d="M3 17l6 -6l4 4l8 -8"/><path d="M14 7h7v7"/>',
    'alert-triangle': '<path d="M12 9v4"/><path d="M10.24 3.96l-8.42 14.06a2 2 0 0 0 1.7 3h16.85a2 2 0 0 0 1.7 -3l-8.42 -14.06a2 2 0 0 0 -3.4 0z"/><path d="M12 16h.01"/>',
    'eye': '<circle cx="12" cy="12" r="2"/><path d="M22 12c-2.67 4.67 -6 7 -10 7s-7.33 -2.33 -10 -7c2.67 -4.67 6 -7 10 -7s7.33 2.33 10 7"/>',
};

function svgIcon(name, cls) {
    return `<svg class="aicon ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function infoBtn(key) {
    return `<button class="info-btn" type="button" aria-label="Explain these metrics" aria-expanded="false" onclick="togglePanelInfo(this)">${svgIcon('info-circle')}</button>`;
}

function infoBlock(key) {
    const g = ANALYSIS_GLOSSARY[key];
    if (!g) return '';
    const items = g.items.map(it => `<div class="ii"><span class="it">${it.term}</span><span class="id">${it.def}</span></div>`).join('');
    return `<div class="pan-info">${g.lead ? `<p class="lead">${g.lead}</p>` : ''}${items}</div>`;
}

function togglePanelInfo(btn) {
    const pan = btn.closest('.pan');
    if (!pan) return;
    const open = pan.classList.toggle('info-open');
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function aPct(v, d = 1) { return v == null ? '\u2014' : (v >= 0 ? '+' : '') + Number(v).toFixed(d) + '%'; }
function aNum(v, d = 2) { return v == null ? '\u2014' : Number(v).toFixed(d); }
function aMoney(v) { return v == null ? '\u2014' : '$' + Number(v).toFixed(2); }
function signCls(v) { return v == null ? '' : (v >= 0 ? 'positive' : 'negative'); }
function mr(k, v, cls) { return `<div class="mr"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`; }
function panelMsg(icon, title, msg) {
    return `<div class="pan"><h3>${svgIcon(icon)}${title}</h3><div class="loading">${msg}</div></div>`;
}

function highlightHtml(h) {
    const map = { strength: ['trending-up', 'g'], weakness: ['alert-triangle', 'r'], watch: ['eye', 'o'] };
    const [icon, cls] = map[h.type] || map.watch;
    return `<div class="hl">${svgIcon(icon, cls)}<div><p class="h ${cls}">${h.title}</p><p class="d">${h.detail || ''}</p></div></div>`;
}

function technicalsPanel(t) {
    if (!t) return panelMsg('chart-line', 'Technicals &amp; momentum', 'No data');
    const rangeBar = (t.range_pos != null && t.low_52w != null && t.high_52w != null) ? `
        <div style="padding-top:8px">
            <div class="rng-ends"><span>52-wk $${t.low_52w.toFixed(0)}</span><span>$${t.high_52w.toFixed(0)}</span></div>
            <div class="rng"><div class="f" style="left:${Math.max(0, Math.min(100, t.range_pos)).toFixed(0)}%"></div></div>
            <div class="rng-pos">${t.range_pos.toFixed(0)}% of range</div>
        </div>` : '';
    return `<div class="pan">
        <h3>${svgIcon('chart-line')}Technicals &amp; momentum${infoBtn('technicals')}</h3>
        ${mr('vs 50-day MA', aPct(t.price_vs_sma50), signCls(t.price_vs_sma50))}
        ${mr('vs 200-day MA', aPct(t.price_vs_sma200), signCls(t.price_vs_sma200))}
        ${mr('RSI (14)', aNum(t.rsi, 0), (t.rsi != null && (t.rsi >= 70 || t.rsi <= 30)) ? 'warn' : '')}
        ${mr('Beta', aNum(t.beta, 2))}
        ${mr('Rel. strength vs SPY (3mo)', aPct(t.rs_vs_spy_3mo), signCls(t.rs_vs_spy_3mo))}
        ${rangeBar}
        ${infoBlock('technicals')}
    </div>`;
}

function analystPanel(a) {
    if (!a) return panelMsg('users', 'Analyst', 'No data');
    const total = (a.buy || 0) + (a.hold || 0) + (a.sell || 0);
    const bar = total > 0 ? `
        <div class="bhs">
            <span style="flex:${a.buy || 0};background:var(--green)"></span>
            <span style="flex:${a.hold || 0};background:var(--text2)"></span>
            <span style="flex:${a.sell || 0};background:var(--red)"></span>
        </div>
        <div class="bhs-lab"><span class="positive">${a.buy || 0} Buy</span><span>${a.hold || 0} Hold</span><span class="negative">${a.sell || 0} Sell</span></div>` : '';
    let consensus = a.rec_key ? a.rec_key.replace(/_/g, ' ') : null;
    if (consensus) consensus = consensus.charAt(0).toUpperCase() + consensus.slice(1);
    const consensusVal = (consensus || '\u2014') + (a.rec_mean != null ? ` \u00b7 ${a.rec_mean}` : '');
    return `<div class="pan">
        <h3>${svgIcon('users')}Analyst${infoBtn('analyst')}</h3>
        ${mr('Consensus', consensusVal)}
        ${bar}
        ${mr('Mean target', aMoney(a.target_mean))}
        ${mr('Implied upside', aPct(a.implied_upside), signCls(a.implied_upside))}
        ${mr('Target range', (a.target_low != null && a.target_high != null) ? `$${a.target_low.toFixed(0)} \u2013 $${a.target_high.toFixed(0)}` : '\u2014')}
        ${a.num_analysts ? `<div class="pan-foot">${a.num_analysts} analysts</div>` : ''}
        ${infoBlock('analyst')}
    </div>`;
}

function valuationPanel(v) {
    if (!v) return panelMsg('report-money', 'Valuation &amp; health', 'No data');
    return `<div class="pan">
        <h3>${svgIcon('report-money')}Valuation &amp; health${infoBtn('valuation')}</h3>
        ${mr('Forward P/E', aNum(v.forward_pe, 1), (v.forward_pe != null && v.forward_pe > 30) ? 'warn' : '')}
        ${mr('Trailing P/E', aNum(v.trailing_pe, 1))}
        ${mr('PEG', aNum(v.peg, 2), (v.peg != null && v.peg > 2.5) ? 'warn' : '')}
        ${mr('Price / sales', aNum(v.ps, 1))}
        ${mr('Gross margin', v.gross_margin != null ? v.gross_margin.toFixed(1) + '%' : '\u2014', (v.gross_margin != null && v.gross_margin >= 40) ? 'positive' : '')}
        ${mr('Debt / equity', v.debt_to_equity != null ? (v.debt_to_equity / 100).toFixed(2) + 'x' : '\u2014', (v.debt_to_equity != null && v.debt_to_equity > 150) ? 'warn' : '')}
        ${mr('FCF yield', v.fcf_yield != null ? v.fcf_yield.toFixed(1) + '%' : '\u2014')}
        ${infoBlock('valuation')}
    </div>`;
}

function buildOIHistogram(opt) {
    const items = opt.oi_by_strike || [];
    if (!items.length) return '';
    const n = items.length;
    const maxOI = Math.max(1, ...items.map(d => Math.max(d.call_oi, d.put_oi)));
    const strikes = items.map(d => d.strike);
    const cols = items.map(d => `<div class="oicol">
        <div class="oibar" style="height:${Math.round(d.call_oi / maxOI * 100)}%;background:var(--accent)"></div>
        <div class="oibar" style="height:${Math.round(d.put_oi / maxOI * 100)}%;background:var(--orange)"></div>
    </div>`).join('');
    // Fractional column-center position (%) for a price, so markers line up with the bars.
    const fracPos = (P) => {
        if (P <= strikes[0]) return 0.5 / n * 100;
        if (P >= strikes[n - 1]) return (n - 0.5) / n * 100;
        let i = 0;
        while (i < n - 1 && strikes[i + 1] < P) i++;
        const frac = (P - strikes[i]) / (strikes[i + 1] - strikes[i]);
        return (i + frac + 0.5) / n * 100;
    };
    const priceMarker = opt.price != null ? `<div class="oicur" style="left:${fracPos(opt.price).toFixed(1)}%"></div>` : '';
    const mpMarker = opt.max_pain != null ? `<div class="oimp" style="left:${fracPos(opt.max_pain).toFixed(1)}%"></div>` : '';
    const labels = items.map(d => `<span>${Math.round(d.strike)}</span>`).join('');
    return `
        <div class="oi-title">Open interest by strike</div>
        <div class="oi">${priceMarker}${mpMarker}${cols}</div>
        <div class="oi-labels">${labels}</div>
        <div class="oi-legend">
            <span><span class="sw" style="background:var(--accent)"></span> calls</span>
            <span><span class="sw" style="background:var(--orange)"></span> puts</span>
            ${opt.price != null ? `<span style="color:var(--text)">| price $${opt.price.toFixed(2)}</span>` : ''}
            ${opt.max_pain != null ? `<span class="o">| max pain $${opt.max_pain.toFixed(2)}</span>` : ''}
        </div>`;
}

function optionsPanelBody(opt) {
    const h3 = (badge) => `<h3>${svgIcon('scale')}Options sentiment${badge || ''}</h3>`;
    if (!opt || !opt.available) return h3() + '<div class="loading">No options data for this symbol</div>';
    const ivrank = opt.iv_rank != null ? `IV rank ${opt.iv_rank}%` : `IV rank \u2014 building (${opt.iv_rank_points || 0}d)`;
    const badge = ` <span class="badge">${ivrank}</span>`;
    const ivVsReal = (opt.iv30 != null || opt.realized_vol != null)
        ? `${opt.iv30 != null ? opt.iv30.toFixed(0) + '%' : '\u2014'} / ${opt.realized_vol != null ? opt.realized_vol.toFixed(0) + '%' : '\u2014'}`
        : '\u2014';
    const skew = opt.skew != null
        ? (opt.skew >= 0 ? `puts +${opt.skew.toFixed(1)} vol` : `calls +${(-opt.skew).toFixed(1)} vol`)
        : '\u2014';
    return `<h3>${svgIcon('scale')}Options sentiment${badge}${infoBtn('options')}</h3>`
        + mr('Put/call (volume)', aNum(opt.pc_vol, 2))
        + mr('Put/call ($-weighted)', aNum(opt.pc_prem, 2))
        + mr('Put/call (open int.)', aNum(opt.pc_oi, 2))
        + mr('IV (30d) vs realized', ivVsReal, (opt.iv30 != null && opt.realized_vol != null && opt.iv30 > opt.realized_vol) ? 'warn' : '')
        + mr('IV skew (10% OTM)', skew)
        + buildOIHistogram(opt)
        + infoBlock('options');
}

async function renderAnalysis(el) {
    if (multiMode) return renderAnalysisMulti(el);
    if (!selectedSymbol) {
        el.innerHTML = '<div class="loading">Select a ticker first</div>';
        return;
    }
    const sym = selectedSymbol;
    const symRow = renderSymbolRow('renderAnalysis', { multi: true });
    const q = quotes.find(x => x.symbol === sym);
    const headerHtml = q
        ? `<div class="detail-header"><h2>${sym}</h2><span class="price">$${(q.price || 0).toFixed(2)}</span><span class="change ${q.pct_change >= 0 ? 'positive' : 'negative'}">${q.pct_change >= 0 ? '+' : ''}${(q.pct_change || 0).toFixed(2)}%</span></div>`
        : `<div class="detail-header"><h2>${sym}</h2></div>`;

    let entry = analysisCache[sym];
    const needFetch = !entry || isCacheStale(entry);
    if (needFetch) {
        el.innerHTML = `${headerHtml}${symRow}<div class="loading"><span class="spinner"></span>Analyzing ${sym}...</div>`;
        setStatus(`Analyzing ${sym}...`);
        try {
            const res = await app.call('get_analysis', { symbol: sym });
            analysisCache[sym] = entry = { data: res, fetchedDate: todayLocalYMD() };
        } catch (e) {
            el.innerHTML = `${headerHtml}${symRow}<div class="loading">Error analyzing ${sym}: ${e.message}</div>`;
            setStatus('Error: ' + e.message);
            return;
        }
    }
    // The user may have switched symbol/tab during the await — bail if so.
    if (selectedSymbol !== sym || currentTab !== 'analysis') return;

    const a = entry.data;
    const fastHl = (a.highlights || []).map(highlightHtml).join('');
    el.innerHTML = `
        ${headerHtml}
        ${symRow}
        <p class="lbl">Strengths &amp; weaknesses</p>
        <div class="hls" id="analysisHighlights">${fastHl || '<span class="hl-empty">No notable signals yet</span>'}</div>
        <div class="panels">
            ${technicalsPanel(a.technicals)}
            ${analystPanel(a.analyst)}
            ${valuationPanel(a.valuation)}
            <div class="pan" id="optionsPanel">
                <h3>${svgIcon('scale')}Options sentiment</h3>
                <div class="loading"><span class="spinner"></span>Loading options...</div>
            </div>
        </div>
    `;
    setStatus(needFetch ? 'Loaded' : 'Cached');
    loadOptionsPanel(sym);
}

async function loadOptionsPanel(sym) {
    let entry = optionsCache[sym];
    if (!entry || isCacheStale(entry)) {
        try {
            const res = await app.call('get_options_analysis', { symbol: sym });
            optionsCache[sym] = entry = { data: res, fetchedDate: todayLocalYMD() };
        } catch (e) {
            const p = document.getElementById('optionsPanel');
            if (p && selectedSymbol === sym && currentTab === 'analysis') {
                p.innerHTML = `<h3>${svgIcon('scale')}Options sentiment</h3><div class="loading">Error loading options: ${e.message}</div>`;
            }
            return;
        }
    }
    if (selectedSymbol !== sym || currentTab !== 'analysis') return;
    const panel = document.getElementById('optionsPanel');
    if (!panel) return;
    panel.innerHTML = optionsPanelBody(entry.data);

    // Append options-derived highlights to the strip (replacing the empty placeholder).
    const hc = document.getElementById('analysisHighlights');
    const hls = (entry.data && entry.data.highlights) || [];
    if (hc && hls.length) {
        const empty = hc.querySelector('.hl-empty');
        if (empty) empty.remove();
        hc.insertAdjacentHTML('beforeend', hls.map(highlightHtml).join(''));
    }
}

// -- Analysis: Multi (comparison) mode --
// Shares the Chart's multiMode/multiSelected basket. Each box becomes a side-by-side
// table (one column per ticker) instead of overlaid lines. Analyst box is omitted, the
// Strengths & weaknesses strip is hidden, and the options OI-by-strike chart is dropped
// (a single chart can't compare). Coloring is the same absolute-threshold logic as single
// mode. Two-stage like single: fast tables (technicals/valuation) paint first, the slower
// options table fills behind a spinner. Per-symbol caches are reused, so already-viewed
// tickers are instant.

function cmpHeader(symbol, color) {
    const q = quotes.find(x => x.symbol === symbol);
    return { symbol, color, price: q ? q.price : null, change: q ? q.pct_change : null };
}

function buildCompareTable(iconName, title, glossaryKey, headers, rows) {
    const thead = `<tr><th class="k"></th>` + headers.map(h =>
        `<th><span class="cmpdot" style="background:${h.color}"></span>${h.symbol}` +
        (h.price != null ? `<span class="sub">$${h.price.toFixed(2)}${h.change != null ? ` <span class="${h.change >= 0 ? 'positive' : 'negative'}">(${h.change >= 0 ? '+' : ''}${h.change.toFixed(1)}%)</span>` : ''}</span>` : '') +
        `</th>`).join('') + `</tr>`;
    const tbody = rows.map(r =>
        `<tr><td class="k">${r.label}</td>` +
        r.cells.map(c => `<td class="${c.cls || ''}">${c.text}</td>`).join('') +
        `</tr>`).join('');
    return `<div class="pan">
        <h3>${svgIcon(iconName)}${title}${infoBtn(glossaryKey)}</h3>
        <div class="cmp-scroll"><table class="cmp"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>
        ${infoBlock(glossaryKey)}
    </div>`;
}

const DASH = { text: '\u2014' };

function technicalsCompare(cols) {
    const headers = cols.map(c => cmpHeader(c.symbol, c.color));
    const specs = [
        { label: 'vs 50-day MA', fn: t => t ? { text: aPct(t.price_vs_sma50), cls: signCls(t.price_vs_sma50) } : DASH },
        { label: 'vs 200-day MA', fn: t => t ? { text: aPct(t.price_vs_sma200), cls: signCls(t.price_vs_sma200) } : DASH },
        { label: 'RSI (14)', fn: t => t ? { text: aNum(t.rsi, 0), cls: (t.rsi != null && (t.rsi >= 70 || t.rsi <= 30)) ? 'warn' : '' } : DASH },
        { label: 'Beta', fn: t => t ? { text: aNum(t.beta, 2) } : DASH },
        { label: 'Rel. strength vs SPY (3mo)', fn: t => t ? { text: aPct(t.rs_vs_spy_3mo), cls: signCls(t.rs_vs_spy_3mo) } : DASH },
        { label: '52-wk range position', fn: t => (t && t.range_pos != null) ? { text: t.range_pos.toFixed(0) + '%' } : DASH },
    ];
    const rows = specs.map(s => ({ label: s.label, cells: cols.map(c => s.fn(c.analysis ? c.analysis.technicals : null)) }));
    return buildCompareTable('chart-line', 'Technicals &amp; momentum', 'technicals', headers, rows);
}

function valuationCompare(cols) {
    const headers = cols.map(c => cmpHeader(c.symbol, c.color));
    const specs = [
        { label: 'Forward P/E', fn: v => v ? { text: aNum(v.forward_pe, 1), cls: (v.forward_pe != null && v.forward_pe > 30) ? 'warn' : '' } : DASH },
        { label: 'Trailing P/E', fn: v => v ? { text: aNum(v.trailing_pe, 1) } : DASH },
        { label: 'PEG', fn: v => v ? { text: aNum(v.peg, 2), cls: (v.peg != null && v.peg > 2.5) ? 'warn' : '' } : DASH },
        { label: 'Price / sales', fn: v => v ? { text: aNum(v.ps, 1) } : DASH },
        { label: 'Gross margin', fn: v => v ? { text: v.gross_margin != null ? v.gross_margin.toFixed(1) + '%' : '\u2014', cls: (v.gross_margin != null && v.gross_margin >= 40) ? 'positive' : '' } : DASH },
        { label: 'Debt / equity', fn: v => v ? { text: v.debt_to_equity != null ? (v.debt_to_equity / 100).toFixed(2) + 'x' : '\u2014', cls: (v.debt_to_equity != null && v.debt_to_equity > 150) ? 'warn' : '' } : DASH },
        { label: 'FCF yield', fn: v => v ? { text: v.fcf_yield != null ? v.fcf_yield.toFixed(1) + '%' : '\u2014' } : DASH },
    ];
    const rows = specs.map(s => ({ label: s.label, cells: cols.map(c => s.fn(c.analysis ? c.analysis.valuation : null)) }));
    return buildCompareTable('report-money', 'Valuation &amp; health', 'valuation', headers, rows);
}

function optionsCompare(cols) {
    const headers = cols.map(c => cmpHeader(c.symbol, c.color));
    const ivVsReal = o => (o.iv30 != null || o.realized_vol != null)
        ? `${o.iv30 != null ? o.iv30.toFixed(0) + '%' : '\u2014'} / ${o.realized_vol != null ? o.realized_vol.toFixed(0) + '%' : '\u2014'}`
        : '\u2014';
    const skew = o => o.skew != null ? (o.skew >= 0 ? `puts +${o.skew.toFixed(1)}` : `calls +${(-o.skew).toFixed(1)}`) : '\u2014';
    const ivRank = o => o.iv_rank != null ? o.iv_rank + '%' : `building (${o.iv_rank_points || 0}d)`;
    const specs = [
        { label: 'Put/call (volume)', fn: o => ({ text: aNum(o.pc_vol, 2) }) },
        { label: 'Put/call ($-weighted)', fn: o => ({ text: aNum(o.pc_prem, 2) }) },
        { label: 'Put/call (open int.)', fn: o => ({ text: aNum(o.pc_oi, 2) }) },
        { label: 'IV (30d) vs realized', fn: o => ({ text: ivVsReal(o), cls: (o.iv30 != null && o.realized_vol != null && o.iv30 > o.realized_vol) ? 'warn' : '' }) },
        { label: 'IV skew (10% OTM)', fn: o => ({ text: skew(o) }) },
        { label: 'Max pain', fn: o => ({ text: aMoney(o.max_pain) }) },
        { label: 'IV rank', fn: o => ({ text: ivRank(o) }) },
    ];
    const rows = specs.map(s => ({
        label: s.label,
        cells: cols.map(c => (c.data && c.data.available) ? s.fn(c.data) : DASH),
    }));
    return buildCompareTable('scale', 'Options sentiment', 'options', headers, rows);
}

function optionsComparePlaceholder() {
    return `<div class="pan"><h3>${svgIcon('scale')}Options sentiment${infoBtn('options')}</h3>
        <div class="loading"><span class="spinner"></span>Loading options...</div></div>`;
}

async function renderAnalysisMulti(el) {
    const symRow = renderSymbolRow('renderAnalysis', { multi: true });
    if (multiSelected.length === 0) {
        el.innerHTML = `${symRow}<div class="loading">Select tickers to compare</div>`;
        return;
    }
    const syms = [...multiSelected];
    const needFast = syms.some(s => !analysisCache[s] || isCacheStale(analysisCache[s]));
    if (needFast) {
        el.innerHTML = `${symRow}<div class="loading"><span class="spinner"></span>Comparing ${syms.length} tickers...</div>`;
        setStatus(`Comparing ${syms.length} tickers...`);
        try {
            await Promise.all(syms.map(async s => {
                if (!analysisCache[s] || isCacheStale(analysisCache[s])) {
                    const res = await app.call('get_analysis', { symbol: s });
                    analysisCache[s] = { data: res, fetchedDate: todayLocalYMD() };
                }
            }));
        } catch (e) {
            el.innerHTML = `${symRow}<div class="loading">Error comparing tickers: ${e.message}</div>`;
            setStatus('Error: ' + e.message);
            return;
        }
    }
    // Bail if the user left multi, switched tab, or changed the selection mid-fetch.
    if (!multiMode || currentTab !== 'analysis' || multiSelected.join(',') !== syms.join(',')) return;

    const cols = syms.map((s, i) => ({
        symbol: s,
        color: MULTI_COLORS[i % MULTI_COLORS.length],
        analysis: analysisCache[s] ? analysisCache[s].data : null,
    }));
    el.innerHTML = `
        ${symRow}
        <div class="panels-multi">
            ${technicalsCompare(cols)}
            ${valuationCompare(cols)}
            <div id="optionsCompare">${optionsComparePlaceholder()}</div>
        </div>
    `;
    setStatus(needFast ? 'Loaded' : 'Cached');
    loadOptionsCompare(syms);
}

async function loadOptionsCompare(syms) {
    try {
        await Promise.all(syms.map(async s => {
            if (!optionsCache[s] || isCacheStale(optionsCache[s])) {
                const res = await app.call('get_options_analysis', { symbol: s });
                optionsCache[s] = { data: res, fetchedDate: todayLocalYMD() };
            }
        }));
    } catch (e) {
        const c = document.getElementById('optionsCompare');
        if (c && multiMode && currentTab === 'analysis') {
            c.innerHTML = `<div class="pan"><h3>${svgIcon('scale')}Options sentiment</h3><div class="loading">Error loading options: ${e.message}</div></div>`;
        }
        return;
    }
    if (!multiMode || currentTab !== 'analysis' || multiSelected.join(',') !== syms.join(',')) return;
    const c = document.getElementById('optionsCompare');
    if (!c) return;
    const cols = syms.map((s, i) => ({
        symbol: s,
        color: MULTI_COLORS[i % MULTI_COLORS.length],
        data: optionsCache[s] ? optionsCache[s].data : null,
    }));
    c.innerHTML = optionsCompare(cols);
}

// -- Status bar --
function setStatus(msg) {
    document.getElementById('statusText').textContent = msg;
}

function updateStatusBar(status, timestamp) {
    const statusEl = document.getElementById('statusText');
    const timeEl = document.getElementById('statusTime');

    statusEl.textContent = status === 'refreshed' ? 'Refreshed'
                         : status === 'no_updates' ? 'No Updates'
                         : status === 'ticker_not_found' ? 'Ticker Not Found'
                         : status === 'ticker_exists' ? 'Ticker Already In Watchlist'
                         : 'Cached';

    if (timestamp) {
        const d = new Date(timestamp);
        const date = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
        let hr = d.getHours();
        const ampm = hr >= 12 ? 'PM' : 'AM';
        hr = hr % 12 || 12;
        const min = String(d.getMinutes()).padStart(2, '0');
        const sec = String(d.getSeconds()).padStart(2, '0');
        timeEl.textContent = date + ' ' + hr + ':' + min + ':' + sec + ' ' + ampm;
    } else {
        timeEl.textContent = '';
    }
}

// -- Boot --
document.addEventListener('DOMContentLoaded', init);
