# Privacy Policy — Better YouTube History

**Last Updated:** November 21, 2026

Better YouTube History is designed with strict local-first privacy.

## Data Collection
- **Zero telemetry or analytics:** We do not collect, transmit, sell, or share any personal data, browsing history, usage statistics, or diagnostics with any remote server or third party.
- **No external fonts or tracking scripts:** The extension UI loads zero remote scripts or external font stylesheets.

## Local Storage Only
- All watch history data (YouTube video ID, video title, channel name, watch progress, duration, and timestamps) is stored **exclusively on your local device** inside your browser's built-in IndexedDB database.
- Video thumbnails shown in the extension popup are fetched directly from YouTube's standard thumbnail CDN (`https://i.ytimg.com`) when you open the popup.
- You can inspect, export (JSON), delete individual entries, or clear your entire history at any time from the extension popup.

## Permissions Used
- `storage`: Used solely to perform a one-time lossless migration for users upgrading from v1.0.0 (`browser.storage.local`) to the IndexedDB engine.
- `*://*.youtube.com/*` (Content Script): Used strictly on YouTube pages to track active video playback progress locally and render watched/resume overlays on thumbnails.

## Contact
If you have any questions about this privacy policy, please contact the developer via the support link listed on the Chrome Web Store or Firefox Add-ons listing.
