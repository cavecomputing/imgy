/** Queue that sends images to the configured LLM and applies the suggested filename and tags. */
import { CONFIG } from './config.js';
import { getCurrentLightboxImage, LlmQueue, State } from './state.js';
import { Elements } from './dom.js';
import { formatCount, getImageBaseName, isVideo } from './utils.js';
import { showToast } from './ui.js';
import { api } from './api.js';
import { applyFilters } from './data.js';
import { addTags, applyRenameLocally } from './actions.js';
import { refreshLightboxAfterTagEdit, refreshQuickTagUI } from './flyup.js';
import { getLlmSettings } from './settings.js';

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
            if (State.currentQuickTagImage) {
                refreshQuickTagUI();
            }
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
        return { success: false };
    }
}

export function llmQueueAdd(filename) {
    if (isVideo(filename)) { showToast('LLM auto-tagger does not support video files'); return; }
    if (LlmQueue.items.some(i => i.filename === filename && (i.status === 'queued' || i.status === 'processing'))) return;
    LlmQueue.items.push({ filename, status: 'queued' });
    llmQueueUpdateUI();
    llmQueueSyncLightbox();
    if (!LlmQueue.processing) llmQueueProcess();
}

async function llmQueueProcess() {
    if (LlmQueue.processing) return;
    LlmQueue.processing = true;
    let okCount = 0, errCount = 0;

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

    if (okCount || errCount) {
        const parts = [`LLM analyzed ${formatCount(okCount, 'image')}`];
        if (errCount) parts.push(`${errCount} failed`);
        showToast(parts.join(', '));
    }
}

const _llmCloudSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';

export function llmQueueUpdateUI() {
    for (const item of LlmQueue.items) {
        const card = document.querySelector(`.image-card[data-filename="${CSS.escape(item.filename)}"]`);
        if (!card) continue;
        let overlay = card.querySelector('.llm-card-overlay');
        if (item.status === 'queued' || item.status === 'processing') {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'llm-card-overlay';
                overlay.innerHTML = _llmCloudSvg;
                card.appendChild(overlay);
            }
            overlay.classList.toggle('llm-processing', item.status === 'processing');
            overlay.classList.remove('llm-done', 'llm-error');
        } else if (overlay) {
            overlay.classList.remove('llm-processing');
            overlay.classList.toggle('llm-done', item.status === 'done');
            overlay.classList.toggle('llm-error', item.status === 'error');
        }
    }
}

export function llmQueueSyncLightbox() {
    const btn = Elements.llmAnalyzeBtn;
    if (!btn) return;
    const img = getCurrentLightboxImage();
    if (!img) { btn.classList.remove('loading'); btn.disabled = false; return; }
    const item = LlmQueue.items.find(i => i.filename === img.filename && (i.status === 'queued' || i.status === 'processing'));
    if (item) {
        btn.classList.add('loading');
        btn.disabled = true;
    } else {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
}
