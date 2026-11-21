/**
 * src/content.js
 * Injected into youtube.com.
 *
 * Key optimizations & security hardening:
 * - Cross-browser Chrome + Firefox API support
 * - Ignores YouTube ads so ad duration never corrupts watch history
 * - Flushes progress cleanly on SPA navigation, pause, seek, tab hide, and pagehide
 * - Uses IntersectionObserver + addedNodes MutationObserver + batched IndexedDB lookups
 *   (zero full-history RAM/IPC sync, zero full-DOM polling)
 * - Cleans up stale overlays when YouTube recycles DOM nodes during SPA navigation
 */

(() => {
    'use strict';

    const api = typeof globalThis.browser !== 'undefined' ? globalThis.browser : globalThis.chrome;
    const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
    const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);
    function isValidId(v) {
        return typeof v === 'string' && !FORBIDDEN_IDS.has(v) && VIDEO_ID_RE.test(v);
    }
    const UPDATE_INTERVAL_MS = 10000;
    const MAX_CACHE_ENTRIES = 2000;
    const BATCH_DEBOUNCE_MS = 60;
    const MAX_BATCH_SIZE = 100;

    // --- State ---
    let currentVideoId = null;
    let currentVideoElement = null;
    let lastSentTime = -1;
    let lastSentVideoId = null;
    let updateInterval = null;
    let metadataRetryTimer = null;
    let extensionInvalidated = false;

    const attachedVideos = new WeakSet();

    // Bounded LRU cache of { w, d, c } (watched, totalDuration, completed) or null (not in history)
    const stateCache = new Map();

    // Pending video IDs to query from background IndexedDB
    const pendingLookupIds = new Set();
    // Map<videoId, Set<HTMLAnchorElement>> waiting for lookup results
    const pendingElementsByVideoId = new Map();
    let batchTimer = null;

    // Track observed thumbnail elements to avoid duplicate IntersectionObserver registration
    const observedLinks = new WeakSet();

    // --- Helpers ---

    function sendMessageSafe(message) {
        if (extensionInvalidated || !api?.runtime?.sendMessage) {
            return Promise.resolve(null);
        }
        try {
            const res = api.runtime.sendMessage(message);
            if (res && typeof res.then === 'function') {
                return res.catch((err) => {
                    if (String(err?.message || '').includes('Extension context invalidated')) {
                        extensionInvalidated = true;
                        stopTracking();
                    }
                    return null;
                });
            }
            return new Promise((resolve) => {
                api.runtime.sendMessage(message, (response) => {
                    if (api.runtime?.lastError) {
                        if (String(api.runtime.lastError.message || '').includes('Extension context invalidated')) {
                            extensionInvalidated = true;
                            stopTracking();
                        }
                        resolve(null);
                    } else {
                        resolve(response);
                    }
                });
            });
        } catch {
            extensionInvalidated = true;
            stopTracking();
            return Promise.resolve(null);
        }
    }

    function setCache(videoId, state) {
        if (stateCache.has(videoId)) {
            stateCache.delete(videoId);
        } else if (stateCache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = stateCache.keys().next().value;
            if (oldestKey !== undefined) stateCache.delete(oldestKey);
        }
        stateCache.set(videoId, state);
    }

    function extractVideoIdFromUrl(urlStr) {
        try {
            const parsed = new URL(urlStr, window.location.origin);
            const host = parsed.hostname.toLowerCase();
            if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return null;

            if (parsed.pathname === '/watch') {
                const v = parsed.searchParams.get('v');
                return isValidId(v) ? v : null;
            }
            if (parsed.pathname.startsWith('/shorts/')) {
                const seg = parsed.pathname.slice('/shorts/'.length).split('/')[0];
                return isValidId(seg) ? seg : null;
            }
        } catch {
            return null;
        }
        return null;
    }

    function getCurrentPageVideoId() {
        return extractVideoIdFromUrl(window.location.href);
    }

    function isAdPlaying() {
        const player = document.getElementById('movie_player');
        if (!player) return false;
        return (
            player.classList.contains('ad-showing') ||
            player.classList.contains('ad-interrupting') ||
            Boolean(player.querySelector('.ytp-ad-player-overlay, .ytp-ad-module .video-ads:not(:empty)'))
        );
    }

    function getActiveVideoElement() {
        if (window.location.pathname.startsWith('/shorts/')) {
            return (
                document.querySelector('ytd-reel-video-renderer[is-active] video.html5-main-video') ||
                document.querySelector('#shorts-player video.html5-main-video') ||
                document.querySelector('video.html5-main-video')
            );
        }
        return (
            document.querySelector('#movie_player video.html5-main-video') ||
            document.querySelector('video.html5-main-video') ||
            document.querySelector('video')
        );
    }

    function extractMetadata() {
        const isShorts = window.location.pathname.startsWith('/shorts/');
        let titleText = '';
        let channelText = '';

        if (isShorts) {
            const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]') || document;
            const shortTitle = activeReel.querySelector(
                'yt-shorts-video-title-view-model h2, h2.ytShortsVideoTitleViewModelShortsVideoTitle, .title.ytd-reel-player-header-renderer'
            );
            const shortChannel = activeReel.querySelector(
                'yt-reel-channel-bar-view-model a, #channel-name a, .ytd-channel-name a'
            );
            titleText = shortTitle?.textContent?.trim() || '';
            channelText = shortChannel?.textContent?.trim() || '';
        } else {
            const titleEl = document.querySelector(
                'ytd-watch-metadata h1 yt-formatted-string, ' +
                'h1.ytd-watch-metadata yt-formatted-string, ' +
                '#title > h1 > yt-formatted-string, ' +
                'h1.ytd-video-primary-info-renderer'
            );
            const channelEl = document.querySelector(
                'ytd-watch-metadata #owner ytd-channel-name a, ' +
                'ytd-watch-metadata #upload-info #channel-name a, ' +
                '#owner-name a, ' +
                '#upload-info ytd-channel-name a'
            );
            titleText = titleEl?.textContent?.trim() || '';
            channelText = channelEl?.textContent?.trim() || '';
        }

        if (!titleText && document.title) {
            // Strip leading notification count like "(2) " and trailing " - YouTube"
            const cleanedDocTitle = document.title
                .replace(/^\(\d+\)\s*/, '')
                .replace(/\s*-\s*YouTube$/, '')
                .trim();
            if (cleanedDocTitle && cleanedDocTitle !== 'YouTube') {
                titleText = cleanedDocTitle;
            }
        }

        return {
            title: titleText,
            channel: channelText
        };
    }

    // --- Video Playback Tracking ---

    function sendHistoryUpdate(force = false) {
        if (extensionInvalidated || !currentVideoId) return;
        if (isAdPlaying()) return;

        const videoEl = getActiveVideoElement();
        if (!videoEl) return;
        currentVideoElement = videoEl;

        const durationWatched = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
        const totalDuration = Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? videoEl.duration : 0;

        // Avoid redundant tiny updates for the same video unless forced
        if (
            !force &&
            lastSentVideoId === currentVideoId &&
            Math.abs(durationWatched - lastSentTime) < 1 &&
            durationWatched > 0
        ) {
            return;
        }

        const metadata = extractMetadata();
        // If metadata hasn't populated yet and duration is 0, defer briefly
        if (!metadata.title && durationWatched < 1 && !force) {
            return;
        }

        const videoId = currentVideoId;
        lastSentTime = durationWatched;
        lastSentVideoId = videoId;

        sendMessageSafe({
            action: 'UPDATE_VIDEO_HISTORY',
            payload: {
                videoId,
                title: metadata.title,
                channel: metadata.channel,
                durationWatched,
                totalDuration,
                lastWatchedAt: Date.now()
            }
        }).then((res) => {
            if (res && res.success && res.state) {
                setCache(videoId, res.state);
                refreshDecoratedThumbnailsForVideo(videoId);
            }
        });
    }

    function startTracking() {
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = setInterval(() => {
            const videoEl = getActiveVideoElement();
            if (videoEl && !videoEl.paused && !videoEl.ended) {
                sendHistoryUpdate(false);
            }
        }, UPDATE_INTERVAL_MS);
    }

    function stopTracking() {
        if (updateInterval) {
            clearInterval(updateInterval);
            updateInterval = null;
        }
    }

    function attachVideoListeners(videoElement) {
        if (!videoElement || attachedVideos.has(videoElement)) return;
        attachedVideos.add(videoElement);

        videoElement.addEventListener('play', () => {
            if (getCurrentPageVideoId()) {
                startTracking();
                sendHistoryUpdate(false);
            }
        });

        videoElement.addEventListener('pause', () => {
            stopTracking();
            sendHistoryUpdate(true);
        });

        videoElement.addEventListener('ended', () => {
            stopTracking();
            sendHistoryUpdate(true);
        });

        videoElement.addEventListener('seeked', () => {
            sendHistoryUpdate(true);
        });

        videoElement.addEventListener('loadedmetadata', () => {
            if (getCurrentPageVideoId()) {
                sendHistoryUpdate(false);
            }
        });
    }

    function initVideoTracking() {
        const videoId = getCurrentPageVideoId();
        if (!videoId) {
            currentVideoId = null;
            stopTracking();
            return;
        }

        const isNewVideo = currentVideoId !== videoId;
        if (isNewVideo) {
            currentVideoId = videoId;
            lastSentTime = -1;
            lastSentVideoId = null;
        }

        const videoEl = getActiveVideoElement();
        if (videoEl) {
            currentVideoElement = videoEl;
            attachVideoListeners(videoEl);
            if (!videoEl.paused && !videoEl.ended) {
                startTracking();
            }
        }

        // Wait slightly for YouTube's SPA DOM metadata to reflect the newly navigated video
        if (metadataRetryTimer) clearTimeout(metadataRetryTimer);
        metadataRetryTimer = setTimeout(() => {
            if (currentVideoId === videoId) {
                sendHistoryUpdate(isNewVideo);
            }
        }, 1200);
    }

    // Flush outgoing video progress right before YouTube SPA navigation changes URL/DOM
    document.addEventListener('yt-navigate-start', () => {
        if (currentVideoId) {
            sendHistoryUpdate(true);
        }
    });

    document.addEventListener('yt-navigate-finish', () => {
        initVideoTracking();
        scanNodeForThumbnails(document.body);
    });

    document.addEventListener('yt-page-data-updated', () => {
        if (currentVideoId) {
            sendHistoryUpdate(true);
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && currentVideoId) {
            sendHistoryUpdate(true);
        }
    });

    window.addEventListener('pagehide', () => {
        if (currentVideoId) {
            sendHistoryUpdate(true);
        }
    });

    // --- Thumbnail Overlay Engine (IntersectionObserver + Batch IndexedDB Lookup) ---

    function injectStyles() {
        if (document.getElementById('byh-styles')) return;
        const style = document.createElement('style');
        style.id = 'byh-styles';
        style.textContent = `
            .byh-watched {
                filter: grayscale(1) opacity(0.55) !important;
                transition: filter 0.2s ease;
            }
            .byh-watched:hover {
                filter: grayscale(0.2) opacity(0.92) !important;
            }
            .byh-progress-container {
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                height: 4px;
                background-color: rgba(255, 255, 255, 0.28);
                z-index: 12;
                pointer-events: none;
            }
            .byh-progress-bar {
                height: 100%;
                background-color: #ff2b2b;
            }
            .byh-resume-badge {
                position: absolute;
                top: 6px;
                left: 6px;
                background-color: rgba(12, 12, 16, 0.85);
                color: #ffffff;
                padding: 3px 6px;
                border-radius: 4px;
                font-size: 11px;
                line-height: 1.2;
                font-family: Roboto, Arial, sans-serif;
                font-weight: 500;
                z-index: 12;
                pointer-events: none;
                letter-spacing: 0.1px;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function getThumbnailContainer(link) {
        return (
            link.closest('ytd-thumbnail') ||
            link.closest('yt-thumbnail-view-model') ||
            link.closest('.yt-lockup-view-model__content-image') ||
            link
        );
    }

    function clearOverlay(link) {
        const container = getThumbnailContainer(link);
        if (container) {
            container.classList.remove('byh-watched');
            container.removeAttribute('data-byh-vid');
        }
        const pb = link.querySelector('.byh-progress-container');
        if (pb) pb.remove();
        const badge = link.querySelector('.byh-resume-badge');
        if (badge) badge.remove();
    }

    function applyOverlayToLink(link, videoId, state) {
        if (!link || !link.isConnected) return;

        // Verify the link hasn't been recycled by YouTube's SPA to another video
        const actualId = extractVideoIdFromUrl(link.href);
        if (actualId !== videoId) {
            clearOverlay(link);
            return;
        }

        const container = getThumbnailContainer(link);
        if (!container) return;

        // If container was previously decorated for a different video, clean up first
        const prevVid = container.getAttribute('data-byh-vid');
        if (prevVid && prevVid !== videoId) {
            clearOverlay(link);
        }

        if (!state) {
            clearOverlay(link);
            return;
        }

        injectStyles();
        container.setAttribute('data-byh-vid', videoId);

        const durationWatched = state.w || 0;
        const totalDuration = state.d || 0;
        const completed = Boolean(state.c);

        if (completed) {
            container.classList.add('byh-watched');
            const pb = link.querySelector('.byh-progress-container');
            if (pb) pb.remove();
            const badge = link.querySelector('.byh-resume-badge');
            if (badge) badge.remove();
            return;
        }

        container.classList.remove('byh-watched');

        if (durationWatched > 5) {
            // Safely ensure the watch link resumes at the saved timestamp
            try {
                const urlObj = new URL(link.href);
                if (urlObj.pathname === '/watch') {
                    const desiredT = `${Math.floor(durationWatched)}s`;
                    if (urlObj.searchParams.get('t') !== desiredT) {
                        urlObj.searchParams.set('t', desiredT);
                        link.href = urlObj.toString();
                    }
                }
            } catch {
                // Ignore malformed URLs
            }

            // Ensure link/container can position absolute overlays
            const overlayHost = link.querySelector('#overlays') || link;
            const computedPos = window.getComputedStyle(link).position;
            if (computedPos === 'static') {
                link.style.position = 'relative';
            }

            let progressContainer = link.querySelector('.byh-progress-container');
            let progressBar;
            if (!progressContainer) {
                progressContainer = document.createElement('div');
                progressContainer.className = 'byh-progress-container';
                progressBar = document.createElement('div');
                progressBar.className = 'byh-progress-bar';
                progressContainer.appendChild(progressBar);
                overlayHost.appendChild(progressContainer);
            } else {
                progressBar = progressContainer.querySelector('.byh-progress-bar');
            }

            if (progressBar) {
                const pct = totalDuration > 0
                    ? Math.min(100, Math.max(2, (durationWatched / totalDuration) * 100))
                    : 50;
                progressBar.style.width = `${pct.toFixed(1)}%`;
            }

            let badge = link.querySelector('.byh-resume-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'byh-resume-badge';
                badge.textContent = 'Resume';
                overlayHost.appendChild(badge);
            }
        } else {
            const pb = link.querySelector('.byh-progress-container');
            if (pb) pb.remove();
            const badge = link.querySelector('.byh-resume-badge');
            if (badge) badge.remove();
        }
    }

    function refreshDecoratedThumbnailsForVideo(videoId) {
        const state = stateCache.get(videoId);
        if (!state) return;
        const candidates = document.querySelectorAll(
            `a#thumbnail[href*="${videoId}"], a.yt-lockup-view-model__content-image[href*="${videoId}"]`
        );
        candidates.forEach((link) => {
            if (extractVideoIdFromUrl(link.href) === videoId) {
                applyOverlayToLink(link, videoId, state);
            }
        });
    }

    function flushBatchLookup() {
        batchTimer = null;
        if (pendingLookupIds.size === 0) return;

        const batchIds = [];
        for (const id of pendingLookupIds) {
            batchIds.push(id);
            pendingLookupIds.delete(id);
            if (batchIds.length >= MAX_BATCH_SIZE) break;
        }

        // If more remain, schedule next batch immediately
        if (pendingLookupIds.size > 0 && !batchTimer) {
            batchTimer = setTimeout(flushBatchLookup, BATCH_DEBOUNCE_MS);
        }

        sendMessageSafe({
            action: 'GET_VIDEO_STATES',
            payload: { ids: batchIds }
        }).then((res) => {
            if (!res || !res.success || !res.states) return;
            const states = res.states;

            for (const id of batchIds) {
                const state = Object.prototype.hasOwnProperty.call(states, id) ? states[id] : null;
                setCache(id, state);

                const elements = pendingElementsByVideoId.get(id);
                if (elements) {
                    for (const link of elements) {
                        applyOverlayToLink(link, id, state);
                    }
                    pendingElementsByVideoId.delete(id);
                }
            }
        });
    }

    function queueThumbnailCheck(link) {
        if (!link || !link.href) return;
        const videoId = extractVideoIdFromUrl(link.href);
        if (!videoId) {
            clearOverlay(link);
            return;
        }

        if (stateCache.has(videoId)) {
            applyOverlayToLink(link, videoId, stateCache.get(videoId));
            return;
        }

        let set = pendingElementsByVideoId.get(videoId);
        if (!set) {
            set = new Set();
            pendingElementsByVideoId.set(videoId, set);
        }
        set.add(link);
        pendingLookupIds.add(videoId);

        if (!batchTimer) {
            batchTimer = setTimeout(flushBatchLookup, BATCH_DEBOUNCE_MS);
        }
    }

    const intersectionObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    queueThumbnailCheck(entry.target);
                }
            }
        },
        { rootMargin: '300px 0px' }
    );

    const THUMBNAIL_SELECTOR = 'a#thumbnail, a.yt-lockup-view-model__content-image';

    function registerThumbnailLink(link) {
        if (!link || link.tagName !== 'A') return;
        if (!observedLinks.has(link)) {
            observedLinks.add(link);
            intersectionObserver.observe(link);
        } else {
            // Re-check in case YouTube recycled this DOM node with a new href
            const container = getThumbnailContainer(link);
            const taggedVid = container?.getAttribute('data-byh-vid');
            const currentHrefVid = extractVideoIdFromUrl(link.href);
            if (taggedVid && taggedVid !== currentHrefVid) {
                queueThumbnailCheck(link);
            }
        }
    }

    function scanNodeForThumbnails(root) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
        if (root.matches && root.matches(THUMBNAIL_SELECTOR)) {
            registerThumbnailLink(root);
        }
        const links = root.querySelectorAll ? root.querySelectorAll(THUMBNAIL_SELECTOR) : [];
        for (let i = 0; i < links.length; i++) {
            registerThumbnailLink(links[i]);
        }
    }

    // Scoped MutationObserver: inspects only added subtrees + href changes on thumbnail links
    let pendingMutationRoots = new Set();
    let mutationFlushTimer = null;

    function flushMutations() {
        mutationFlushTimer = null;
        if (getCurrentPageVideoId() && !currentVideoElement) {
            initVideoTracking();
        }
        for (const root of pendingMutationRoots) {
            if (root.isConnected) {
                scanNodeForThumbnails(root);
            }
        }
        pendingMutationRoots.clear();
    }

    const mutationObserver = new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
            const m = mutations[i];
            if (m.type === 'attributes' && m.target) {
                if (m.target.matches && m.target.matches(THUMBNAIL_SELECTOR)) {
                    queueThumbnailCheck(m.target);
                }
                continue;
            }
            for (let j = 0; j < m.addedNodes.length; j++) {
                const node = m.addedNodes[j];
                if (node.nodeType === Node.ELEMENT_NODE) {
                    pendingMutationRoots.add(node);
                }
            }
        }

        if (pendingMutationRoots.size > 0 && !mutationFlushTimer) {
            mutationFlushTimer = setTimeout(flushMutations, 250);
        }
    });

    function bootstrap() {
        initVideoTracking();
        if (document.body) {
            scanNodeForThumbnails(document.body);
            mutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['href']
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }
})();
