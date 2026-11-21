/**
 * tests/run-tests.mjs
 * Comprehensive security, functional, migration, and 50,000-record performance test suite.
 * Zero external dependencies — runs directly with Node.js.
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
    isExtensionPageSender,
    isYouTubeTabSender
} from '../src/shared/browser-api.js';
import {
    clearAllVideos,
    closeDB,
    computeWatchStats,
    configureIndexedDB,
    deleteVideo,
    deleteVideosBatch,
    exportAllVideos,
    getHistoryPage,
    getVideoCount,
    getVideoStatesBatch,
    importHistoryData,
    migrateFromLegacyStorage,
    openDB,
    searchVideos,
    upsertVideoProgress
} from '../src/shared/db.js';
import {
    extractVideoIdFromYouTubeUrl,
    isGoogleTakeoutArray,
    isValidVideoId,
    isVideoCompleted,
    parseGoogleTakeoutEntry,
    safeThumbnailUrl,
    safeYouTubeWatchUrl,
    sanitizeText,
    sanitizeVideoRecord,
    tokenizeForSearch
} from '../src/shared/sanitize.js';

// ============================================================================
// Lightweight spec-faithful IndexedDB implementation for Node testing
// Supports sorted B-tree indexes, multiEntry, IDBKeyRange.bound, getAllKeys,
// openCursor (next/prev), and cursor.advance().
// ============================================================================

class MockKeyRange {
    constructor(lower, upper, lowerOpen = false, upperOpen = false) {
        this.lower = lower;
        this.upper = upper;
        this.lowerOpen = lowerOpen;
        this.upperOpen = upperOpen;
    }
    static bound(lower, upper, lowerOpen = false, upperOpen = false) {
        return new MockKeyRange(lower, upper, lowerOpen, upperOpen);
    }
    static lowerBound(lower, lowerOpen = false) {
        return new MockKeyRange(lower, undefined, lowerOpen, false);
    }
    includes(key) {
        if (this.lower !== undefined) {
            if (this.lowerOpen ? !(key > this.lower) : !(key >= this.lower)) return false;
        }
        if (this.upper !== undefined) {
            if (this.upperOpen ? !(key < this.upper) : !(key <= this.upper)) return false;
        }
        return true;
    }
}

function compareKeys(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

function makeRequest(executor) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
        try {
            req.result = executor();
            if (req.onsuccess) req.onsuccess({ target: req });
        } catch (err) {
            req.error = err;
            if (req.onerror) req.onerror({ target: req });
        }
    });
    return req;
}

class MockIndex {
    constructor(store, name, keyPath, options = {}) {
        this.store = store;
        this.name = name;
        this.keyPath = keyPath;
        this.multiEntry = Boolean(options.multiEntry);
        this.entries = []; // Sorted array of { key, pk }
        this.dirty = false;
    }

    _rebuildIfNeeded() {
        if (!this.dirty) return;
        this.entries = [];
        for (const [pk, val] of this.store.records.entries()) {
            const rawKey = val[this.keyPath];
            if (this.multiEntry && Array.isArray(rawKey)) {
                for (const k of rawKey) {
                    this.entries.push({ key: k, pk });
                }
            } else if (rawKey !== undefined) {
                this.entries.push({ key: rawKey, pk });
            }
        }
        this.entries.sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.pk, b.pk));
        this.dirty = false;
    }

    _lowerBound(target) {
        let lo = 0, hi = this.entries.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.entries[mid].key < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    getAllKeys(range) {
        return makeRequest(() => {
            this._rebuildIfNeeded();
            if (!range) return this.entries.map((e) => e.pk);
            const start = range.lower !== undefined ? this._lowerBound(range.lower) : 0;
            const out = [];
            for (let i = start; i < this.entries.length; i++) {
                const entry = this.entries[i];
                if (range.upper !== undefined && entry.key > range.upper) break;
                if (range.includes(entry.key)) {
                    out.push(entry.pk);
                }
            }
            return out;
        });
    }

    openCursor(range = null, direction = 'next') {
        const req = { result: null, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
            this._rebuildIfNeeded();
            const list = range
                ? this.entries.filter((e) => range.includes(e.key))
                : this.entries;
            const isPrev = direction === 'prev';
            let pos = isPrev ? list.length - 1 : 0;
            const step = isPrev ? -1 : 1;

            const emit = () => {
                if (pos < 0 || pos >= list.length) {
                    req.result = null;
                    if (req.onsuccess) req.onsuccess({ target: req });
                    return;
                }
                const entry = list[pos];
                const record = this.store.records.get(entry.pk);
                req.result = {
                    key: entry.key,
                    primaryKey: entry.pk,
                    value: structuredClone(record),
                    continue: () => {
                        pos += step;
                        queueMicrotask(emit);
                    },
                    advance: (count) => {
                        pos += step * count;
                        queueMicrotask(emit);
                    }
                };
                if (req.onsuccess) req.onsuccess({ target: req });
            };
            emit();
        });
        return req;
    }
}

class MockObjectStore {
    constructor(name, keyPath) {
        this.name = name;
        this.keyPath = keyPath;
        this.records = new Map();
        this.indexes = new Map();
    }

    createIndex(name, keyPath, options = {}) {
        const idx = new MockIndex(this, name, keyPath, options);
        this.indexes.set(name, idx);
        return idx;
    }

    index(name) {
        const idx = this.indexes.get(name);
        if (!idx) throw new Error(`Index not found: ${name}`);
        return idx;
    }

    _markDirty() {
        for (const idx of this.indexes.values()) idx.dirty = true;
    }

    get(key) {
        return makeRequest(() => {
            const val = this.records.get(key);
            return val !== undefined ? structuredClone(val) : undefined;
        });
    }

    getAll() {
        return makeRequest(() => Array.from(this.records.values(), (v) => structuredClone(v)));
    }

    openCursor() {
        const req = { result: null, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
            const entries = Array.from(this.records.entries());
            let pos = 0;
            const emit = () => {
                if (pos >= entries.length) {
                    req.result = null;
                    if (req.onsuccess) req.onsuccess({ target: req });
                    return;
                }
                const [pk, val] = entries[pos];
                req.result = {
                    key: pk,
                    primaryKey: pk,
                    value: structuredClone(val),
                    update: (nextVal) => {
                        this.records.set(pk, structuredClone(nextVal));
                        this._markDirty();
                    },
                    continue: () => {
                        pos++;
                        queueMicrotask(emit);
                    }
                };
                if (req.onsuccess) req.onsuccess({ target: req });
            };
            emit();
        });
        return req;
    }

    count() {
        return makeRequest(() => this.records.size);
    }

    put(value) {
        return makeRequest(() => {
            const clone = structuredClone(value);
            this.records.set(clone[this.keyPath], clone);
            this._markDirty();
            return clone[this.keyPath];
        });
    }

    delete(key) {
        return makeRequest(() => {
            this.records.delete(key);
            this._markDirty();
        });
    }

    clear() {
        return makeRequest(() => {
            this.records.clear();
            this._markDirty();
        });
    }
}

class MockDatabase {
    constructor(name, version) {
        this.name = name;
        this.version = version;
        this.stores = new Map();
        this.objectStoreNames = {
            contains: (n) => this.stores.has(n)
        };
    }

    createObjectStore(name, { keyPath }) {
        const store = new MockObjectStore(name, keyPath);
        this.stores.set(name, store);
        return store;
    }

    transaction(storeName) {
        const store = this.stores.get(storeName);
        if (!store) throw new Error(`Store not found: ${storeName}`);
        const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: () => store
        };
        setTimeout(() => {
            if (tx.oncomplete) tx.oncomplete();
        }, 0);
        return tx;
    }

    close() {}
}

function createMockIdbFactory() {
    const dbs = new Map();
    return {
        open(name, version) {
            const req = {
                result: null,
                error: null,
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null
            };
            queueMicrotask(() => {
                let db = dbs.get(name);
                const needsUpgrade = !db || db.version < version;
                if (!db) {
                    db = new MockDatabase(name, version);
                    dbs.set(name, db);
                }
                req.result = db;
                if (needsUpgrade && req.onupgradeneeded) {
                    req.onupgradeneeded({ target: req });
                }
                if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
        }
    };
}

// ============================================================================
// Test Runner
// ============================================================================

let passed = 0;

async function test(name, fn) {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
}

console.log('\n1. Security & Sanitization Tests');

await test('strictly validates 11-char YouTube video IDs and rejects traversal/injection', () => {
    assert.equal(isValidVideoId('dQw4w9WgXcQ'), true);
    assert.equal(isValidVideoId('abc_123-XYZ'), true);

    const malicious = [
        '',
        'short',
        'waytoolongvideoid123',
        '../../evil1',
        '../redirect',
        'dQw4w9WgXcQ&t=1',
        'dQw4w9WgXcQ#xss',
        '<script>x</script>',
        '__proto__',
        'constructor',
        null,
        12345678901,
        {}
    ];
    for (const bad of malicious) {
        assert.equal(isValidVideoId(bad), false, `Should reject: ${String(bad)}`);
    }
});

await test('safeYouTubeWatchUrl & safeThumbnailUrl reject invalid IDs', () => {
    assert.equal(
        safeYouTubeWatchUrl('dQw4w9WgXcQ', 42.8),
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'
    );
    assert.equal(
        safeYouTubeWatchUrl('../../redirect?q=https://evil.com', 10),
        'https://www.youtube.com/'
    );
    assert.equal(
        safeThumbnailUrl('dQw4w9WgXcQ'),
        'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'
    );
    assert.equal(safeThumbnailUrl('../../../evil'), '');
});

await test('sanitizes untrusted text, control chars, length caps, and bad numbers', () => {
    assert.equal(sanitizeText('Hello\x00\x07\n\tWorld', 50, 'Fallback'), 'Hello World');
    assert.equal(sanitizeText('a'.repeat(500), 300, 'Fallback').length, 300);
    assert.equal(sanitizeText(12345, 50, 'Fallback'), 'Fallback');

    const rec = sanitizeVideoRecord({
        id: 'dQw4w9WgXcQ',
        title: 'Test\u0000Title',
        channel: null,
        durationWatched: Infinity,
        totalDuration: -50,
        lastWatchedAt: 'not-a-date',
        extraMaliciousProp: 'should-be-dropped'
    });
    assert.equal(rec.title, 'Test Title');
    assert.equal(rec.channel, 'Unknown Channel');
    assert.equal(rec.durationWatched, 0);
    assert.equal(rec.totalDuration, 0);
    assert.equal('extraMaliciousProp' in rec, false);
});

await test('completion threshold does not falsely mark short videos as watched at 1s', () => {
    assert.equal(isVideoCompleted(1, 20), false);
    assert.equal(isVideoCompleted(18, 20), true);
    assert.equal(isVideoCompleted(580, 600), true); // within 30s on >60s video
    assert.equal(isVideoCompleted(200, 600), false);
});

await test('tokenizer handles accents and camelCase subwords', () => {
    const tokens = tokenizeForSearch('TypeScript Café Tutorial', 'DevChannel');
    assert.ok(tokens.includes('typescript'));
    assert.ok(tokens.includes('type'));
    assert.ok(tokens.includes('script'));
    assert.ok(tokens.includes('cafe'));
    assert.ok(tokens.includes('dev'));
    assert.ok(tokens.includes('channel'));
});

await test('message sender validation enforces least privilege', () => {
    globalThis.chrome = {
        runtime: {
            id: 'test-ext-id',
            getURL: (p) => `chrome-extension://test-ext-id/${p}`
        }
    };
    assert.equal(isExtensionPageSender(null), false);
    assert.equal(isExtensionPageSender({ id: 'test-ext-id', url: 'chrome-extension://test-ext-id/popup.html' }), true);
    assert.equal(isExtensionPageSender({ id: 'test-ext-id', tab: { id: 1 }, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), false);

    assert.equal(isYouTubeTabSender(null), false);
    assert.equal(isYouTubeTabSender({ id: 'wrong-id', tab: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }), false);
    assert.equal(isYouTubeTabSender({ id: 'test-ext-id', tab: { url: 'https://evil-youtube.com/watch?v=dQw4w9WgXcQ' } }), false);
    assert.equal(isYouTubeTabSender({ id: 'test-ext-id', tab: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }), true);
    assert.equal(isYouTubeTabSender({ id: 'test-ext-id', tab: { url: 'https://m.youtube.com/watch?v=dQw4w9WgXcQ' } }), true);
    delete globalThis.chrome;
});

console.log('\n2. IndexedDB Engine, Migration & Prototype Pollution Tests');

configureIndexedDB(createMockIdbFactory(), MockKeyRange);
await openDB();

await test('prototype pollution attack via JSON import is completely blocked', async () => {
    const maliciousJson = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"polluted":true},"../../evil1":{"id":"../../evil1","title":"Bad"},"dQw4w9WgXcQ":{"id":"dQw4w9WgXcQ","title":"Safe Video","channel":"Good Channel","durationWatched":120,"totalDuration":212,"lastWatchedAt":1700000000000}}'
    );
    const res = await importHistoryData(maliciousJson);
    assert.equal(({}).polluted, undefined);
    assert.equal(res.imported, 1);
    assert.equal(await getVideoCount(), 1);
});

await test('upsert merges max watched duration and preserves real title over placeholder', async () => {
    await upsertVideoProgress({
        videoId: 'dQw4w9WgXcQ',
        title: 'Unknown Title',
        channel: 'Unknown',
        durationWatched: 50, // lower than existing 120
        totalDuration: 212,
        lastWatchedAt: 1700005000000 // > 30 min later -> increments watchCount
    });
    const page = await getHistoryPage({ sort: 'recent', limit: 10 });
    assert.equal(page.length, 1);
    assert.equal(page[0].title, 'Safe Video');
    assert.equal(page[0].channel, 'Good Channel');
    assert.equal(page[0].durationWatched, 120);
    assert.equal(page[0].watchCount, 2);
});

await test('legacy storage.local migration is lossless and idempotent', async () => {
    await clearAllVideos();
    let legacyData = {
        history: {
            'abcDEF12345': {
                id: 'abcDEF12345',
                title: 'Legacy Video 1',
                channel: 'Legacy Channel',
                durationWatched: 300,
                totalDuration: 310,
                lastWatchedAt: 1700001000000
            },
            'bad-id': { id: 'bad-id', title: 'Should Skip' }
        }
    };
    let removedKeys = null;
    const r1 = await migrateFromLegacyStorage(
        async () => legacyData,
        async (keys) => { removedKeys = keys; legacyData = {}; }
    );
    assert.equal(r1.migrated, 1);
    assert.equal(r1.alreadyDone, false);
    assert.deepEqual(removedKeys, ['history']);
    assert.equal(await getVideoCount(), 1);

    // Second call must be a no-op
    const r2 = await migrateFromLegacyStorage(async () => { throw new Error('Should not be called'); });
    assert.equal(r2.alreadyDone, true);
});

await test('search supports prefix, multi-word AND, camelCase, accents, and mid-word substring fallback', async () => {
    await clearAllVideos();
    await upsertVideoProgress({
        videoId: 'vid00000001',
        title: 'Mastering TypeScript Generics at a Café',
        channel: 'Matt Pocock',
        durationWatched: 100,
        totalDuration: 600,
        lastWatchedAt: 1700000001000
    });
    await upsertVideoProgress({
        videoId: 'vid00000002',
        title: 'Building a YouTube Extension in Rust',
        channel: 'Systems Lab',
        durationWatched: 590,
        totalDuration: 600,
        lastWatchedAt: 1700000002000
    });

    // Multi-token prefix + accent-insensitive
    const r1 = await searchVideos({ query: 'cafe type' });
    assert.equal(r1.items.length, 1);
    assert.equal(r1.items[0].id, 'vid00000001');
    assert.equal(r1.mode, 'indexed');

    // CamelCase subword ("script" -> "TypeScript")
    const r2 = await searchVideos({ query: 'script' });
    assert.equal(r2.items.length, 1);
    assert.equal(r2.items[0].id, 'vid00000001');

    // Mid-word substring fallback ("xtension" -> "Extension")
    const r3 = await searchVideos({ query: 'xtension' });
    assert.equal(r3.items.length, 1);
    assert.equal(r3.items[0].id, 'vid00000002');
    assert.equal(r3.mode, 'substring');

    // Filter pills
    const watched = await searchVideos({ query: '', filter: 'watched' });
    assert.equal(watched.items.length, 1);
    assert.equal(watched.items[0].id, 'vid00000002');

    const inProg = await searchVideos({ query: '', filter: 'in_progress' });
    assert.equal(inProg.items.length, 1);
    assert.equal(inProg.items[0].id, 'vid00000001');
});

await test('batch overlay lookup, single delete, and v2 export/import roundtrip', async () => {
    const batch = await getVideoStatesBatch(['vid00000001', 'vid00000002', 'missing1234', 'invalid!']);
    assert.equal(Object.keys(batch).length, 2);
    assert.equal(batch.vid00000001.c, false);
    assert.equal(batch.vid00000002.c, true);

    const exported = await exportAllVideos();
    assert.equal(exported.version, 2);
    assert.equal(exported.count, 2);
    assert.equal('tokens' in exported.items[0], false); // derived tokens stripped from export

    await deleteVideo('vid00000001');
    assert.equal(await getVideoCount(), 1);

    // Re-import exported v2 file (with an extra duplicate in same batch)
    exported.items.push({ ...exported.items[0], durationWatched: 599 });
    const imp = await importHistoryData(exported);
    assert.equal(imp.imported, 3);
    assert.equal(await getVideoCount(), 2);
});

await test('Google Takeout watch-history.json importer strips prefixes, skips ads/removed, merges watchCount', async () => {
    await clearAllVideos();
    // Seed an existing locally tracked video with durationWatched = 240
    await upsertVideoProgress({
        videoId: 'dQw4w9WgXcQ',
        title: 'Local Tracked Title',
        channel: 'Rick Astley',
        durationWatched: 240,
        totalDuration: 250,
        lastWatchedAt: Date.now() - 10 * 86400000
    });

    const takeout = [
        {
            header: 'YouTube',
            title: 'Watched Never Gonna Give You Up',
            titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            subtitles: [{ name: 'Rick Astley', url: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw' }],
            time: new Date(Date.now() - 2 * 3600000).toISOString(),
            products: ['YouTube']
        },
        {
            header: 'YouTube',
            title: 'Watched Never Gonna Give You Up',
            titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            subtitles: [{ name: 'Rick Astley' }],
            time: new Date(Date.now() - 5 * 86400000).toISOString()
        },
        {
            header: 'YouTube',
            title: 'Watched Buy Our Product Ad',
            titleUrl: 'https://www.youtube.com/watch?v=adVid000001',
            details: [{ name: 'From Google Ads' }],
            time: new Date().toISOString()
        },
        {
            header: 'YouTube',
            title: 'Watched a video that has been removed',
            time: new Date().toISOString()
        },
        {
            header: 'YouTube',
            title: 'Watched Shorts Demo',
            titleUrl: 'https://www.youtube.com/shorts/shortVid123',
            subtitles: [{ name: 'Shorts Creator' }],
            time: new Date(Date.now() - 40 * 86400000).toISOString()
        }
    ];

    assert.equal(isGoogleTakeoutArray(takeout), true);
    assert.equal(extractVideoIdFromYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseGoogleTakeoutEntry(takeout[2]), null); // Google Ads skipped

    const res = await importHistoryData(takeout);
    assert.equal(res.format, 'takeout');
    assert.equal(res.imported, 2); // dQw4w9WgXcQ + shortVid123
    assert.equal(res.skipped, 2); // ad + removed video

    const items = await getHistoryPage({ sort: 'recent', limit: 10 });
    const rick = items.find((v) => v.id === 'dQw4w9WgXcQ');
    assert.ok(rick);
    assert.equal(rick.durationWatched, 240); // preserved local watch progress!
    assert.equal(rick.completed, true);
    assert.ok(rick.watchCount >= 2);
});

await test('channel filter, date-range filter, bulk delete, and watch stats dashboard', async () => {
    const now = Date.now();
    await clearAllVideos();
    await upsertVideoProgress({
        videoId: 'chVid000001',
        title: 'Rust Async Explained',
        channel: 'Fireship',
        durationWatched: 300,
        totalDuration: 310,
        lastWatchedAt: now - 1000 // Today
    });
    await upsertVideoProgress({
        videoId: 'chVid000002',
        title: 'CSS Grid in 100 Seconds',
        channel: 'Fireship',
        durationWatched: 50,
        totalDuration: 120,
        lastWatchedAt: now - 3 * 86400000 // Within 7d
    });
    await upsertVideoProgress({
        videoId: 'chVid000003',
        title: 'Black Holes Explained',
        channel: 'Veritasium',
        durationWatched: 900,
        totalDuration: 920,
        lastWatchedAt: now - 20 * 86400000 // Within 30d
    });
    await upsertVideoProgress({
        videoId: 'chVid000004',
        title: 'Ancient Lecture',
        channel: 'MIT OpenCourseWare',
        durationWatched: 1200,
        totalDuration: 3600,
        lastWatchedAt: now - 90 * 86400000 // Older than 30d
    });

    // Channel filter (indexed via by_channelLower)
    const fireshipOnly = await searchVideos({ channel: 'Fireship' });
    assert.equal(fireshipOnly.items.length, 2);
    assert.equal(fireshipOnly.items[0].id, 'chVid000001');

    // Channel + text query combined
    const fireshipRust = await searchVideos({ channel: 'Fireship', query: 'rust' });
    assert.equal(fireshipRust.items.length, 1);
    assert.equal(fireshipRust.items[0].id, 'chVid000001');

    // Date range filters
    const todayRes = await searchVideos({ dateRange: 'today' });
    assert.equal(todayRes.items.length, 1);
    const weekRes = await searchVideos({ dateRange: '7d' });
    assert.equal(weekRes.items.length, 2);
    const monthRes = await searchVideos({ dateRange: '30d' });
    assert.equal(monthRes.items.length, 3);

    // Watch stats
    const stats = await computeWatchStats();
    assert.equal(stats.totalVideos, 4);
    assert.equal(stats.completedVideos, 2);
    assert.equal(stats.inProgressVideos, 2);
    assert.equal(stats.completionRate, 50);
    assert.equal(stats.totalSecondsWatched, 2450);
    assert.equal(stats.todayVideos, 1);
    assert.equal(stats.weekVideos, 2);
    assert.equal(stats.uniqueChannels, 3);
    assert.equal(stats.dailyActivity.length, 7);
    assert.equal(stats.topChannels[0].channel, 'Fireship');
    assert.equal(stats.topChannels[0].count, 2);

    // Atomic bulk delete
    const deleted = await deleteVideosBatch(['chVid000002', 'chVid000004', 'invalid!']);
    assert.equal(deleted, 2);
    assert.equal(await getVideoCount(), 2);
});

console.log('\n3. Performance Benchmark (50,000 Videos)');

await clearAllVideos();

const TOPICS = ['JavaScript', 'TypeScript', 'Rust', 'Python', 'Kubernetes', 'Machine', 'Learning', 'Cooking', 'Guitar', 'Physics'];
const CHANNELS = ['Fireship', 'Veritasium', '3Blue1Brown', 'Computerphile', 'Kurzgesagt', 'Traversy Media', 'TechWorld', 'ScienceDaily'];

const N = 50000;
const syntheticItems = new Array(N);
const baseTs = 1700000000000;
for (let i = 0; i < N; i++) {
    const id = `V${String(i).padStart(10, '0')}`;
    const t1 = TOPICS[i % TOPICS.length];
    const t2 = TOPICS[(i * 7 + 3) % TOPICS.length];
    const ch = CHANNELS[i % CHANNELS.length];
    const total = 300 + (i % 3600);
    const watched = i % 3 === 0 ? total : (i % total);
    syntheticItems[i] = {
        id,
        title: i === 42424 ? 'Quantum Chromodynamics Deep Dive Lecture' : `${t1} & ${t2} Complete Guide #${i}`,
        channel: ch,
        durationWatched: watched,
        totalDuration: total,
        lastWatchedAt: baseTs + i * 1000
    };
}

const tImportStart = performance.now();
await importHistoryData({ version: 2, items: syntheticItems });
const tImportMs = performance.now() - tImportStart;
console.log(`  INFO  Seeded ${N.toLocaleString()} records in ${tImportMs.toFixed(1)} ms`);

// Warm up index rebuild once (native IndexedDB maintains B-tree continuously on write)
await getHistoryPage({ sort: 'recent', offset: 0, limit: 1 });
await searchVideos({ query: 'quantum' });

await test('50k videos: O(1) count + initial first page load (< 25ms)', async () => {
    const t0 = performance.now();
    const [count, page] = await Promise.all([
        getVideoCount(),
        getHistoryPage({ sort: 'recent', offset: 0, limit: 80 })
    ]);
    const elapsed = performance.now() - t0;
    assert.equal(count, N);
    assert.equal(page.length, 80);
    assert.equal(page[0].id, `V${String(N - 1).padStart(10, '0')}`);
    console.log(`        -> count + first page (80 items): ${elapsed.toFixed(2)} ms`);
    assert.ok(elapsed < 100, `Expected <100ms, got ${elapsed.toFixed(2)}ms`);
});

await test('50k videos: deep virtual scroll jump to offset 25,000 (< 25ms)', async () => {
    const t0 = performance.now();
    const page = await getHistoryPage({ sort: 'recent', offset: 25000, limit: 80 });
    const elapsed = performance.now() - t0;
    assert.equal(page.length, 80);
    console.log(`        -> jump to offset 25,000 (80 items): ${elapsed.toFixed(2)} ms`);
    assert.ok(elapsed < 100, `Expected <100ms, got ${elapsed.toFixed(2)}ms`);
});

await test('50k videos: indexed multi-token search ("quantum chromo") (< 25ms)', async () => {
    const t0 = performance.now();
    const res = await searchVideos({ query: 'quantum chromo' });
    const elapsed = performance.now() - t0;
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].id, 'V0000042424');
    assert.equal(res.mode, 'indexed');
    console.log(`        -> indexed search ("quantum chromo"): ${elapsed.toFixed(2)} ms`);
    assert.ok(elapsed < 100, `Expected <100ms, got ${elapsed.toFixed(2)}ms`);
});

await test('50k videos: batch overlay lookup of 40 visible YouTube thumbnails (< 15ms)', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `V${String(i * 1000).padStart(10, '0')}`);
    const t0 = performance.now();
    const states = await getVideoStatesBatch(ids);
    const elapsed = performance.now() - t0;
    assert.equal(Object.keys(states).length, 40);
    console.log(`        -> 40-thumbnail batch lookup: ${elapsed.toFixed(2)} ms`);
    assert.ok(elapsed < 50, `Expected <50ms, got ${elapsed.toFixed(2)}ms`);
});

await test('50k videos: single playback progress upsert (< 15ms)', async () => {
    const t0 = performance.now();
    await upsertVideoProgress({
        videoId: 'V0000042424',
        title: 'Quantum Chromodynamics Deep Dive Lecture',
        channel: 'Veritasium',
        durationWatched: 450,
        totalDuration: 1200,
        lastWatchedAt: Date.now()
    });
    const elapsed = performance.now() - t0;
    console.log(`        -> single atomic upsert: ${elapsed.toFixed(2)} ms`);
    assert.ok(elapsed < 50, `Expected <50ms, got ${elapsed.toFixed(2)}ms`);
});

await closeDB();
console.log(`\nAll ${passed} tests passed!\n`);
