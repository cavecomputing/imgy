/** Client for the JSON API under /api. */
import { showError } from './ui.js';

/**
 * Fetch a JSON endpoint. A non-2xx response throws an Error carrying the server's
 * `{"error": ...}` message, which is also shown in the error banner (aborts stay silent).
 */
async function request(url, options = {}, read = response => response.json()) {
    try {
        const response = await fetch(url, {
            ...options,
            headers: typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}
        });
        if (response.status === 401) location.assign('/login'); // signed out, e.g. the password changed
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `Error ${response.status}`);
        }
        return await read(response);
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        showError(err.message);
        throw err;
    }
}

export const api = {
    get: (url, options) => request(url, options),
    /** GET a JSON endpoint as { etag, data }, so a caller can tell an answer it already has. */
    getTagged: (url, options) => request(url, options, async response => ({ etag: response.headers.get('ETag'), data: await response.json() })),
    post: (url, body) => request(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
    put: (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (url) => request(url, { method: 'DELETE' }),
    /** POST a FormData as multipart, for file uploads. */
    postForm: (url, form) => request(url, { method: 'POST', body: form }),
};
