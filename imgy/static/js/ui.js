/** Loading indicator, toasts, error banner, and small widget helpers. */
import { CONFIG } from './config.js';
import { LlmQueue } from './state.js';
import { Elements } from './dom.js';

let loadingTimer = null;
let toastTimer = null;
let errorTimer = null;

/**
 * Show or hide a notice. They are manual popovers because an open modal <dialog> and its backdrop
 * sit in the top layer, which paints over any z-index; showing the popover again lifts it above
 * a dialog opened after it.
 */
function setNotice(el, visible) {
    el.classList.toggle('hidden', !visible);
    if (el.matches(':popover-open')) el.hidePopover();
    if (visible) el.showPopover();
}

export function showLoading() {
    if (LlmQueue.processing) return;
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => setNotice(Elements.loadingEl, true), CONFIG.LOADING_DELAY_MS);
}

export function hideLoading() {
    clearTimeout(loadingTimer);
    setNotice(Elements.loadingEl, false);
}

export function showError(msg) {
    Elements.errorEl.textContent = msg;
    setNotice(Elements.errorEl, true);
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => setNotice(Elements.errorEl, false), CONFIG.ERROR_DURATION_MS);
}

export function showToast(msg) {
    Elements.toastEl.textContent = msg;
    setNotice(Elements.toastEl, true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setNotice(Elements.toastEl, false), CONFIG.TOAST_DURATION_MS);
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
