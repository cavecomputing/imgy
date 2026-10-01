/** Client for the JSON API under /api. */
import { showError } from './ui.js';

/**
 * Fetch a JSON endpoint. A non-2xx response throws an Error carrying the server's
 * `{"error": ...}` message, which is also shown in the error banner (aborts stay silent).
 */
async function request(url, options = {}) {
    try {
        const response = await fetch(url, {
            ...options,
            headers: options.body ? { 'Content-Type': 'application/json' } : {}
        });
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `Error ${response.status}`);
        }
        return await response.json();
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        showError(err.message);
        throw err;
    }
}

export const api = {
    get: (url, options) => request(url, options),
    post: (url, body) => request(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
    delete: (url) => request(url, { method: 'DELETE' }),
};
