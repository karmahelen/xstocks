#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "flask",
#     "pywebview",
#     "qtpy",
#     "PyQt6",
#     "PyQt6-WebEngine",
#     "finnhub-python",
#     "yfinance",
# ]
# ///

"""
xstocks - Personal stock watchlist (Hearth app).

Uses Finnhub (real-time quotes, news, earnings) + yfinance (historical chart data).
Stores data in SQLite database (xstocks.db).

Run:
    [uv run] xstocks.py                 # native window
    [uv run] xstocks.py --serve [port]  # LAN web access

Developer:  KarmaHelen
Contact:    xstocks.helpless770@passinbox.com
Support:    https://buymeacoffee.com/karmahelen
"""

import json
import math
import re
import sqlite3
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path

import finnhub
import yfinance as yf

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR.parent))

from hearth import run

CONFIG_FILE = BASE_DIR / "xstocks.json"
DB_PATH = BASE_DIR / "xstocks.db"

DEFAULT_CONFIG = {
    "api_key": "",
    "ticker_click_action": "yahoo",  # "yahoo" or "google"
    "auto_refresh_enabled": False,
    "auto_refresh_time": "17:00",      # HH:MM, 24-hour, local time
    "last_auto_refresh": None,         # ISO timestamp of last scheduled bulk refresh
}


def _load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE) as f:
            raw = f.read()
        raw = re.sub(r',\s*([\]}])', r'\1', raw)
        cfg = json.loads(raw)
        for k, v in DEFAULT_CONFIG.items():
            cfg.setdefault(k, v)
        return cfg
    return dict(DEFAULT_CONFIG)


def _save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


