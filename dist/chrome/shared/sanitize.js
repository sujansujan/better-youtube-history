/**
 * src/shared/sanitize.js
 * Strict validation, sanitization, prototype-pollution protection,
 * Google Takeout parsing, and search tokenization.
 */

export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const MAX_TITLE_LENGTH = 300;
export const MAX_CHANNEL_LENGTH = 150;
export const MAX_DURATION_SECONDS = 86400 * 7; // 7 days max
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024; // 150 MB DoS guard (supports large Google Takeout files)
export const MAX_IMPORT_RECORDS = 250000;
export const MAX_TOKENS_PER_VIDEO = 64;
export const MIN_VALID_TIMESTAMP = Date.UTC(2005, 0, 1); // YouTube founded 2005

export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Strictly validates a YouTube 11-character video ID.
 * Prevents URL/path traversal, query injection, and prototype keys ("constructor" is 11 chars).
 */
export function isValidVideoId(id) {
    return typeof id === 'string' && !FORBIDDEN_KEYS.has(id) && YOUTUBE_VIDEO_ID_RE.test(id);
}

/**
 * Extracts and strictly validates a YouTube video ID from a URL string.
 * Supports youtube.com/watch?v=, m.youtube.com, music.youtube.com, /shorts/, and youtu.be/.
 */
export function extractVideoIdFromYouTubeUrl(urlStr) {
    if (typeof urlStr !== 'string' || !urlStr) return null;
    try {
        const parsed = new URL(urlStr);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
        const host = parsed.hostname.toLowerCase();

        if (host === 'youtu.be') {
            const seg = parsed.pathname.slice(1).split('/')[0];
            return isValidVideoId(seg) ? seg : null;
        }

        if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return null;

        if (parsed.pathname === '/watch') {
            const v = parsed.searchParams.get('v');
            return isValidVideoId(v) ? v : null;
        }
        if (parsed.pathname.startsWith('/shorts/')) {
            const seg = parsed.pathname.slice('/shorts/'.length).split('/')[0];
            return isValidVideoId(seg) ? seg : null;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Safely normalizes untrusted text fields (title, channel).
 * Strips ASCII control chars, collapses whitespace, and enforces length caps.
 */
export function sanitizeText(value, maxLength, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const cleaned = value
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return fallback;
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/**
 * Safely normalizes duration values (seconds) to a finite non-negative number.
 */
export function sanitizeDuration(value) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num < 0) return 0;
    const clamped = Math.min(num, MAX_DURATION_SECONDS);
    return Math.round(clamped * 100) / 100;
}

/**
 * Safely normalizes epoch millisecond timestamps.
 */
export function sanitizeTimestamp(value, fallback = Date.now()) {
    const num = typeof value === 'number' ? value : Number(value);
    const maxFuture = Date.now() + 86400000; // allow +1 day clock skew
    if (!Number.isFinite(num) || num < MIN_VALID_TIMESTAMP || num > maxFuture) {
        return fallback;
    }
    return Math.floor(num);
}

/**
 * Safely normalizes watchCount.
 */
export function sanitizeWatchCount(value, fallback = 1) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num < 1) return fallback;
    return Math.min(Math.floor(num), 1000000);
}

/**
 * Consistent video completion rule used by both popup and YouTube overlays.
 * Avoids marking short (<60s) videos as watched after 1 second.
 */
export function isVideoCompleted(durationWatched, totalDuration) {
    if (!totalDuration || totalDuration <= 0) return false;
    const ratio = durationWatched / totalDuration;
    if (ratio >= 0.9) return true;
    if (totalDuration > 60 && (totalDuration - durationWatched) <= 30 && ratio >= 0.5) {
        return true;
    }
    return false;
}

/**
 * Normalizes a string for accent-insensitive, case-insensitive search.
 */
