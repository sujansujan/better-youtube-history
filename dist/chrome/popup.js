/**
 * src/popup.js
 * Lightning-fast virtualized popup & full-page history UI backed directly by IndexedDB.
 *
 * Features:
 * - Constant-size DOM node pool recycled via CSS translate3d (60fps scroll at 100k+ videos)
 * - Responsive Full-Page mode (?mode=full) with Bulk Select & Atomic Batch Delete
 * - Multi-entry inverted index search + Click-to-Filter Channel + Date Range (Today / 7d / 30d)
 * - Watch Stats & Top Channels dashboard (7-day activity chart + clickable channel jump)
 * - Google Takeout (watch-history.json) & v1/v2 JSON import with live progress feedback
 * - Zero innerHTML usage, strict URL/ID validation, one-shot thumbnail fallback
 */

import { getExtApi, storageLocalGet, storageLocalRemove } from './shared/browser-api.js';
import {
    clearAllVideos,
    computeWatchStats,
    deleteVideo,
    deleteVideosBatch,
    exportAllVideos,
    getHistoryPage,
    getVideoCount,
    importHistoryData,
    migrateFromLegacyStorage,
    openDB,
    searchVideos
} from './shared/db.js';
import {
    MAX_IMPORT_BYTES,
    safeThumbnailUrl,
    safeYouTubeWatchUrl
} from './shared/sanitize.js';

const ITEM_GAP = 8;
const OVERSCAN = 4;
const PAGE_SIZE = 80;
const MAX_CACHED_PAGES = 25;
const SEARCH_DEBOUNCE_MS = 50;

const FALLBACK_THUMB_URI =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
        '<rect width="320" height="180" fill="#1e1f29"/>' +
        '<polygon points="145,70 145,110 182,90" fill="#525669"/>' +
        '</svg>'
    );

function formatTimeAgo(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return 'Just now';

    const units = [
        ['y', 31536000],
        ['mo', 2592000],
        ['w', 604800],
        ['d', 86400],
        ['h', 3600],
        ['m', 60]
    ];

    for (const [label, secs] of units) {
        const count = Math.floor(seconds / secs);
        if (count >= 1) return `${count}${label} ago`;
    }
    return 'Just now';
}

function formatDuration(seconds) {
    const safe = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = safe % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatHumanWatchTime(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(safe / 3600);
    const mins = Math.floor((safe % 3600) / 60);
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
    }
    if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    if (mins > 0) return `${mins}m`;
    return safe > 0 ? `${safe}s` : '0m';
}