class XStocks:
    def __init__(self):
        self.config = _load_config()
        self.db_path = DB_PATH
        self.fh = None
        if self.config["api_key"]:
            self.fh = finnhub.Client(api_key=self.config["api_key"])
        self._init_db()

        # Concurrency primitives.
        # _refresh_lock prevents user-triggered and scheduled refreshes from running concurrently
        # (would otherwise duplicate Finnhub calls and risk last-writer-wins issues in the DB).
        # _config_lock serializes JSON config writes between the main thread (user saving settings)
        # and the scheduler thread (recording last_auto_refresh).
        self._refresh_lock = threading.Lock()
        self._config_lock = threading.Lock()

        # Scheduler thread state. The Event is used both as a stop signal and as the wait primitive
        # for the polling sleep — setting it wakes the thread immediately for clean shutdown / restart.
        self._scheduler_stop = None
        self._scheduler_thread = None
        self._start_scheduler_if_enabled()

    def _save_config_locked(self):
        """Save self.config to disk, serialized via _config_lock so the scheduler thread
        and main thread can't clobber each other's writes."""
        with self._config_lock:
            _save_config(self.config)

    def _init_db(self):
        con = self._connect()
        con.execute("""
            CREATE TABLE IF NOT EXISTS watchlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                position INTEGER
            )
        """)
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_position ON watchlists(position)")
        con.execute("""
            CREATE TABLE IF NOT EXISTS watchlist_tickers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                watchlist_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                UNIQUE(watchlist_id, symbol),
                FOREIGN KEY (watchlist_id) REFERENCES watchlists(id)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS quotes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                watchlist_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                price REAL,
                change REAL,
                pct_change REAL,
                open REAL,
                high REAL,
                low REAL,
                prev_close REAL,
                source TEXT,
                fetched_at TEXT NOT NULL,
                FOREIGN KEY (watchlist_id) REFERENCES watchlists(id)
            )
        """)
        con.commit()
        con.close()

    def _connect(self):
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    def _ensure_finnhub(self):
        if not self.fh:
            raise RuntimeError("Finnhub API key not configured")

    # -- Config --

    def get_config(self):
        return {
            "has_api_key": bool(self.config["api_key"]),
            "ticker_click_action": self.config["ticker_click_action"],
            "auto_refresh_enabled": self.config["auto_refresh_enabled"],
            "auto_refresh_time": self.config["auto_refresh_time"],
        }

    def set_api_key(self, key):
        self.config["api_key"] = key.strip()
        self.fh = finnhub.Client(api_key=self.config["api_key"])
        self._save_config_locked()
        return True

    def set_settings(self, ticker_click_action, auto_refresh_enabled, auto_refresh_time):
        if ticker_click_action not in ("yahoo", "google"):
            raise ValueError("Invalid ticker_click_action")
        if not isinstance(auto_refresh_enabled, bool):
            raise ValueError("auto_refresh_enabled must be a boolean")
        # Time format validation: HH:MM, 24-hour
        if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", auto_refresh_time):
            raise ValueError("auto_refresh_time must be HH:MM (24-hour)")

        was_enabled = self.config["auto_refresh_enabled"]
        old_time = self.config["auto_refresh_time"]

        self.config["ticker_click_action"] = ticker_click_action
        self.config["auto_refresh_enabled"] = auto_refresh_enabled
        self.config["auto_refresh_time"] = auto_refresh_time

        # First-enable: seed last_auto_refresh to "now" so catch-up doesn't fire immediately
        # (would be confusing UX if checking the box triggered an instant refresh).
        if auto_refresh_enabled and not was_enabled:
            self.config["last_auto_refresh"] = datetime.now().isoformat()

        self._save_config_locked()

        # Restart scheduler if any auto-refresh setting changed
        if was_enabled != auto_refresh_enabled or old_time != auto_refresh_time:
            self._stop_scheduler()
            self._start_scheduler_if_enabled()

        return True

    # -- Watchlists --

    def get_watchlists(self):
        """Return all watchlists ordered by position."""
        con = self._connect()
        rows = con.execute("SELECT id, name FROM watchlists ORDER BY position ASC").fetchall()
        con.close()
        return [dict(r) for r in rows]

    def _validate_symbol(self, symbol):
        """Check if a symbol returns a real price from Finnhub or yfinance."""
        try:
            q = self._quote_finnhub(symbol)
            if q["price"]:
                return True
        except Exception:
            pass
        try:
            q = self._quote_yfinance(symbol)
            if q["price"]:
                return True
        except Exception:
            pass
        return False

    def _validate_symbols(self, symbols):
        """Validate a list of symbols. Returns (valid, invalid) lists."""
        valid = []
        invalid = []
        for sym in symbols:
            if self._validate_symbol(sym):
                valid.append(sym)
            else:
                invalid.append(sym)
        return valid, invalid

    def add_watchlist(self, name, tickers):
        """Create a new watchlist with validated tickers and do initial refresh."""
        name = name.strip()
        if not name:
            raise ValueError("Watchlist name is required")

        symbols = list(dict.fromkeys(
            t.strip().upper() for t in tickers.split(",") if t.strip()
        ))
        if not symbols:
            raise ValueError("At least one ticker is required")

        # Check for name conflict
        con = self._connect()
        exists = con.execute("SELECT id FROM watchlists WHERE name = ?", (name,)).fetchone()
        con.close()
        if exists:
            return {"status": "name_exists"}

        # Validate tickers
        valid, invalid = self._validate_symbols(symbols)
        if not valid:
            return {"status": "ticker_not_found", "invalid_tickers": invalid}

        con = self._connect()
        next_pos = con.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM watchlists").fetchone()[0]
        cur = con.execute("INSERT INTO watchlists (name, position) VALUES (?, ?)", (name, next_pos))
        watchlist_id = cur.lastrowid
        for sym in valid:
            con.execute(
                "INSERT OR IGNORE INTO watchlist_tickers (watchlist_id, symbol) VALUES (?, ?)",
                (watchlist_id, sym),
            )
        con.commit()
        con.close()

        result = self.refresh_quotes(watchlist_id=watchlist_id)
        result["watchlist"] = {"id": watchlist_id, "name": name}
        result["watchlists"] = self.get_watchlists()
        if invalid:
            result["status"] = "invalid_tickers"
            result["invalid_tickers"] = invalid
        return result

    def update_watchlist(self, watchlist_id, name, tickers):
        """Update a watchlist's name and tickers."""
        name = name.strip()
        if not name:
            raise ValueError("Watchlist name is required")

        symbols = list(dict.fromkeys(
            t.strip().upper() for t in tickers.split(",") if t.strip()
        ))
        if not symbols:
            raise ValueError("At least one ticker is required")

        # Check for name conflict with a different watchlist
        con = self._connect()
        exists = con.execute(
            "SELECT id FROM watchlists WHERE name = ? AND id != ?", (name, watchlist_id)
        ).fetchone()
        if exists:
            con.close()
            return {"status": "name_exists"}

        # Figure out which tickers are new vs existing
        current_symbols = self._get_watchlist_symbols(watchlist_id)
        new_symbols = [s for s in symbols if s not in current_symbols]
        removed_symbols = [s for s in current_symbols if s not in symbols]
        kept_symbols = [s for s in symbols if s in current_symbols]

        # Validate only the new tickers
        invalid = []
        valid_new = []
        if new_symbols:
            valid_new, invalid = self._validate_symbols(new_symbols)

        final_symbols = kept_symbols + valid_new

        if not final_symbols:
            return {"status": "ticker_not_found", "invalid_tickers": invalid}

        # Update name
        con.execute("UPDATE watchlists SET name = ? WHERE id = ?", (name, watchlist_id))

        # Remove old tickers
        if removed_symbols:
            placeholders = ",".join("?" * len(removed_symbols))
            con.execute(
                f"DELETE FROM watchlist_tickers WHERE watchlist_id = ? AND symbol IN ({placeholders})",
                [watchlist_id] + removed_symbols,
            )

        # Add new valid tickers
        for sym in valid_new:
            con.execute(
                "INSERT OR IGNORE INTO watchlist_tickers (watchlist_id, symbol) VALUES (?, ?)",
                (watchlist_id, sym),
            )

        con.commit()
        con.close()

        result = self.refresh_quotes(watchlist_id=watchlist_id)
        result["watchlist"] = {"id": watchlist_id, "name": name}
        result["watchlists"] = self.get_watchlists()
        if invalid:
            result["status"] = "invalid_tickers"
            result["invalid_tickers"] = invalid
        return result

    def delete_watchlist(self, watchlist_id):
        """Delete a watchlist and all associated data, then renumber positions to stay dense."""
        con = self._connect()
        con.execute("DELETE FROM quotes WHERE watchlist_id = ?", (watchlist_id,))
        con.execute("DELETE FROM watchlist_tickers WHERE watchlist_id = ?", (watchlist_id,))
        con.execute("DELETE FROM watchlists WHERE id = ?", (watchlist_id,))

        # Renumber: get remaining ids in current position order, reassign 1..N.
        # Two-pass to avoid UNIQUE conflicts: negate everyone first, then set positives.
        remaining_ids = [r["id"] for r in con.execute(
            "SELECT id FROM watchlists ORDER BY position ASC"
        ).fetchall()]
        con.execute("UPDATE watchlists SET position = -position")
        for new_pos, wid in enumerate(remaining_ids, start=1):
            con.execute("UPDATE watchlists SET position = ? WHERE id = ?", (new_pos, wid))

        con.commit()
        con.close()

        remaining = self.get_watchlists()
        return {"status": "deleted", "watchlists": remaining}

    def reorder_watchlists(self, ordered_ids):
        """Apply a new position ordering. ordered_ids is the new order as a list of watchlist ids.
        Must contain exactly the current set of ids — no missing, no extra, no duplicates."""
        if not isinstance(ordered_ids, list):
            raise ValueError("ordered_ids must be a list")

        con = self._connect()
        current_ids = {r["id"] for r in con.execute("SELECT id FROM watchlists").fetchall()}
        new_ids = set(ordered_ids)

        if len(ordered_ids) != len(new_ids):
            con.close()
            raise ValueError("ordered_ids contains duplicates")
        if new_ids != current_ids:
            con.close()
            raise ValueError("ordered_ids must match current watchlist ids exactly")

        # Two-pass update inside a transaction to satisfy UNIQUE(position).
        # Pass 1: flip everyone to negative — guaranteed unique because positions
        # were unique. Pass 2: set new positive values.
        con.execute("UPDATE watchlists SET position = -position")
        for new_pos, wid in enumerate(ordered_ids, start=1):
            con.execute("UPDATE watchlists SET position = ? WHERE id = ?", (new_pos, wid))
        con.commit()
        con.close()

        return {"status": "reordered", "watchlists": self.get_watchlists()}

    def _get_watchlist_symbols(self, watchlist_id):
        """Get sorted list of symbols for a watchlist."""
        con = self._connect()
        rows = con.execute(
            "SELECT symbol FROM watchlist_tickers WHERE watchlist_id = ? ORDER BY symbol ASC",
            (watchlist_id,),
        ).fetchall()
        con.close()
        return [r["symbol"] for r in rows]

    # -- Ticker management --

    def add_ticker(self, watchlist_id, symbol):
        """Validate and add a ticker to a watchlist, then do a full refresh."""
        s = symbol.strip().upper()
        if not s:
            return self.get_quotes(watchlist_id=watchlist_id)

        # Check if already in watchlist
        existing = self._get_watchlist_symbols(watchlist_id)
        if s in existing:
            return {"status": "ticker_exists"}

        # Validate
        if not self._validate_symbol(s):
            return {"status": "ticker_not_found"}

        con = self._connect()
        con.execute(
            "INSERT OR IGNORE INTO watchlist_tickers (watchlist_id, symbol) VALUES (?, ?)",
            (watchlist_id, s),
        )
        con.commit()
        con.close()

        return self.refresh_quotes(watchlist_id=watchlist_id)

        con = self._connect()
        con.execute(
            "INSERT OR IGNORE INTO watchlist_tickers (watchlist_id, symbol) VALUES (?, ?)",
            (watchlist_id, s),
        )
        con.commit()
        con.close()

        return self.refresh_quotes(watchlist_id=watchlist_id)

    def remove_ticker(self, watchlist_id, symbol):
        """Remove a ticker from a watchlist and return cached data."""
        s = symbol.strip().upper()
        con = self._connect()
        con.execute(
            "DELETE FROM watchlist_tickers WHERE watchlist_id = ? AND symbol = ?",
            (watchlist_id, s),
        )
        con.commit()
        con.close()

        return self._get_cached_quotes(watchlist_id)

    # -- Quotes --

    _COMPARE_FIELDS = ("price", "change", "pct_change", "open", "high", "low", "prev_close")

    def _fetch_quote(self, symbol):
        """Fetch a single symbol's quote through the Finnhub → yfinance fallback chain."""
        try:
            return self._quote_finnhub(symbol)
        except Exception:
            try:
                return self._quote_yfinance(symbol)
            except Exception:
                return self._empty_quote(symbol)

    def _apply_quotes_to_watchlist(self, con, watchlist_id, fresh_by_symbol, fetched_at):
        """Apply pre-fetched quotes to a single watchlist's quotes table rows.
        Implements the same compare/insert/update logic as refresh_quotes but
        with externally-supplied data so the bulk path can dedupe API calls.

        Caller provides the open connection (so a bulk operation can share one)
        and the timestamp (so a bulk operation can use the same fetched_at for
        all watchlists touched in this pass).

        Returns dict with `quotes`, `status`, `timestamp` keys.
        """
        symbols = self._get_watchlist_symbols(watchlist_id)
        if not symbols:
            return {"quotes": [], "status": "refreshed", "timestamp": None, "watchlist_id": watchlist_id}

        # Build results from the pre-fetched dict (preserve watchlist's symbol order)
        results = [fresh_by_symbol[s] for s in symbols if s in fresh_by_symbol]
        if not results:
            return {"quotes": [], "status": "no_updates", "timestamp": fetched_at, "watchlist_id": watchlist_id}

        # Load current cache for comparison
        cached = self._get_cached_quotes(watchlist_id)
        cached_quotes = cached["quotes"]
        cached_ts = cached["timestamp"]
        cached_map = {q["symbol"]: q for q in cached_quotes}

        existing = [q for q in results if q["symbol"] in cached_map]
        new_syms = [q for q in results if q["symbol"] not in cached_map]

        existing_changed = False
        for new_q in existing:
            old_q = cached_map[new_q["symbol"]]
            for field in self._COMPARE_FIELDS:
                if new_q.get(field) != old_q.get(field):
                    existing_changed = True
                    break
            if existing_changed:
                break

        if not cached_quotes or existing_changed:
            for q in results:
                con.execute(
                    """INSERT INTO quotes
                       (watchlist_id, symbol, price, change, pct_change, open, high, low, prev_close, source, fetched_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (watchlist_id, q["symbol"], q["price"], q["change"], q["pct_change"],
                     q["open"], q["high"], q["low"], q["prev_close"],
                     q["source"], fetched_at),
                )
            status = "refreshed"
        elif new_syms:
            for q in new_syms:
                con.execute(
                    """INSERT INTO quotes
                       (watchlist_id, symbol, price, change, pct_change, open, high, low, prev_close, source, fetched_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (watchlist_id, q["symbol"], q["price"], q["change"], q["pct_change"],
                     q["open"], q["high"], q["low"], q["prev_close"],
                     q["source"], fetched_at),
                )
            existing_syms = [q["symbol"] for q in existing]
            placeholders = ",".join("?" * len(existing_syms))
            con.execute(
                f"""UPDATE quotes SET fetched_at = ?
                    WHERE watchlist_id = ? AND fetched_at = ? AND symbol IN ({placeholders})""",
                [fetched_at, watchlist_id, cached_ts] + existing_syms,
            )
            status = "refreshed"
        else:
            all_syms = [q["symbol"] for q in results]
            placeholders = ",".join("?" * len(all_syms))
            con.execute(
                f"""UPDATE quotes SET fetched_at = ?
                    WHERE watchlist_id = ? AND fetched_at = ? AND symbol IN ({placeholders})""",
                [fetched_at, watchlist_id, cached_ts] + all_syms,
            )
            status = "no_updates"

        return {"quotes": results, "status": status, "timestamp": fetched_at, "watchlist_id": watchlist_id}

    def refresh_quotes(self, watchlist_id):
        """Fetch fresh quotes for a single watchlist and update the DB.
        Held against _refresh_lock so scheduled bulk refresh can't run simultaneously."""
        with self._refresh_lock:
            symbols = self._get_watchlist_symbols(watchlist_id)
            if not symbols:
                return {"quotes": [], "status": "refreshed", "timestamp": None}

            fetched_at = datetime.now().isoformat()
            fresh = {s: self._fetch_quote(s) for s in symbols}

            con = self._connect()
            result = self._apply_quotes_to_watchlist(con, watchlist_id, fresh, fetched_at)
            con.commit()
            con.close()

            return {"quotes": result["quotes"], "status": result["status"], "timestamp": result["timestamp"]}

    def bulk_refresh_quotes(self):
        """Refresh quotes for every watchlist. Dedupes API calls — each unique symbol
        across all watchlists is fetched exactly once. Held against _refresh_lock."""
        with self._refresh_lock:
            all_watchlists = self.get_watchlists()
            if not all_watchlists:
                return {"watchlists_refreshed": 0, "symbols_fetched": 0, "timestamp": None}

            # Collect symbols per watchlist + the unique set across all
            per_wl_symbols = {wl["id"]: self._get_watchlist_symbols(wl["id"]) for wl in all_watchlists}
            unique_symbols = set()
            for syms in per_wl_symbols.values():
                unique_symbols.update(syms)

            if not unique_symbols:
                return {"watchlists_refreshed": 0, "symbols_fetched": 0, "timestamp": None}

            fetched_at = datetime.now().isoformat()

            # Fetch each unique symbol exactly once
            fresh = {s: self._fetch_quote(s) for s in unique_symbols}

            # Apply to each watchlist in a single transaction
            con = self._connect()
            results = []
            for wl in all_watchlists:
                wl_fresh = {s: fresh[s] for s in per_wl_symbols[wl["id"]] if s in fresh}
                if not wl_fresh:
                    continue
                results.append(self._apply_quotes_to_watchlist(con, wl["id"], wl_fresh, fetched_at))
            con.commit()
            con.close()

            return {
                "watchlists_refreshed": len(results),
                "symbols_fetched": len(unique_symbols),
                "timestamp": fetched_at,
                "results": results,
            }

    def _get_cached_quotes(self, watchlist_id):
        """Query DB for the most recent quote per symbol for a watchlist.
        Returns whatever is cached — no auto-refresh."""
        symbols = self._get_watchlist_symbols(watchlist_id)
        if not symbols:
            return {"quotes": [], "status": "cached", "timestamp": None}

        con = self._connect()
        placeholders = ",".join("?" * len(symbols))
        rows = con.execute(
            f"""SELECT q.symbol, q.price, q.change, q.pct_change,
                       q.open, q.high, q.low, q.prev_close, q.source, q.fetched_at
                FROM quotes q
                INNER JOIN (
                    SELECT symbol, MAX(fetched_at) AS max_ts
                    FROM quotes
                    WHERE watchlist_id = ? AND symbol IN ({placeholders})
                    GROUP BY symbol
                ) latest ON q.symbol = latest.symbol AND q.fetched_at = latest.max_ts
                WHERE q.watchlist_id = ?""",
            [watchlist_id] + symbols + [watchlist_id],
        ).fetchall()
        con.close()

        if not rows:
            return {"quotes": [], "status": "cached", "timestamp": None}

        quote_map = {r["symbol"]: dict(r) for r in rows}
        ordered = [quote_map[sym] for sym in symbols if sym in quote_map]
        timestamp = min(q["fetched_at"] for q in ordered) if ordered else None

        return {"quotes": ordered, "status": "cached", "timestamp": timestamp}

    def get_quotes(self, watchlist_id):
        """Return cached quotes, auto-refresh if data is missing."""
        symbols = self._get_watchlist_symbols(watchlist_id)
        result = self._get_cached_quotes(watchlist_id)
        if not result["quotes"] or len(result["quotes"]) < len(symbols):
            return self.refresh_quotes(watchlist_id)
        return result

    def _empty_quote(self, symbol):
        """Fallback when both APIs fail."""
        return {
            "symbol": symbol, "price": 0, "change": 0, "pct_change": 0,
            "high": 0, "low": 0, "open": 0, "prev_close": 0,
            "source": "none",
        }

    def _quote_finnhub(self, symbol):
        self._ensure_finnhub()
        q = self.fh.quote(symbol)
        return {
            "symbol": symbol,
            "price": q.get("c") or 0,
            "change": q.get("d") or 0,
            "pct_change": q.get("dp") or 0,
            "high": q.get("h") or 0,
            "low": q.get("l") or 0,
            "open": q.get("o") or 0,
            "prev_close": q.get("pc") or 0,
            "source": "finnhub",
        }

    def _quote_yfinance(self, symbol):
        t = yf.Ticker(symbol)
        info = t.fast_info
        price = info.last_price
        prev = info.previous_close
        change = price - prev if prev else 0
        pct = (change / prev * 100) if prev else 0
        return {
            "symbol": symbol,
            "price": round(price, 2),
            "change": round(change, 2),
            "pct_change": round(pct, 2),
            "high": round(info.day_high, 2) if info.day_high else 0,
            "low": round(info.day_low, 2) if info.day_low else 0,
            "open": round(info.open, 2) if info.open else 0,
            "prev_close": round(prev, 2) if prev else 0,
            "source": "yfinance",
        }

    # -- Historical (yfinance) --

    def get_history(self, symbol, period="1y"):
        t = yf.Ticker(symbol)
        df = t.history(period=period)
        if df.empty:
            return []
        records = []
        for date, row in df.iterrows():
            o, h, l, c, v = row["Open"], row["High"], row["Low"], row["Close"], row["Volume"]
            if any(math.isnan(x) for x in (o, h, l, c)):
                continue
            records.append({
                "date": date.strftime("%Y-%m-%d"),
                "open": round(o, 2),
                "high": round(h, 2),
                "low": round(l, 2),
                "close": round(c, 2),
                "volume": int(v) if not math.isnan(v) else 0,
            })
        return records

    def get_db_date_range(self, symbol):
        """Return the earliest and latest date (YYYY-MM-DD) we have quotes for this symbol.
        Combines data across all watchlists that contain the symbol."""
        con = self._connect()
        row = con.execute(
            "SELECT MIN(date(fetched_at)) AS first, MAX(date(fetched_at)) AS last "
            "FROM quotes WHERE symbol = ?",
            (symbol,),
        ).fetchone()
        con.close()
        return {"first": row["first"], "last": row["last"]}

    def get_history_from_db(self, symbol, start_date, end_date):
        """Return all quote points for a symbol within an inclusive date range.
        Returns a list of {date, close, volume} dicts compatible with the chart code.
        `date` is the full ISO timestamp (so intraday points sort correctly),
        `close` is the price column, `volume` is None (the DB doesn't store it)."""
        con = self._connect()
        rows = con.execute(
            "SELECT fetched_at, price FROM quotes "
            "WHERE symbol = ? AND date(fetched_at) >= ? AND date(fetched_at) <= ? "
            "ORDER BY fetched_at ASC",
            (symbol, start_date, end_date),
        ).fetchall()
        con.close()
        return [
            {"date": r["fetched_at"], "close": r["price"], "volume": None}
            for r in rows
        ]

    # -- News (Finnhub) --

    def get_news(self, symbol):
        self._ensure_finnhub()
        today = datetime.now()
        from_date = (today - timedelta(days=7)).strftime("%Y-%m-%d")
        to_date = today.strftime("%Y-%m-%d")
        news = self.fh.company_news(symbol, _from=from_date, to=to_date)
        results = []
        for item in news[:20]:
            results.append({
                "headline": item.get("headline", ""),
                "summary": item.get("summary", ""),
                "source": item.get("source", ""),
                "url": item.get("url", ""),
                "datetime": item.get("datetime", 0),
                "image": item.get("image", ""),
            })
        return results

    # -- Earnings (Finnhub) --

    def get_earnings(self, symbol):
        self._ensure_finnhub()
        earnings = self.fh.company_earnings(symbol, limit=8)
        results = []
        for e in earnings:
            results.append({
                "period": e.get("period", ""),
                "actual": e.get("actual"),
                "estimate": e.get("estimate"),
                "surprise": e.get("surprise"),
                "surprise_pct": e.get("surprisePercent"),
            })
        return results

    # -- Auto-refresh scheduler --

    # Poll interval in seconds. The scheduler thread wakes every POLL_INTERVAL seconds
    # to check the wall clock against the scheduled time. Lower = more precise firing but
    # slightly more wakeups; either way the per-tick CPU cost is microseconds. 5 min keeps
    # the system mostly idle while firing within 5 min of the scheduled time — fine for a
    # daily after-market-close refresh.
    SCHEDULER_POLL_INTERVAL = 300  # 5 minutes

    def _start_scheduler_if_enabled(self):
        """Start the scheduler thread if auto-refresh is enabled. Idempotent — safe to call
        when already started (it's not; we only call this from __init__ and set_settings
        after _stop_scheduler)."""
        if not self.config["auto_refresh_enabled"]:
            return
        self._scheduler_stop = threading.Event()
        self._scheduler_thread = threading.Thread(
            target=self._scheduler_loop, daemon=True, name="xstocks-scheduler"
        )
        self._scheduler_thread.start()

    def _stop_scheduler(self):
        """Signal the scheduler thread to stop. The thread will exit at its next wake.
        We don't join — it's a daemon thread, set the event and move on."""
        if self._scheduler_stop is not None:
            self._scheduler_stop.set()
        self._scheduler_stop = None
        self._scheduler_thread = None

    def _scheduler_loop(self):
        """The scheduler's main loop. Wakes periodically, decides whether to fire a bulk
        refresh based on wall-clock comparison, then sleeps until the next tick (or until
        signalled to stop). Self-correcting against missed ticks, system sleep, etc."""
        # Capture the Event at start; if set_settings restarts the scheduler, this thread
        # still holds the old Event and will exit cleanly when the old Event is signalled.
        stop_event = self._scheduler_stop
        while not stop_event.is_set():
            try:
                self._maybe_run_scheduled_refresh()
            except Exception as e:
                # Don't let exceptions kill the scheduler thread
                print(f"[xstocks scheduler] error: {e}", file=sys.stderr)
            # Wait until the next tick or until signalled. Event.wait returns True if set.
            if stop_event.wait(self.SCHEDULER_POLL_INTERVAL):
                return

    def _maybe_run_scheduled_refresh(self):
        """Check whether a scheduled refresh should run now, and if so, run it.

        Fires when: today's scheduled time has arrived AND we haven't yet run a scheduled
        refresh that's >= today's scheduled time. This handles both the normal case
        (fire daily at scheduled time) and the catch-up case (app was closed yesterday,
        opens today, scheduled time has passed — fire now).
        """
        now = datetime.now()
        try:
            sched_h, sched_m = self.config["auto_refresh_time"].split(":")
            sched_h, sched_m = int(sched_h), int(sched_m)
        except (ValueError, KeyError):
            return  # malformed config, skip
        scheduled_today = now.replace(hour=sched_h, minute=sched_m, second=0, microsecond=0)

        if now < scheduled_today:
            return  # scheduled time hasn't arrived yet today

        last_str = self.config.get("last_auto_refresh")
        if last_str:
            try:
                last_dt = datetime.fromisoformat(last_str)
            except ValueError:
                last_dt = None
        else:
            last_dt = None

        # If we already ran on or after today's scheduled time, nothing to do
        if last_dt is not None and last_dt >= scheduled_today:
            return

        # Time to fire
        self.bulk_refresh_quotes()
        self.config["last_auto_refresh"] = datetime.now().isoformat()
        self._save_config_locked()


if __name__ == "__main__":
    run(
        XStocks(),
        frontend=str(BASE_DIR / "xstocks.html"),
        title="xstocks",
        port=8081,
        window={
            "width": 960,
            "height": 640,
            "min_size": (700, 400),
            "background_color": "#0f1117",
            "text_select": True,
        },
    )
