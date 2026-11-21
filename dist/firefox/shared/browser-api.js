/**
 * src/shared/browser-api.js
 * Cross-browser MV3 WebExtension API wrapper (Chrome + Firefox) and sender validation.
 */

export function getExtApi() {
    return typeof globalThis.browser !== 'undefined'
        ? globalThis.browser
        : globalThis.chrome;
}

export const extApi = getExtApi();

/**
 * Verifies that a runtime message originated from this extension itself.
 */
export function isTrustedExtensionSender(sender) {
    const api = getExtApi();
    if (!sender || !api?.runtime?.id) return false;
    return sender.id === api.runtime.id;
}

/**
 * Verifies that a message originated from an extension page (e.g. popup.html),
 * NOT from a content script injected into a web page.
 * Required for privileged operations like CLEAR_HISTORY or DELETE_VIDEO.
 */
export function isExtensionPageSender(sender) {
    if (!isTrustedExtensionSender(sender)) return false;
    if (sender.tab) return false;
    const api = getExtApi();
    const extOrigin = api.runtime.getURL('');
    return typeof sender.url === 'string' && sender.url.startsWith(extOrigin);
}

/**
 * Verifies that a message originated from a YouTube tab's content script.
 */
export function isYouTubeTabSender(sender) {
    if (!isTrustedExtensionSender(sender)) return false;
    if (!sender.tab) return false;
    const senderUrl = sender.url || sender.tab.url;
    if (typeof senderUrl !== 'string') return false;
    try {
        const parsed = new URL(senderUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
        const host = parsed.hostname.toLowerCase();
        return host === 'youtube.com' || host.endsWith('.youtube.com');
    } catch {
        return false;
    }
}

/**
 * Safely calls storage.local.get with Promise support across Chrome and Firefox.
 */
export async function storageLocalGet(keys) {
    if (!extApi?.storage?.local) return {};
    const result = extApi.storage.local.get(keys);
    if (result && typeof result.then === 'function') {
        return await result;
    }
    return await new Promise((resolve, reject) => {
        extApi.storage.local.get(keys, (items) => {
            if (extApi.runtime?.lastError) {
                reject(new Error(extApi.runtime.lastError.message));
            } else {
                resolve(items || {});
            }
        });
    });
}

/**
 * Safely calls storage.local.remove with Promise support across Chrome and Firefox.
 */
export async function storageLocalRemove(keys) {
    if (!extApi?.storage?.local) return;
    const result = extApi.storage.local.remove(keys);
    if (result && typeof result.then === 'function') {
        return await result;
    }
    return await new Promise((resolve, reject) => {
        extApi.storage.local.remove(keys, () => {
            if (extApi.runtime?.lastError) {
                reject(new Error(extApi.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

/**
 * Safely sends a runtime message with Promise support across Chrome and Firefox.
 */
export async function sendRuntimeMessage(message) {
    if (!extApi?.runtime?.sendMessage) {
        throw new Error('Extension runtime unavailable');
    }
    const result = extApi.runtime.sendMessage(message);
    if (result && typeof result.then === 'function') {
        return await result;
    }
    return await new Promise((resolve, reject) => {
        extApi.runtime.sendMessage(message, (response) => {
            if (extApi.runtime?.lastError) {
                reject(new Error(extApi.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}
