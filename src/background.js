/**
 * src/background.js
 * MV3 Background Service Worker (Chrome) / Event Page (Firefox).
 * Routes validated messages to the IndexedDB engine and performs lossless legacy migration.
 */

import {
    extApi,
    isExtensionPageSender,
    isYouTubeTabSender,
    storageLocalGet,
    storageLocalRemove
} from './shared/browser-api.js';
import {
    clearAllVideos,
    deleteVideo,
    getVideoStatesBatch,
    migrateFromLegacyStorage,
    openDB,
    upsertVideoProgress
} from './shared/db.js';
import { isValidVideoId } from './shared/sanitize.js';

let migrationPromise = null;

function ensureInitialized() {
    if (!migrationPromise) {
        migrationPromise = openDB()
            .then(() => migrateFromLegacyStorage(storageLocalGet, storageLocalRemove))
            .catch((err) => {
                console.error('DB initialization error:', err);
                migrationPromise = null;
                throw err;
            });
    }
    return migrationPromise;
}

if (extApi?.runtime?.onInstalled) {
    extApi.runtime.onInstalled.addListener(() => {
        ensureInitialized().catch(() => {});
    });
}

if (extApi?.runtime?.onStartup) {
    extApi.runtime.onStartup.addListener(() => {
        ensureInitialized().catch(() => {});
    });
}

async function handleMessage(message, sender) {
    if (!message || typeof message !== 'object' || typeof message.action !== 'string') {
        return { success: false, error: 'Invalid message' };
    }

    await ensureInitialized();

    switch (message.action) {
        case 'UPDATE_VIDEO_HISTORY': {
            if (!isYouTubeTabSender(sender)) {
                return { success: false, error: 'Unauthorized sender' };
            }
            const payload = message.payload;
            if (!payload || typeof payload !== 'object' || !isValidVideoId(payload.videoId)) {
                return { success: false, error: 'Invalid payload' };
            }
            const saved = await upsertVideoProgress(payload);
            if (!saved) {
                return { success: false, error: 'Failed to save record' };
            }
            return {
                success: true,
                state: {
                    w: saved.durationWatched,
                    d: saved.totalDuration,
                    c: saved.completed
                }
            };
        }

        case 'GET_VIDEO_STATES': {
            if (!isYouTubeTabSender(sender)) {
                return { success: false, error: 'Unauthorized sender' };
            }
            const ids = message.payload?.ids;
            if (!Array.isArray(ids)) {
                return { success: false, error: 'Invalid ids' };
            }
            const states = await getVideoStatesBatch(ids);
            return { success: true, states };
        }

        case 'DELETE_VIDEO': {
            if (!isExtensionPageSender(sender)) {
                return { success: false, error: 'Unauthorized sender' };
            }
            const videoId = message.payload?.videoId;
            if (!isValidVideoId(videoId)) {
                return { success: false, error: 'Invalid videoId' };
            }
            await deleteVideo(videoId);
            return { success: true };
        }

        case 'CLEAR_HISTORY': {
            if (!isExtensionPageSender(sender)) {
                return { success: false, error: 'Unauthorized sender' };
            }
            await clearAllVideos();
            return { success: true };
        }

        default:
            return { success: false, error: 'Unknown action' };
    }
}

if (extApi?.runtime?.onMessage) {
    extApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handleMessage(message, sender)
            .then((response) => sendResponse(response))
            .catch((err) => {
                console.error('Background message error:', err);
                sendResponse({ success: false, error: 'Internal error' });
            });
        return true; // Keep async message channel open in both Chrome & Firefox
    });
}
