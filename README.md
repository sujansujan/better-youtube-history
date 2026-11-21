# Better YouTube History

A fast, 100% local, privacy-first browser extension for **Chrome (Chromium)** and **Firefox** that tracks your YouTube watch history with an indexed local database, virtual scrolling, instant search, watch statistics, and Google Takeout import.

---

## Features

- **Lightning-Fast IndexedDB Engine** — Stores history locally in a native B-tree indexed database (`by_lastWatchedAt`, `by_durationWatched`, `by_channelLower`, and a `multiEntry` inverted token index `by_tokens`). Stays instant on scroll and search even with **50,000+ videos**.
- **Virtualized Scrolling** — Constant-size recycled DOM pool (`~14` rows) for smooth 60fps scrolling regardless of history size.
- **Google Takeout Importer** — Drop your official Google Takeout `watch-history.json` into **Import** to load years of past YouTube history in seconds (automatically skips Google Ads & removed videos, aggregates watch counts, and preserves local playback progress).
- **Full-Page History View & Bulk Delete** — Click the expand icon (`⤢`) to open your history in a spacious full browser tab with multi-select bulk deletion.
- **Watch Stats & Top Channels** — Built-in **Stats** tab with total watch time, completion rate, 7-day activity chart, and clickable Top Channels.
- **Click-to-Filter Channel & Date Ranges** — Click any channel name on a card (or in Top Channels) to filter instantly, and combine with `Today` / `7d` / `30d` date filters, watch status (`All` / `In Progress` / `Watched`), and sort (`Recent` / `Oldest` / `Longest`).
- **Smart YouTube Overlays** — Adds subtle progress bars, one-click **Resume** badges, and dimmed thumbnails for finished videos directly on YouTube feeds using `IntersectionObserver` + batched primary-key lookups (ignores YouTube ads; supports Shorts).
- **100% Private & Zero Dependencies** — No telemetry, no analytics, no remote scripts, no external Google Fonts requests, and strict Content Security Policy.

---

## Installation (Chrome & Firefox in This Repo)

Both ready-to-load browser builds are included in this repository under [`dist/chrome`](dist/chrome) and [`dist/firefox`](dist/firefox) (and packaged `.zip` archives are attached to Releases).

### Chrome / Brave / Edge / Arc
1. Clone or download this repository (or unzip `better-youtube-history-chrome-v2.0.0.zip` from Releases).
2. Open `chrome://extensions/` in your browser.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`dist/chrome`** folder.

### Firefox
1. Clone or download this repository (or download `better-youtube-history-firefox-v2.0.0.zip` from Releases).
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on...** and select **`dist/firefox/manifest.json`** (or install a signed `.xpi` / submit `better-youtube-history-firefox-v2.0.0.zip` to [Firefox Add-ons](https://addons.mozilla.org/developers/)).

---

## Importing Google Takeout History

1. Go to [Google Takeout](https://takeout.google.com/), select **YouTube and YouTube Music** -> **history**, and set the history format to **JSON**.
2. Extract `Takeout/YouTube and YouTube Music/history/watch-history.json`.
3. Open Better YouTube History, click the **Import** button, and select `watch-history.json`.

---

## Development & Building

Requires **Node.js 18+** (zero npm runtime dependencies).

```bash
# Run security, functional, migration, and 50,000-video performance tests
npm test

# Build & validate both Chrome and Firefox packages into dist/
npm run build
```

### Repository Structure

```text
├── src/
│   ├── shared/
│   │   ├── browser-api.js      # Cross-browser Chrome/Firefox wrapper & sender validation
│   │   ├── sanitize.js         # Strict ID validation, prototype-pollution protection, Takeout parser
│   │   └── db.js               # IndexedDB B-tree + inverted-index search & stats engine
│   ├── background.js           # MV3 service worker (Chrome) / event page (Firefox)
│   ├── content.js              # YouTube tracker & IntersectionObserver thumbnail overlays
│   ├── popup.html              # Responsive popup & full-page history/stats UI
│   ├── popup.css               # Dark glassmorphism styles (compact + full-page)
│   └── popup.js                # Virtualized scroller, search, filters, stats, bulk delete
├── manifests/
│   ├── manifest.chrome.json    # Chrome MV3 manifest (service_worker)
│   └── manifest.firefox.json   # Firefox MV3 manifest (scripts + gecko settings)
├── dist/
│   ├── chrome/                 # Ready-to-load Chrome unpacked extension
│   └── firefox/                # Ready-to-load Firefox extension
├── icons/                      # SVG source + 16/32/48/128px PNG icons
├── scripts/build.mjs           # Cross-browser build & manifest validator
├── tests/run-tests.mjs         # Security, unit, migration & 50k-video benchmark suite
└── PRIVACY.md                  # Local-first privacy policy
```

---

## Privacy & Security

See [PRIVACY.md](PRIVACY.md). All data stays strictly in your browser's local IndexedDB.

## License

[MIT](LICENSE)
