# Distribution & Firefox AMO Listing Guide

## Built Packages
Run `npm run build` (or `node scripts/build.mjs`) to generate validated, unminified packages:
- **Chrome / Chromium (GitHub Releases & Unpacked):** `dist/chrome/` and `dist/better-youtube-history-chrome-v2.0.0.zip`
- **Firefox Add-ons (AMO & GitHub Releases):** `dist/firefox/` and `dist/better-youtube-history-firefox-v2.0.0.zip`

---

## Listing Copy

### Short Description (<= 132 chars)
Fast, private, local YouTube watch history with instant search, virtual scrolling, watch stats, and Google Takeout import.

### Detailed Description
Take full control of your YouTube watch history — stored 100% locally on your device.

**Key Features**
- **Lightning-Fast Performance:** Powered by an indexed local IndexedDB database and virtualized scrolling — stays instant on scroll and search even with 50,000+ videos.
- **Google Takeout Importer:** Drop your official `watch-history.json` into Import to load years of past YouTube history (automatically skips Google Ads & removed videos).
- **Full-Page History View & Bulk Delete:** Expand the popup into a full browser tab with multi-select atomic batch deletion.
- **Watch Stats & Top Channels:** View total watch time, completion rate, a 7-day activity chart, and clickable Top Channels.
- **Instant Search & Filters:** Search by title or channel (accent-insensitive & camelCase aware), click any channel name to filter, and combine `Today` / `7d` / `30d` date filters with `All` / `In Progress` / `Watched`.
- **One-Click Resume & Progress Bars:** Tracks playback locally (ignoring YouTube ads) and renders subtle progress bars, "Resume" badges, and dimmed overlays for finished videos directly on YouTube thumbnails.
- **100% Private:** Zero tracking, zero telemetry, zero remote servers, and zero external font requests.

---

## Publishing to Firefox Add-ons (AMO — Free)
1. Open the [Firefox Add-on Developer Hub](https://addons.mozilla.org/developers/addon/submit/distribution).
2. Choose **On this site** (public listing) and upload `dist/better-youtube-history-firefox-v2.0.0.zip`.
3. Add-on ID is configured in `manifests/manifest.firefox.json` as `better-youtube-history@sujansujan.github.io` with `data_collection_permissions: { required: ["none"] }`.
4. Since all source code is clean, readable, and unminified, select **No** when asked if the extension uses minified/transpiled code.
5. Paste the description above, copy the Privacy Policy from `PRIVACY.md`, and submit!