export function normalizeForSearch(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

/**
 * Tokenizes title and channel into deduplicated lowercase search tokens for
 * IndexedDB's multiEntry inverted index (`by_tokens`).
 * Includes camelCase subword splitting (e.g. "TypeScript" -> "typescript", "type", "script").
 */
export function tokenizeForSearch(title, channel) {
    const combined = `${title || ''} ${channel || ''}`;
    if (!combined.trim()) return [];

    const tokenSet = new Set();

    const rawWords = combined.split(/[^\p{L}\p{N}]+/u);
    for (const rawWord of rawWords) {
        if (!rawWord) continue;

        const normFull = normalizeForSearch(rawWord);
        if (normFull) {
            tokenSet.add(normFull);
            if (tokenSet.size >= MAX_TOKENS_PER_VIDEO) break;
        }

        const subParts = rawWord
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .split(' ');
        if (subParts.length > 1) {
            for (const part of subParts) {
                const normPart = normalizeForSearch(part);
                if (normPart && normPart.length >= 2) {
                    tokenSet.add(normPart);
                    if (tokenSet.size >= MAX_TOKENS_PER_VIDEO) break;
                }
            }
        }
        if (tokenSet.size >= MAX_TOKENS_PER_VIDEO) break;
    }

    return Array.from(tokenSet);
}

/**
 * Tokenizes a user search query into unique normalized terms.
 */
export function tokenizeQuery(query) {
    if (typeof query !== 'string') return [];
    const norm = normalizeForSearch(query).trim();
    if (!norm) return [];
    const parts = norm.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return Array.from(new Set(parts)).slice(0, 12);
}

/**
 * Detects whether a parsed JSON array is a Google Takeout YouTube `watch-history.json` file.
 */
export function isGoogleTakeoutArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const sampleSize = Math.min(arr.length, 20);
    for (let i = 0; i < sampleSize; i++) {
        const item = arr[i];
        if (
            item &&
            typeof item === 'object' &&
            typeof item.time === 'string' &&
            (typeof item.titleUrl === 'string' || item.header === 'YouTube' || item.header === 'YouTube Music')
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Parses a single Google Takeout watch-history.json entry into a raw video record.
 * Automatically filters out Google Ads impressions and removed/unavailable entries without valid URLs.
 */
export function parseGoogleTakeoutEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

    // Skip Google Ads entries in Takeout history
    if (Array.isArray(entry.details)) {
        for (const d of entry.details) {
            if (d && typeof d.name === 'string' && /google ads/i.test(d.name)) {
                return null;
            }
        }
    }

    const id = extractVideoIdFromYouTubeUrl(entry.titleUrl);
    if (!id) return null;

    let title = typeof entry.title === 'string' ? entry.title : '';
    // Strip standard Google Takeout prefix ("Watched ...")
    title = title.replace(/^Watched\s+/i, '').trim();
    if (!title || /^https?:\/\//i.test(title)) {
        title = 'Unknown Title';
    }

    let channel = 'Unknown Channel';
    if (Array.isArray(entry.subtitles) && entry.subtitles[0] && typeof entry.subtitles[0].name === 'string') {
        channel = entry.subtitles[0].name;
    }

    const parsedTime = typeof entry.time === 'string' ? Date.parse(entry.time) : NaN;
    const lastWatchedAt = Number.isFinite(parsedTime) ? parsedTime : Date.now();

    return {
        id,
        title,
        channel,
        durationWatched: 0,
        totalDuration: 0,
        lastWatchedAt,
        watchCount: 1
    };
}

/**
 * Validates and builds a clean, whitelisted video record suitable for IndexedDB.
 * Merges intelligently with an optional existing record.
 * Returns null if the video ID is invalid.
 */
export function sanitizeVideoRecord(raw, existing = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const id = raw.id ?? raw.videoId;
    if (!isValidVideoId(id)) return null;

    const rawTitle = sanitizeText(raw.title, MAX_TITLE_LENGTH, '');
    const rawChannel = sanitizeText(raw.channel, MAX_CHANNEL_LENGTH, '');

    const existingTitle = existing ? sanitizeText(existing.title, MAX_TITLE_LENGTH, '') : '';
    const existingChannel = existing ? sanitizeText(existing.channel, MAX_CHANNEL_LENGTH, '') : '';

    const isPlaceholderTitle = (t) => !t || t === 'Unknown Title' || t === 'YouTube';
    const isPlaceholderChannel = (c) => !c || c === 'Unknown' || c === 'Unknown Channel';

    const title = !isPlaceholderTitle(rawTitle)
        ? rawTitle
        : (!isPlaceholderTitle(existingTitle) ? existingTitle : (rawTitle || existingTitle || 'Unknown Title'));

    const channel = !isPlaceholderChannel(rawChannel)
        ? rawChannel
        : (!isPlaceholderChannel(existingChannel) ? existingChannel : (rawChannel || existingChannel || 'Unknown Channel'));

    const incomingWatched = sanitizeDuration(raw.durationWatched);
    const existingWatched = existing ? sanitizeDuration(existing.durationWatched) : 0;
    const durationWatched = Math.max(existingWatched, incomingWatched);

    const incomingTotal = sanitizeDuration(raw.totalDuration);
    const existingTotal = existing ? sanitizeDuration(existing.totalDuration) : 0;
    const totalDuration = incomingTotal > 0 ? incomingTotal : existingTotal;

    const clampedWatched = totalDuration > 0
        ? Math.min(durationWatched, totalDuration)
        : durationWatched;

    const incomingTs = sanitizeTimestamp(raw.lastWatchedAt, Date.now());
    const existingTs = existing ? sanitizeTimestamp(existing.lastWatchedAt, 0) : 0;
    const lastWatchedAt = Math.max(incomingTs, existingTs);

    let watchCount = sanitizeWatchCount(raw.watchCount, 1);
    if (existing) {
        const prevCount = sanitizeWatchCount(existing.watchCount, 1);
        const isNewSession = incomingTs > existingTs && (incomingTs - existingTs) > 30 * 60 * 1000;
        watchCount = Math.max(prevCount + (isNewSession ? 1 : 0), watchCount);
    }

    const completed = isVideoCompleted(clampedWatched, totalDuration);
    const channelLower = normalizeForSearch(channel);
    const tokens = tokenizeForSearch(title, channel);

    return {
        id,
        title,
        channel,
        channelLower,
        durationWatched: clampedWatched,
        totalDuration,
        lastWatchedAt,
        watchCount,
        completed,
        tokens
    };
}

/**
 * Safely constructs a YouTube watch URL from a validated video ID.
 */
export function safeYouTubeWatchUrl(videoId, startSeconds = 0) {
    if (!isValidVideoId(videoId)) return 'https://www.youtube.com/';
    const base = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const sec = Math.floor(sanitizeDuration(startSeconds));
    return sec > 0 ? `${base}&t=${sec}s` : base;
}

/**
 * Safely constructs a YouTube thumbnail URL from a validated video ID.
 * Uses mqdefault (320x180, true 16:9 without black bars, lightweight).
 */
export function safeThumbnailUrl(videoId, quality = 'mqdefault') {
    if (!isValidVideoId(videoId)) return '';
    const allowedQualities = new Set(['default', 'mqdefault', 'hqdefault']);
    const safeQuality = allowedQualities.has(quality) ? quality : 'mqdefault';
    return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${safeQuality}.jpg`;
}
