/** Loading indicator, toasts, error banner, and small widget helpers. */
import { CONFIG } from './config.js';
import { LlmQueue } from './state.js';
import { Elements } from './dom.js';

let loadingTimer = null;
let toastTimer = null;

export function showLoading() {
    if (LlmQueue.processing) return;
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => Elements.loadingEl.classList.remove('hidden'), CONFIG.LOADING_DELAY_MS);
}

export function hideLoading() {
    clearTimeout(loadingTimer);
    Elements.loadingEl.classList.add('hidden');
}

export function showError(msg) {
    Elements.errorEl.textContent = msg;
    Elements.errorEl.classList.remove('hidden');
    setTimeout(() => Elements.errorEl.classList.add('hidden'), CONFIG.ERROR_DURATION_MS);
}

export function showToast(msg) {
    Elements.toastEl.textContent = msg;
    Elements.toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => Elements.toastEl.classList.add('hidden'), CONFIG.TOAST_DURATION_MS);
}

export function setPressed(el, pressed) {
    if (!el) return;
    el.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

/** Mark a toggle on or off. Labeled toggles keep their title; icon-only ones can pass a new one. */
export function setToggleButtonState(el, active, title) {
    if (!el) return;
    el.classList.toggle('active', active);
    setPressed(el, active);
    if (title) {
        el.title = title;
        el.setAttribute('aria-label', title);
    }
}

/** True when the phone layout (filter at the bottom, no hover) is in effect. */
export function isPhoneLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
}

export async function withLoading(work) {
    showLoading();
    try {
        return await work();
    } finally {
        hideLoading();
    }
}

/** Close a <dialog> when its backdrop (the dialog element itself) is clicked. */
export function closeOnBackdropClick(dialog) {
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
    });
}
