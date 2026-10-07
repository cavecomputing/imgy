/** Queue that sends images to the configured LLM and applies the suggested filename and tags. */
import { CONFIG } from './config.js';
import { getCurrentLightboxImage, LlmQueue, State } from './state.js';
import { Elements } from './dom.js';
import { formatCount, getImageBaseName, isVideo } from './utils.js';
import { showToast } from './ui.js';
import { api } from './api.js';
import { applyFilters } from './data.js';
import { addTags, applyRenameLocally } from './actions.js';
import { refreshLightboxAfterTagEdit, renderActiveQuickTagPanel } from './flyup.js';
import { getLlmSettings, isLlmConfigured, toggleShortcutsModal } from './settings.js';

export function getLlmActionSummary(settings = getLlmSettings()) {
    const actions = [];
    if (settings.doTags) actions.push('auto-tag');
    if (settings.doRename) actions.push('auto-rename');
    return {
        model: settings.model,
        action: actions.length ? actions.join(' + ') : 'analyze'
    };
}

async function llmProcessOne(img) {
    const settings = getLlmSettings();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.LLM_TIMEOUT_MS);
    try {
        const resp = await fetch(`/api/llm/analyze/${encodeURIComponent(img.filename)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_url: settings.api_url, model: settings.model, api_secret: settings.api_secret }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.error || `Error ${resp.status}`);

        let currentFilename = img.filename;

        if (settings.doTags && result.tags && result.tags.length) {
            // Pass the list as is: joining and re-splitting would break multi-word tags
            await addTags(currentFilename, result.tags.filter(t => t));
            renderActiveQuickTagPanel();
            refreshLightboxAfterTagEdit();
        }

        if (settings.doRename && result.filename) {
            const currentBase = getImageBaseName(currentFilename);
            if (result.filename !== currentBase) {
                const data = await api.post('/api/images/rename', { old_filename: currentFilename, new_name: result.filename });
                // Also renames this file's queue entry, so the card overlay follows it
                applyRenameLocally(currentFilename, data);
            }
        }

        return { success: true };
    } catch (err) {
        clearTimeout(timeout);
        console.error('LLM analyze failed:', err);
        return { success: false, error: err.name === 'AbortError' ? 'the LLM took too long to answer' : err.message };
    }
}

export function llmQueueAdd(filename) {
    if (isVideo(filename)) { showToast('Auto-tagging doesn’t work on videos'); return; }
    // Until a model is set up, the default endpoint would only fail: open its settings instead
    if (!isLlmConfigured()) {
        if (!Elements.shortcutsModal.open) toggleShortcutsModal('llm');
        return;
    }
    if (LlmQueue.items.some(i => i.filename === filename && (i.status === 'queued' || i.status === 'processing'))) return;
    LlmQueue.items.push({ filename, status: 'queued' });
    llmQueueUpdateUI();
    llmQueueSyncLightbox();
    if (!LlmQueue.processing) llmQueueProcess();
}

async function llmQueueProcess() {
    if (LlmQueue.processing) return;
    LlmQueue.processing = true;
    let okCount = 0, errCount = 0, lastError = '';

    while (true) {
        const item = LlmQueue.items.find(i => i.status === 'queued');
        if (!item) break;

        item.status = 'processing';
        llmQueueUpdateUI();
        llmQueueSyncLightbox();

        const img = State.imagesByFilename.get(item.filename);
        if (!img) {
            item.status = 'error';
            errCount++;
            lastError = 'the file is gone';
            llmQueueUpdateUI();
            llmQueueSyncLightbox();
            continue;
        }

        const result = await llmProcessOne(img);
        if (result.success) {
            item.status = 'done';
            okCount++;
        } else {
            item.status = 'error';
            errCount++;
            lastError = result.error;
        }

        llmQueueUpdateUI();
        llmQueueSyncLightbox();

        // Brief delay then remove overlay
        await new Promise(r => setTimeout(r, CONFIG.LLM_QUEUE_DELAY_MS));
        const card = document.querySelector(`.image-card[data-filename="${CSS.escape(item.filename)}"] .llm-card-overlay`);
        if (card) card.remove();
    }

    LlmQueue.processing = false;
    // Clean up completed items
    LlmQueue.items = LlmQueue.items.filter(i => i.status === 'queued' || i.status === 'processing');
    llmQueueSyncLightbox();
    applyFilters();

    if (okCount && !errCount) {
        showToast(`Auto-tagged ${formatCount(okCount, 'file')}`);
    } else if (okCount) {
        showToast(`Auto-tagged ${formatCount(okCount, 'file')}, ${errCount} failed: ${lastError}`);
    } else if (errCount) {
        const fix = lastError === 'the file is gone' ? '' : '. Check Settings › Auto-tagging';
        showToast((errCount > 1 ? `Auto-tag failed on ${formatCount(errCount, 'file')}: ${lastError}` : `Auto-tag failed: ${lastError}`) + fix);
    }
}

const OVERLAY_ICON = '<svg class="i" aria-hidden="true"><use href="#i-eye"/></svg>';

export function llmQueueUpdateUI() {
    for (const item of LlmQueue.items) {
        const card = document.querySelector(`.image-card[data-filename="${CSS.escape(item.filename)}"]`);
        if (!card) continue;
        let overlay = card.querySelector('.llm-card-overlay');
        if (item.status === 'queued' || item.status === 'processing') {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'llm-card-overlay';
                overlay.title = 'Waiting for the vision LLM';
                overlay.innerHTML = OVERLAY_ICON;
                (card.querySelector('.card-media') || card).appendChild(overlay);
            }
            overlay.title = item.status === 'processing' ? 'Auto-tagging' : 'Waiting for the vision LLM';
            overlay.classList.toggle('llm-processing', item.status === 'processing');
            overlay.classList.remove('llm-done', 'llm-error');
        } else if (overlay) {
            overlay.classList.remove('llm-processing');
            overlay.classList.toggle('llm-done', item.status === 'done');
            overlay.classList.toggle('llm-error', item.status === 'error');
        }
    }
}

/** Show the lightbox's auto-tag buttons as busy while the current file is queued. */
export function llmQueueSyncLightbox() {
    const img = getCurrentLightboxImage();
    const busy = !!img && LlmQueue.items.some(i => i.filename === img.filename && (i.status === 'queued' || i.status === 'processing'));
    const unsupported = !!img && isVideo(img.filename);
    for (const btn of [Elements.llmAnalyzeBtn, Elements.lightboxLlmTab]) {
        btn.classList.toggle('loading', busy);
        btn.disabled = busy || unsupported;
    }
}
