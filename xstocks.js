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
                       value="${autoRefreshTime}"
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
function renderSymbolRow(rerender) {
    const symBtns = quotes.map(sq =>
        `<button class="chart-btn ${sq.symbol === selectedSymbol ? 'active' : ''}"
                 onclick="selectedSymbol='${sq.symbol}'; ${rerender}(document.getElementById('content'))">${sq.symbol}</button>`
    ).join('');
    return `
        <div class="symbol-row">
            <div class="symbol-group">${symBtns}</div>
            <div class="symbol-nav">${renderWatchlistNav('compact')}</div>
        </div>
    `;
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

    const symRow = renderSymbolRow('renderChart');

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