function formatCount(n) {
    return new Intl.NumberFormat().format(n);
}

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const isFullPage = params.get('mode') === 'full';
    if (isFullPage) {
        document.body.classList.add('full-page');
    }

    const itemHeight = isFullPage ? 114 : 96;
    const rowStride = itemHeight + ITEM_GAP;

    // DOM Elements
    const viewport = document.getElementById('history-viewport');
    const virtualSpacer = document.getElementById('virtual-spacer');
    const virtualItemsEl = document.getElementById('virtual-items');
    const emptyState = document.getElementById('empty-state');
    const emptyTitle = document.getElementById('empty-title');
    const emptySubtitle = document.getElementById('empty-subtitle');
    const loadingState = document.getElementById('loading-state');
    const countPill = document.getElementById('history-count');

    const tabHistory = document.getElementById('tab-history');
    const tabStats = document.getElementById('tab-stats');
    const controlsBar = document.getElementById('controls-bar');
    const statsView = document.getElementById('stats-view');

    const selectModeBtn = document.getElementById('select-mode-btn');
    const expandBtn = document.getElementById('expand-btn');
    const clearBtn = document.getElementById('clear-btn');
    const confirmBanner = document.getElementById('confirm-banner');
    const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
    const confirmClearBtn = document.getElementById('confirm-clear-btn');

    const exportBtn = document.getElementById('export-btn');
    const importBtn = document.getElementById('import-btn');
    const importFileInput = document.getElementById('import-file-input');

    const searchInput = document.getElementById('search-input');
    const searchClearBtn = document.getElementById('search-clear-btn');
    const sortSelect = document.getElementById('sort-select');
    const filterPills = Array.from(document.querySelectorAll('.filter-pill'));
    const datePills = Array.from(document.querySelectorAll('.date-pill'));

    const channelChipBar = document.getElementById('channel-chip-bar');
    const channelChipName = document.getElementById('channel-chip-name');
    const channelChipClear = document.getElementById('channel-chip-clear');

    const bulkBar = document.getElementById('bulk-bar');
    const bulkCount = document.getElementById('bulk-count');
    const bulkSelectAllBtn = document.getElementById('bulk-select-all-btn');
    const bulkClearSelBtn = document.getElementById('bulk-clear-sel-btn');
    const bulkDeleteBtn = document.getElementById('bulk-delete-btn');

    const statTotalTime = document.getElementById('stat-total-time');
    const statTodaySub = document.getElementById('stat-today-sub');
    const statTotalVideos = document.getElementById('stat-total-videos');
    const statChannelsSub = document.getElementById('stat-channels-sub');
    const statCompletionRate = document.getElementById('stat-completion-rate');
    const statCompletedSub = document.getElementById('stat-completed-sub');
    const statWeekVideos = document.getElementById('stat-week-videos');
    const statWeekTime = document.getElementById('stat-week-time');
    const activityChart = document.getElementById('activity-chart');
    const topChannelsList = document.getElementById('top-channels-list');

    const toastEl = document.getElementById('toast');
    const template = document.getElementById('history-item-template');

    if (isFullPage) {
        expandBtn.hidden = true;
    }

    // --- UI State ---
    let activeView = 'history'; // 'history' | 'stats'
    let currentSort = 'recent';
    let currentFilter = 'all';
    let currentDateRange = 'all';
    let currentChannel = '';
    let currentQuery = '';
    let queryVersion = 0;

    let selectMode = false;
    const selectedIds = new Set();

    let listMode = 'paged';
    let totalCount = 0;
    let arrayItems = [];

    const pageCache = new Map();
    const inflightPages = new Set();
    const domPool = [];
    let scrollRafId = null;
    let searchDebounceTimer = null;
    let toastTimer = null;

    function showToast(message, isError = false, durationMs = 3000) {
        toastEl.textContent = message;
        toastEl.classList.toggle('toast-error', isError);
        toastEl.hidden = false;
        if (toastTimer) clearTimeout(toastTimer);
        if (durationMs > 0) {
            toastTimer = setTimeout(() => {
                toastEl.hidden = true;
            }, durationMs);
        }
    }

    function updateBulkBarUI() {
        bulkBar.hidden = !selectMode;
        selectModeBtn.classList.toggle('active', selectMode);
        selectModeBtn.setAttribute('aria-pressed', String(selectMode));
        const n = selectedIds.size;
        bulkCount.textContent = `${formatCount(n)} selected`;
        bulkDeleteBtn.disabled = n === 0;
    }

    function setSelectMode(enabled) {
        selectMode = enabled;
        if (!enabled) selectedIds.clear();
        updateBulkBarUI();
        for (const slot of domPool) slot.boundKey = '';
        renderVisibleWindow();
    }

    function setChannelFilter(channelName) {
        currentChannel = channelName ? channelName.trim() : '';
        if (currentChannel) {
            channelChipName.textContent = currentChannel;
            channelChipBar.hidden = false;
        } else {
            channelChipBar.hidden = true;
            channelChipName.textContent = '';
        }
        if (activeView !== 'history') {
            switchView('history');
        }
        refreshData({ resetScroll: true });
    }

    function switchView(view) {
        activeView = view;
        const isHistory = view === 'history';
        tabHistory.classList.toggle('active', isHistory);
        tabHistory.setAttribute('aria-selected', String(isHistory));
        tabStats.classList.toggle('active', !isHistory);
        tabStats.setAttribute('aria-selected', String(!isHistory));

        controlsBar.hidden = !isHistory;
        viewport.hidden = !isHistory;
        statsView.hidden = isHistory;

        if (!isHistory) {
            loadAndRenderStats();
        } else {
            scheduleRender();
        }
    }

    function setCachedPage(pageIdx, items) {
        if (pageCache.has(pageIdx)) {
            pageCache.delete(pageIdx);
        } else if (pageCache.size >= MAX_CACHED_PAGES) {
            const oldest = pageCache.keys().next().value;
            if (oldest !== undefined) pageCache.delete(oldest);
        }
        pageCache.set(pageIdx, items);
    }

    function createPoolRow() {
        const fragment = template.content.cloneNode(true);
        const root = fragment.querySelector('.history-item');
        const refs = {
            checkboxWrap: root.querySelector('.select-checkbox-wrap'),
            checkbox: root.querySelector('.item-checkbox'),
            thumbnailLink: root.querySelector('.thumbnail-link'),
            thumbImg: root.querySelector('.thumb-img'),
            progressFill: root.querySelector('.thumb-progress-fill'),
            durationBadge: root.querySelector('.duration-badge'),
            watchedOverlay: root.querySelector('.watched-overlay'),
            titleLink: root.querySelector('.video-title-link'),
            titleEl: root.querySelector('.video-title'),
            deleteBtn: root.querySelector('.delete-item-btn'),
            channelBtn: root.querySelector('.channel-name'),
            timeAgoEl: root.querySelector('.time-ago'),
            resumeBtn: root.querySelector('.resume-btn'),
            resumeLabel: root.querySelector('.resume-label')
        };

        // One-shot fallback chain: mqdefault -> default -> inline SVG
        refs.thumbImg.addEventListener('error', () => {
            const step = refs.thumbImg.dataset.fallbackStep || '0';
            const vid = refs.thumbImg.dataset.vid;
            if (step === '0' && vid) {
                refs.thumbImg.dataset.fallbackStep = '1';
                refs.thumbImg.src = safeThumbnailUrl(vid, 'default') || FALLBACK_THUMB_URI;
            } else if (step !== '2') {
                refs.thumbImg.dataset.fallbackStep = '2';
                refs.thumbImg.src = FALLBACK_THUMB_URI;
            }
        });

        refs.checkbox.addEventListener('change', () => {
            const vid = refs.checkbox.dataset.vid;
            if (!vid) return;
            if (refs.checkbox.checked) {
                selectedIds.add(vid);
            } else {
                selectedIds.delete(vid);
            }
            root.classList.toggle('is-selected', refs.checkbox.checked);
            updateBulkBarUI();
        });

        refs.channelBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const ch = refs.channelBtn.dataset.channel;
            if (ch && ch !== 'Unknown Channel' && ch !== 'Unknown') {
                setChannelFilter(ch);
            }
        });

        refs.deleteBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const vid = refs.deleteBtn.dataset.vid;
            if (!vid) return;
            await handleDeleteSingle(vid);
        });

        virtualItemsEl.appendChild(root);
        return { root, refs, boundKey: '' };
    }

    function ensurePoolSize(needed) {
        while (domPool.length < needed) {
            domPool.push(createPoolRow());
        }
    }

    function bindRow(slot, item, index) {
        const y = index * rowStride;
        slot.root.hidden = false;
        slot.root.style.transform = `translate3d(0, ${y}px, 0)`;

        const isSelected = selectMode && selectedIds.has(item.id);
        const bindKey = `${item.id}|${item.durationWatched}|${item.lastWatchedAt}|${index}|${selectMode}|${isSelected}`;
        if (slot.boundKey === bindKey) return;
        slot.boundKey = bindKey;

        const { refs } = slot;
        refs.checkboxWrap.hidden = !selectMode;
        refs.checkbox.dataset.vid = item.id;
        refs.checkbox.checked = isSelected;
        slot.root.classList.toggle('is-selected', isSelected);

        const watchStartUrl = safeYouTubeWatchUrl(item.id, 0);
        refs.thumbnailLink.href = watchStartUrl;
        refs.titleLink.href = watchStartUrl;
        refs.deleteBtn.dataset.vid = item.id;

        refs.titleEl.textContent = item.title;
        refs.titleLink.title = item.title;
        refs.channelBtn.textContent = item.channel;
        refs.channelBtn.dataset.channel = item.channel;
        refs.timeAgoEl.textContent = formatTimeAgo(item.lastWatchedAt);

        const watched = item.durationWatched || 0;
        const total = item.totalDuration || 0;

        if (total > 0) {
            refs.durationBadge.textContent = `${formatDuration(watched)} / ${formatDuration(total)}`;
            refs.durationBadge.hidden = false;
        } else if (watched > 0) {
            refs.durationBadge.textContent = formatDuration(watched);
            refs.durationBadge.hidden = false;
        } else {
            // Imported Google Takeout videos have no duration metadata yet
            refs.durationBadge.hidden = true;
        }

        const pct = total > 0
            ? Math.min(100, Math.max(0, (watched / total) * 100))
            : (watched > 0 ? 15 : 0);
        refs.progressFill.style.width = `${pct.toFixed(1)}%`;

        const completed = Boolean(item.completed);
        refs.watchedOverlay.hidden = !completed;

        if (completed) {
            refs.resumeBtn.hidden = false;
            refs.resumeBtn.href = watchStartUrl;
            refs.resumeLabel.textContent = 'Watch again';
        } else if (watched > 0) {
            refs.resumeBtn.hidden = false;
            refs.resumeBtn.href = safeYouTubeWatchUrl(item.id, watched);
            refs.resumeLabel.textContent = `Resume at ${formatDuration(watched)}`;
        } else {
            refs.resumeBtn.hidden = false;
            refs.resumeBtn.href = watchStartUrl;
            refs.resumeLabel.textContent = 'Watch';
        }

        if (refs.thumbImg.dataset.vid !== item.id) {
            refs.thumbImg.dataset.vid = item.id;
            refs.thumbImg.dataset.fallbackStep = '0';
            refs.thumbImg.src = safeThumbnailUrl(item.id, 'mqdefault') || FALLBACK_THUMB_URI;
        }
    }

    function getItemAt(index) {
        if (listMode === 'array') {
            return arrayItems[index] || null;
        }
        const pageIdx = Math.floor(index / PAGE_SIZE);
        const page = pageCache.get(pageIdx);
        if (!page) {
            requestPage(pageIdx);
            return null;
        }
        return page[index % PAGE_SIZE] || null;
    }

    async function requestPage(pageIdx) {
        if (listMode !== 'paged' || inflightPages.has(pageIdx) || pageCache.has(pageIdx)) return;
        const versionAtStart = queryVersion;
        inflightPages.add(pageIdx);
        try {
            const items = await getHistoryPage({
                sort: currentSort,
                filter: currentFilter,
                offset: pageIdx * PAGE_SIZE,
                limit: PAGE_SIZE
            });
            if (versionAtStart !== queryVersion) return;
            setCachedPage(pageIdx, items);
            scheduleRender();
        } catch (err) {
            console.error('Failed to load history page:', err);
        } finally {
            inflightPages.delete(pageIdx);
        }
    }

    function renderVisibleWindow() {
        scrollRafId = null;
        if (activeView !== 'history') return;

        if (totalCount === 0) {
            virtualSpacer.hidden = true;
            emptyState.hidden = false;
            for (const slot of domPool) slot.root.hidden = true;

            if (currentQuery || currentFilter !== 'all' || currentDateRange !== 'all' || currentChannel) {
                emptyTitle.textContent = 'No matching videos';
                emptySubtitle.textContent = 'Try adjusting your search, date range, or channel filter.';
            } else {
                emptyTitle.textContent = 'No history yet';
                emptySubtitle.textContent = 'Watch YouTube videos or import Google Takeout JSON to get started.';
            }
            return;
        }

        emptyState.hidden = true;
        virtualSpacer.hidden = false;

        const totalHeight = Math.max(0, totalCount * rowStride - ITEM_GAP);
        virtualSpacer.style.height = `${totalHeight}px`;

        const scrollTop = viewport.scrollTop;
        const viewportHeight = viewport.clientHeight || (isFullPage ? 700 : 400);

        const startIdx = Math.max(0, Math.floor(scrollTop / rowStride) - OVERSCAN);
        const endIdx = Math.min(
            totalCount - 1,
            Math.ceil((scrollTop + viewportHeight) / rowStride) + OVERSCAN
        );

        const neededSlots = Math.max(0, endIdx - startIdx + 1);
        ensurePoolSize(neededSlots);

        let slotCursor = 0;
        for (let idx = startIdx; idx <= endIdx; idx++) {
            const item = getItemAt(idx);
            const slot = domPool[slotCursor++];
            if (item) {
                bindRow(slot, item, idx);
            } else {
                slot.root.hidden = true;
            }
        }

        for (let i = slotCursor; i < domPool.length; i++) {
            domPool[i].root.hidden = true;
        }
    }

    function scheduleRender() {
        if (scrollRafId === null) {
            scrollRafId = requestAnimationFrame(renderVisibleWindow);
        }
    }

    async function refreshData({ resetScroll = true } = {}) {
        const version = ++queryVersion;
        pageCache.clear();
        inflightPages.clear();

        for (const slot of domPool) slot.boundKey = '';
        if (resetScroll) viewport.scrollTop = 0;

        const isPureBrowse =
            !currentQuery &&
            currentFilter === 'all' &&
            currentDateRange === 'all' &&
            !currentChannel;

        try {
            if (isPureBrowse) {
                const [count, firstPage] = await Promise.all([
                    getVideoCount(),
                    getHistoryPage({ sort: currentSort, filter: 'all', offset: 0, limit: PAGE_SIZE })
                ]);
                if (version !== queryVersion) return;

                listMode = 'paged';
                totalCount = count;
                arrayItems = [];
                setCachedPage(0, firstPage);
                countPill.textContent = formatCount(count);
            } else {
                const res = await searchVideos({
                    query: currentQuery,
                    sort: currentSort,
                    filter: currentFilter,
                    channel: currentChannel,
                    dateRange: currentDateRange,
                    maxResults: 5000
                });
                if (version !== queryVersion) return;

                listMode = 'array';
                arrayItems = res.items;
                totalCount = res.items.length;
                countPill.textContent = res.total > res.items.length
                    ? `${formatCount(res.items.length)}+`
                    : formatCount(res.total);
            }

            loadingState.hidden = true;
            renderVisibleWindow();
        } catch (err) {
            console.error('Failed to load history:', err);
            loadingState.hidden = true;
            virtualSpacer.hidden = true;
            emptyState.hidden = false;
            emptyTitle.textContent = 'Error loading history';
            emptySubtitle.textContent = 'Please try reopening the popup.';
        }
    }

    async function loadAndRenderStats() {
        try {
            const stats = await computeWatchStats();
            statTotalTime.textContent = formatHumanWatchTime(stats.totalSecondsWatched);
            statTodaySub.textContent = `Today: ${formatCount(stats.todayVideos)} (${formatHumanWatchTime(stats.todaySeconds)})`;

            statTotalVideos.textContent = formatCount(stats.totalVideos);
            statChannelsSub.textContent = `${formatCount(stats.uniqueChannels)} channels`;

            statCompletionRate.textContent = `${stats.completionRate}%`;
            statCompletedSub.textContent = `${formatCount(stats.completedVideos)} completed`;

            statWeekVideos.textContent = formatCount(stats.weekVideos);
            statWeekTime.textContent = `${formatHumanWatchTime(stats.weekSeconds)} watched`;

            // Render 7-Day Activity Bar Chart (strictly via createElement)
            activityChart.replaceChildren();
            const maxDayCount = Math.max(1, ...stats.dailyActivity.map((d) => d.count));
            for (const day of stats.dailyActivity) {
                const col = document.createElement('div');
                col.className = 'activity-col';
                col.title = `${day.label}: ${formatCount(day.count)} videos (${formatHumanWatchTime(day.seconds)})`;

                const val = document.createElement('span');
                val.className = 'activity-val';
                val.textContent = day.count > 0 ? String(day.count) : '';

                const barWrap = document.createElement('div');
                barWrap.className = 'activity-bar-wrap';

                const bar = document.createElement('div');
                bar.className = day.count === 0 ? 'activity-bar is-zero' : 'activity-bar';
                const pct = day.count === 0 ? 6 : Math.max(12, Math.round((day.count / maxDayCount) * 100));
                bar.style.height = `${pct}%`;

                barWrap.appendChild(bar);

                const label = document.createElement('span');
                label.className = 'activity-day';
                label.textContent = day.label;

                col.append(val, barWrap, label);
                activityChart.appendChild(col);
            }

            // Render Top Channels (clickable -> filters History to that channel)
            topChannelsList.replaceChildren();
            if (stats.topChannels.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'stats-empty';
                empty.textContent = 'Watch videos to see your top channels here.';
                topChannelsList.appendChild(empty);
                return;
            }

            const maxChCount = Math.max(1, stats.topChannels[0].count);
            for (const ch of stats.topChannels) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'top-channel-row';
                btn.addEventListener('click', () => setChannelFilter(ch.channel));

                const meta = document.createElement('div');
                meta.className = 'top-channel-meta';

                const nameEl = document.createElement('span');
                nameEl.className = 'top-channel-name';
                nameEl.textContent = ch.channel;

                const countsEl = document.createElement('span');
                countsEl.className = 'top-channel-counts';
                const timeSuffix = ch.seconds > 0 ? ` · ${formatHumanWatchTime(ch.seconds)}` : '';
                countsEl.textContent = `${formatCount(ch.count)} video${ch.count === 1 ? '' : 's'}${timeSuffix}`;

                meta.append(nameEl, countsEl);

                const track = document.createElement('div');
                track.className = 'top-channel-track';

                const fill = document.createElement('div');
                fill.className = 'top-channel-fill';
                fill.style.width = `${Math.max(4, Math.round((ch.count / maxChCount) * 100))}%`;

                track.appendChild(fill);
                btn.append(meta, track);
                topChannelsList.appendChild(btn);
            }
        } catch (err) {
            console.error('Failed to compute stats:', err);
            showToast('Could not load statistics', true);
        }
    }

    async function handleDeleteSingle(videoId) {
        try {
            await deleteVideo(videoId);
            selectedIds.delete(videoId);
            updateBulkBarUI();
            if (listMode === 'array') {
                const idx = arrayItems.findIndex((item) => item.id === videoId);
                if (idx !== -1) {
                    arrayItems.splice(idx, 1);
                    totalCount = arrayItems.length;
                    countPill.textContent = formatCount(totalCount);
                    for (const slot of domPool) slot.boundKey = '';
                    renderVisibleWindow();
                }
            } else {
                await refreshData({ resetScroll: false });
            }
            showToast('Removed from history');
        } catch (err) {
            console.error('Failed to delete video:', err);
            showToast('Could not remove video', true);
        }
    }

    // --- Event Listeners ---

    viewport.addEventListener('scroll', scheduleRender, { passive: true });
    window.addEventListener('resize', scheduleRender, { passive: true });

    tabHistory.addEventListener('click', () => switchView('history'));
    tabStats.addEventListener('click', () => switchView('stats'));

    selectModeBtn.addEventListener('click', () => {
        if (activeView !== 'history') switchView('history');
        setSelectMode(!selectMode);
    });

    expandBtn.addEventListener('click', () => {
        const api = getExtApi();
        const url = api?.runtime?.getURL
            ? api.runtime.getURL('popup.html?mode=full')
            : `${window.location.pathname}?mode=full`;
        if (api?.tabs?.create) {
            api.tabs.create({ url });
            window.close();
        } else {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    });

    bulkSelectAllBtn.addEventListener('click', () => {
        if (listMode === 'array') {
            for (const item of arrayItems) selectedIds.add(item.id);
        } else {
            for (const page of pageCache.values()) {
                for (const item of page) selectedIds.add(item.id);
            }
        }
        updateBulkBarUI();
        for (const slot of domPool) slot.boundKey = '';
        renderVisibleWindow();
    });

    bulkClearSelBtn.addEventListener('click', () => {
        selectedIds.clear();
        updateBulkBarUI();
        for (const slot of domPool) slot.boundKey = '';
        renderVisibleWindow();
    });

    bulkDeleteBtn.addEventListener('click', async () => {
        if (selectedIds.size === 0) return;
        const idsToDelete = Array.from(selectedIds);
        try {
            const removed = await deleteVideosBatch(idsToDelete);
            selectedIds.clear();
            setSelectMode(false);
            await refreshData({ resetScroll: false });
            showToast(`Deleted ${formatCount(removed)} video${removed === 1 ? '' : 's'}`);
        } catch (err) {
            console.error('Bulk delete failed:', err);
            showToast('Failed to delete selected videos', true);
        }
    });

    searchInput.addEventListener('input', () => {
        const val = searchInput.value;
        searchClearBtn.hidden = val.length === 0;
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            currentQuery = val.trim();
            refreshData({ resetScroll: true });
        }, SEARCH_DEBOUNCE_MS);
    });

    searchClearBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchClearBtn.hidden = true;
        currentQuery = '';
        searchInput.focus();
        refreshData({ resetScroll: true });
    });

    sortSelect.addEventListener('change', () => {
        currentSort = sortSelect.value;
        refreshData({ resetScroll: true });
    });

    filterPills.forEach((pill) => {
        pill.addEventListener('click', () => {
            const nextFilter = pill.dataset.filter || 'all';
            if (nextFilter === currentFilter) return;
            currentFilter = nextFilter;
            filterPills.forEach((p) => {
                const active = p === pill;
                p.classList.toggle('active', active);
                p.setAttribute('aria-selected', String(active));
            });
            refreshData({ resetScroll: true });
        });
    });

    datePills.forEach((pill) => {
        pill.addEventListener('click', () => {
            const nextRange = pill.dataset.range || 'all';
            if (nextRange === currentDateRange) return;
            currentDateRange = nextRange;
            datePills.forEach((p) => {
                const active = p === pill;
                p.classList.toggle('active', active);
                p.setAttribute('aria-selected', String(active));
            });
            refreshData({ resetScroll: true });
        });
    });

    channelChipClear.addEventListener('click', () => setChannelFilter(''));

    // Clear history inline confirmation
    clearBtn.addEventListener('click', () => {
        if (totalCount === 0 && !currentQuery && currentFilter === 'all' && currentDateRange === 'all' && !currentChannel) {
            showToast('History is already empty');
            return;
        }
        confirmBanner.hidden = !confirmBanner.hidden;
    });

    confirmCancelBtn.addEventListener('click', () => {
        confirmBanner.hidden = true;
    });

    confirmClearBtn.addEventListener('click', async () => {
        confirmBanner.hidden = true;
        try {
            await clearAllVideos();
            currentQuery = '';
            currentChannel = '';
            channelChipBar.hidden = true;
            searchInput.value = '';
            searchClearBtn.hidden = true;
            setSelectMode(false);
            await refreshData({ resetScroll: true });
            if (activeView === 'stats') loadAndRenderStats();
            showToast('Watch history cleared');
        } catch (err) {
            console.error('Failed to clear history:', err);
            showToast('Failed to clear history', true);
        }
    });

    // Export history
    exportBtn.addEventListener('click', async () => {
        try {
            const payload = await exportAllVideos();
            if (payload.count === 0) {
                showToast('Nothing to export');
                return;
            }
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `better-youtube-history-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast(`Exported ${formatCount(payload.count)} videos`);
        } catch (err) {
            console.error('Failed to export history:', err);
            showToast('Export failed', true);
        }
    });

    // Import history (supports v1, v2, and Google Takeout watch-history.json)
    importBtn.addEventListener('click', () => {
        importFileInput.click();
    });

    importFileInput.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        if (file.size > MAX_IMPORT_BYTES) {
            showToast('File too large (150 MB max)', true);
            return;
        }

        try {
            showToast('Reading file...', false, 0);
            const text = await file.text();
            const parsed = JSON.parse(text);

            const { imported, skipped, format } = await importHistoryData(parsed, ({ processed, total }) => {
                showToast(`Importing ${formatCount(processed)} / ${formatCount(total)}...`, false, 0);
            });

            await refreshData({ resetScroll: true });
            if (activeView === 'stats') loadAndRenderStats();

            const sourceLabel = format === 'takeout' ? ' from Google Takeout' : '';
            const msg = skipped > 0
                ? `Imported ${formatCount(imported)} videos${sourceLabel} (${formatCount(skipped)} skipped)`
                : `Imported ${formatCount(imported)} videos${sourceLabel}`;
            showToast(msg, false, 4000);
        } catch (err) {
            console.error('Import failed:', err);
            showToast('Invalid JSON or unsupported history file', true);
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if ((e.key === '/' && document.activeElement !== searchInput) ||
            ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
            e.preventDefault();
            if (activeView !== 'history') switchView('history');
            searchInput.focus();
            searchInput.select();
        } else if (e.key === 'Escape') {
            if (!confirmBanner.hidden) {
                confirmBanner.hidden = true;
            } else if (selectMode) {
                setSelectMode(false);
            } else if (searchInput.value) {
                searchInput.value = '';
                searchClearBtn.hidden = true;
                currentQuery = '';
                refreshData({ resetScroll: true });
            } else if (currentChannel) {
                setChannelFilter('');
            }
        }
    });

    // Bootstrap DB, migrate legacy storage if needed, and render
    (async () => {
        try {
            await openDB();
            await migrateFromLegacyStorage(storageLocalGet, storageLocalRemove);
        } catch (err) {
            console.error('Initialization warning:', err);
        }
        await refreshData({ resetScroll: true });
    })();
});
